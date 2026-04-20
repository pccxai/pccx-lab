use pccx_core::pccx_format::{PccxFile, PccxHeader};
use pccx_core::license::{get_license_info as core_license_info, validate_token, LicenseToken};
use pccx_core::trace::NpuTrace;
use pccx_core::hw_model::HardwareModel;
use pccx_core::roofline::{analyze as analyze_roofline_fn, RooflinePoint};
use pccx_ai_copilot::{
    Extension, compress_context, generate_uvm_sequence,
    get_available_extensions, list_uvm_strategies as copilot_uvm_strategies,
};
use std::fs::File;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ─── Application State ────────────────────────────────────────────────────────

struct AppState {
    /// Flat binary buffer (24-byte struct array) ready for JS TypedArray mapping.
    pub trace_flat_buffer: Mutex<Vec<u8>>,
    /// Validated license token, set after `validate_license` is called.
    pub license_token: Mutex<Option<LicenseToken>>,
    /// Cached trace for analytics commands (deserialized from pccx payload).
    pub trace: Mutex<Option<NpuTrace>>,
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Loads a .pccx file, validates its format, and caches the trace and flat buffer.
/// Emits a `trace-loaded` event on success so the UI can re-fetch and refresh.
#[tauri::command]
fn load_pccx(
    path: &str,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PccxHeader, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open '{}': {}", path, e))?;
    let pccx = PccxFile::read(&mut file).map_err(|e| e.to_string())?;

    if pccx.header.payload.encoding == "bincode" {
        let trace = NpuTrace::from_payload(&pccx.payload)
            .map_err(|e| format!("Payload decode error: {}", e))?;

        // Cache the flat buffer for high-speed IPC
        *state.trace_flat_buffer.lock().unwrap() = trace.to_flat_buffer();
        // Cache the full trace for analytics
        *state.trace.lock().unwrap() = Some(trace);
    }

    // Notify the front-end so visualisers (Timeline, FlameGraph, …) can reload.
    let _ = app.emit("trace-loaded", &pccx.header);

    Ok(pccx.header)
}

/// Returns the list of available extensions from ai_copilot.
#[tauri::command]
fn get_extensions() -> Vec<Extension> {
    get_available_extensions()
}

/// Returns the compiled-in license tier string.
#[tauri::command]
fn get_license_info() -> String {
    core_license_info().to_string()
}

/// Validates a license token string and caches the result in app state.
/// Returns `{ tier, licensee, expires_at }` on success.
#[tauri::command]
fn validate_license(token: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    match validate_token(&token) {
        Ok(lt) => {
            let resp = serde_json::json!({
                "licensee":   lt.licensee,
                "tier":       lt.tier.to_string(),
                "expires_at": lt.expires_at,
            });
            *state.license_token.lock().unwrap() = Some(lt);
            Ok(resp)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Returns the cached flat binary trace payload for ultra-fast JS TypedArray mapping.
#[tauri::command]
async fn fetch_trace_payload(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let buf = state.trace_flat_buffer.lock().unwrap().clone();
    Ok(buf)
}

/// Returns per-core utilisation percentages as a JSON array of {core_id, util} objects.
#[tauri::command]
fn get_core_utilisation(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard.as_ref().ok_or("No trace loaded")?;
    let utils = trace.core_utilisation();
    let hw = HardwareModel::pccx_reference();
    let total_us = hw.cycles_to_us(trace.total_cycles);

    let arr: Vec<serde_json::Value> = utils
        .into_iter()
        .map(|(core_id, util)| serde_json::json!({
            "core_id": core_id,
            "util_pct": (util * 100.0 * 10.0).round() / 10.0, // 1 decimal
        }))
        .collect();

    Ok(serde_json::json!({
        "total_cycles":    trace.total_cycles,
        "total_us":        (total_us * 100.0).round() / 100.0,
        "peak_tops":       (hw.peak_tops() * 100.0).round() / 100.0,
        "core_utils":      arr,
    }))
}

/// Compresses the loaded trace into an LLM-friendly context string.
#[tauri::command]
fn compress_trace_context(state: State<'_, AppState>) -> Result<String, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard.as_ref().ok_or("No trace loaded")?;

    let bottleneck_count = trace.dma_bottleneck_intervals(0.5).len();
    Ok(compress_context(trace.total_cycles, bottleneck_count))
}

/// Simulates PDF report generation (long-running async task placeholder).
/// Generates a SystemVerilog UVM sequence stub for a given optimisation strategy.
/// Supported strategies: "l2_prefetch", "barrier_reduction"
#[tauri::command]
fn generate_uvm_sequence_cmd(strategy: String) -> String {
    generate_uvm_sequence(&strategy)
}

/// Runs the roofline analysis on the currently-cached trace and returns the
/// structured breakdown (arithmetic intensity, achieved GOPS, compute/memory
/// bound classification) for the Roofline panel to render against.
#[tauri::command]
fn analyze_roofline(state: State<'_, AppState>) -> Result<RooflinePoint, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard.as_ref().ok_or("No trace loaded")?;
    let hw = HardwareModel::pccx_reference();
    Ok(analyze_roofline_fn(trace, &hw))
}

/// Scans the currently-cached trace for per-class bottleneck windows and
/// returns each contended interval. Configurable window size + share
/// threshold let the UI tune sensitivity; the defaults match the roofline
/// analysis expectations (256-cycle windows, ≥ 50 % share).
#[tauri::command]
fn detect_bottlenecks(
    window_cycles: Option<u64>,
    threshold: Option<f64>,
    state: State<'_, AppState>,
) -> Result<Vec<pccx_core::bottleneck::BottleneckInterval>, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard.as_ref().ok_or("No trace loaded")?;
    let cfg = pccx_core::bottleneck::DetectorConfig {
        window_cycles: window_cycles.unwrap_or(256),
        threshold:     threshold.unwrap_or(0.5),
    };
    Ok(pccx_core::bottleneck::detect(trace, &cfg))
}

/// Renders a Markdown report that summarises the currently-cached trace
/// (with the roofline point computed on the fly) and — when paths are
/// provided — the Vivado synth utilisation + timing state.
///
/// Each section is optional: pass empty strings to omit the synth
/// section, and the command will only fail if both trace and paths are
/// absent simultaneously.
#[tauri::command]
fn generate_markdown_report(
    utilization_path: String,
    timing_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace_opt   = trace_guard.as_ref();
    let synth_opt = if !utilization_path.is_empty() && !timing_path.is_empty() {
        match pccx_core::synth_report::load_from_files(&utilization_path, &timing_path) {
            Ok(r) => Some(r),
            Err(_) => None,
        }
    } else {
        None
    };

    if trace_opt.is_none() && synth_opt.is_none() {
        return Err("Need at least a loaded trace or a synth-report path pair".into());
    }

    Ok(pccx_core::render_markdown(trace_opt, synth_opt.as_ref()))
}

/// Enumerates every UVM strategy the ai_copilot's sequence generator accepts.
/// The UI uses this to populate a dropdown so users never type invalid names.
#[tauri::command]
fn list_uvm_strategies() -> Vec<String> {
    copilot_uvm_strategies()
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

/// Parses Vivado `report_utilization` and `report_timing_summary` text outputs
/// and returns a combined SynthReport JSON. Used by the hardware dashboard
/// to surface resource counts and critical-path slack at a glance.
#[tauri::command]
fn load_synth_report(
    utilization_path: String,
    timing_path: String,
) -> Result<pccx_core::synth_report::SynthReport, String> {
    pccx_core::synth_report::load_from_files(&utilization_path, &timing_path)
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct TbResult {
    name: String,
    verdict: String,
    cycles: u64,
    pccx_path: Option<String>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
struct VerificationSummary {
    testbenches: Vec<TbResult>,
    synth_timing_met: Option<bool>,
    synth_status: String,
    stdout: String,
}

/// Pure-function extraction of the stdout parser used by `run_verification`.
/// Exposed for unit tests; the command wraps this plus the spawn machinery.
fn parse_run_verification_stdout(
    stdout: &str,
    repo_path: &str,
) -> (Vec<TbResult>, Option<bool>, String) {
    let mut testbenches = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("tb_") {
            continue;
        }
        let (name, rest) = match trimmed.split_once(char::is_whitespace) {
            Some(pair) => pair,
            None => continue,
        };
        let rest = rest.trim();
        let (verdict, rest) = if let Some(r) = rest.strip_prefix("PASS:") {
            ("PASS", r)
        } else if let Some(r) = rest.strip_prefix("FAIL:") {
            ("FAIL", r)
        } else {
            continue;
        };
        let cycles = rest
            .trim()
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let candidate = format!("{}/hw/sim/work/{}/{}.pccx", repo_path, name, name);
        let pccx_path = if std::path::Path::new(&candidate).is_file() {
            Some(candidate)
        } else {
            None
        };
        testbenches.push(TbResult {
            name: name.to_string(),
            verdict: verdict.to_string(),
            cycles,
            pccx_path,
        });
    }

    let met     = stdout.contains("All user specified timing constraints are met");
    let not_met = stdout.contains("Timing constraints are not met");
    let synth_timing_met = if met {
        Some(true)
    } else if not_met {
        Some(false)
    } else {
        None
    };
    let synth_status = if not_met {
        "Timing constraints are not met.".into()
    } else if met {
        "All user specified timing constraints are met.".into()
    } else {
        String::new()
    };

    (testbenches, synth_timing_met, synth_status)
}

/// Spawns the `hw/sim/run_verification.sh` script inside the provided
/// pccx-FPGA checkout, parses the canonical `PASS`/`FAIL` lines plus the
/// synth status footer, and returns a structured summary.
#[tauri::command]
async fn run_verification(repo_path: String) -> Result<VerificationSummary, String> {
    let script = format!("{}/hw/sim/run_verification.sh", repo_path);
    let repo_path_arg = repo_path.clone();

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("bash").arg(&script).output()
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| format!("spawn error: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() && stderr.trim().len() > 0 {
        return Err(format!(
            "run_verification.sh failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let (testbenches, synth_timing_met, synth_status) =
        parse_run_verification_stdout(&stdout, &repo_path_arg);

    Ok(VerificationSummary {
        testbenches,
        synth_timing_met,
        synth_status,
        stdout,
    })
}

#[derive(serde::Serialize)]
struct TraceEntry {
    name: String,
    path: String,
    size_bytes: u64,
}

/// Lists every `.pccx` file under the sibling pccx-FPGA repo's
/// `hw/sim/work/<tb>/` tree so the UI can present a dropdown of
/// available traces without hard-coding paths.
#[tauri::command]
fn list_pccx_traces(repo_path: String) -> Result<Vec<TraceEntry>, String> {
    let work_root = format!("{}/hw/sim/work", repo_path);
    let work_path = std::path::Path::new(&work_root);
    if !work_path.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read = std::fs::read_dir(work_path)
        .map_err(|e| format!("Cannot list {}: {}", work_root, e))?;
    for dir in read.flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            // Legacy traces may sit directly under work/ — include them too.
            if let Some(ext) = dir.path().extension() {
                if ext == "pccx" {
                    if let Ok(meta) = dir.metadata() {
                        entries.push(TraceEntry {
                            name: dir
                                .path()
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("(unknown)")
                                .to_string(),
                            path: dir.path().to_string_lossy().to_string(),
                            size_bytes: meta.len(),
                        });
                    }
                }
            }
            continue;
        }
        let tb_dir = dir.path();
        let Ok(inner) = std::fs::read_dir(&tb_dir) else { continue };
        for file in inner.flatten() {
            let p = file.path();
            if p.extension().and_then(|s| s.to_str()) == Some("pccx") {
                if let Ok(meta) = file.metadata() {
                    entries.push(TraceEntry {
                        name: p
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("(unknown)")
                            .to_string(),
                        path: p.to_string_lossy().to_string(),
                        size_bytes: meta.len(),
                    });
                }
            }
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    const FIXTURE_PASS: &str = r#"
==> Running pccx-FPGA testbench suite

TESTBENCH                                           RESULT
---------                                           ------
tb_GEMM_dsp_packer_sign_recovery                    PASS: 1024 cycles, both channels match golden.
tb_mat_result_normalizer                            PASS: 256 cycles, both channels match golden.
tb_GEMM_weight_dispatcher                           PASS: 128 cycles, both channels match golden.

==> Synthesis status (from existing hw/build/reports):
Timing constraints are not met.
"#;

    const FIXTURE_FAIL: &str = r#"
tb_FROM_mat_result_packer                           FAIL: 3 mismatches over 4 cycles.
tb_GEMM_dsp_packer_sign_recovery                    PASS: 1024 cycles, both channels match golden.

All user specified timing constraints are met.
"#;

    #[test]
    fn test_parse_three_passes_plus_fail_timing() {
        let (tbs, met, status) =
            parse_run_verification_stdout(FIXTURE_PASS, "/nonexistent/repo");
        assert_eq!(tbs.len(), 3);
        assert_eq!(tbs[0].name,   "tb_GEMM_dsp_packer_sign_recovery");
        assert_eq!(tbs[0].verdict, "PASS");
        assert_eq!(tbs[0].cycles,  1024);
        assert_eq!(met, Some(false), "'not met' footer should be detected");
        assert!(status.contains("not met"));
    }

    #[test]
    fn test_parse_mixed_pass_fail_pass_timing() {
        let (tbs, met, status) =
            parse_run_verification_stdout(FIXTURE_FAIL, "/nonexistent/repo");
        assert_eq!(tbs.len(), 2);
        assert_eq!(tbs[0].verdict, "FAIL");
        assert_eq!(tbs[0].cycles,  3);
        assert_eq!(tbs[1].verdict, "PASS");
        assert_eq!(met, Some(true));
        assert!(status.contains("are met"));
    }

    #[test]
    fn test_parse_ignores_non_tb_lines() {
        let junk = "random noise\n==> heading\ntb_fake PASS: wrong format\n";
        let (tbs, met, _) = parse_run_verification_stdout(junk, "/repo");
        // "PASS:" without a colon suffix number still classifies but cycles=0.
        assert_eq!(tbs.len(), 1);
        assert_eq!(tbs[0].cycles, 0);
        assert_eq!(met, None);
    }

    #[test]
    fn test_pccx_path_missing_when_file_absent() {
        let (tbs, _, _) = parse_run_verification_stdout(
            "tb_foo PASS: 10 cycles.\n",
            "/absolutely/not/a/real/path",
        );
        assert_eq!(tbs[0].pccx_path, None);
    }
}

#[tauri::command]
async fn generate_report(state: State<'_, AppState>) -> Result<String, String> {
    // MutexGuard must not be held across an await point (not Send).
    // Block scope ensures the guard is dropped before the sleep.
    let has_trace = {
        state.trace.lock().unwrap().is_some()
    };

    // Simulate long-running PDF generation
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    if has_trace {
        Ok("Enterprise report generated and saved to output.pdf".to_string())
    } else {
        Ok("Report generated (no trace loaded — showing template data)".to_string())
    }
}

// ─── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            trace_flat_buffer: Mutex::new(Vec::new()),
            license_token: Mutex::new(None),
            trace: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            load_pccx,
            get_extensions,
            get_license_info,
            validate_license,
            fetch_trace_payload,
            get_core_utilisation,
            compress_trace_context,
            generate_uvm_sequence_cmd,
            generate_report,
            load_synth_report,
            run_verification,
            list_pccx_traces,
            analyze_roofline,
            list_uvm_strategies,
            generate_markdown_report,
            detect_bottlenecks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
