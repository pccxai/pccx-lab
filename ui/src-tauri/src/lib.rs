use pccx_ai_copilot::{
    compress_context, generate_uvm_sequence, get_available_extensions,
    list_uvm_strategies as copilot_uvm_strategies, Extension,
};
use pccx_core::hw_model::HardwareModel;
use pccx_core::license::get_license_info as core_license_info;
use pccx_core::live_window::{LiveSample, LiveWindow};
use pccx_core::mmap_reader::MmapTrace;
use pccx_core::pccx_format::{PccxFile, PccxHeader};
use pccx_core::roofline::{
    analyze as analyze_roofline_fn, analyze_hierarchical as analyze_roofline_hier_fn, RooflineBand,
    RooflinePoint,
};
use pccx_core::step_snapshot::{step_to_cycle as step_to_cycle_fn, RegisterSnapshot};
use pccx_core::trace::{NpuEvent, NpuTrace};
use std::fs::File;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ─── Application State ────────────────────────────────────────────────────────

struct AppState {
    /// Flat binary buffer (24-byte struct array) ready for JS TypedArray mapping.
    pub trace_flat_buffer: Mutex<Vec<u8>>,
    /// Cached trace for analytics commands (deserialized from pccx payload).
    pub trace: Mutex<Option<NpuTrace>>,
    /// Second trace slot for FlameGraph Compare-run (Gregg IEEE SW 2018
    /// differential flame-graph contract).  Populated by `load_pccx_alt`
    /// and consumed by `fetch_trace_payload_b`.
    pub trace_b: Mutex<Option<NpuTrace>>,
    /// Memory-mapped trace for large-file viewport streaming. Opened by
    /// `mmap_open_trace`, queried by `mmap_viewport` / `mmap_tile`.
    pub mmap_trace: Mutex<Option<MmapTrace>>,
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Loads a .pccx file, validates its format, and caches the trace and flat buffer.
/// Emits a `trace-loaded` event on success so the UI can re-fetch and refresh.
#[tauri::command]
fn load_pccx(path: &str, state: State<'_, AppState>, app: AppHandle) -> Result<PccxHeader, String> {
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

/// Returns the static Apache-2.0 license string for the status bar.
#[tauri::command]
fn get_license_info() -> String {
    core_license_info().to_string()
}

/// Returns the reusable CLI/core lab-status contract for GUI rendering.
#[tauri::command]
fn lab_status() -> pccx_core::status::LabStatus {
    pccx_core::lab_status()
}

/// Returns the reusable CLI/core theme-token contract for GUI rendering.
#[tauri::command]
fn theme_contract() -> pccx_core::theme::ThemeTokenContract {
    pccx_core::theme_contract()
}

/// Returns the cached flat binary trace payload for ultra-fast JS TypedArray mapping.
#[tauri::command]
async fn fetch_trace_payload(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let buf = state.trace_flat_buffer.lock().unwrap().clone();
    Ok(buf)
}

/// Loads a second `.pccx` file into the `trace_b` slot so the FlameGraph
/// can render a deterministic differential view (Gregg IEEE SW 2018 §III-D).
/// Does not touch the primary trace nor the flat buffer.
#[tauri::command]
fn load_pccx_alt(path: String, state: State<'_, AppState>) -> Result<PccxHeader, String> {
    let mut file = File::open(&path).map_err(|e| format!("Cannot open '{}': {}", path, e))?;
    let pccx = PccxFile::read(&mut file).map_err(|e| e.to_string())?;

    if pccx.header.payload.encoding == "bincode" {
        let trace = NpuTrace::from_payload(&pccx.payload)
            .map_err(|e| format!("Payload decode error: {}", e))?;
        *state.trace_b.lock().unwrap() = Some(trace);
    } else {
        return Err(format!(
            "Unsupported payload encoding '{}' for compare trace",
            pccx.header.payload.encoding
        ));
    }
    Ok(pccx.header)
}

/// Returns the flat 24-byte-struct buffer for the second trace, or an
/// error if `load_pccx_alt` has not been called yet.  The UI turns
/// that error into the `VerificationSuite.tsx:149-155` placeholder
/// empty-state rather than any synthetic fallback.
#[tauri::command]
async fn fetch_trace_payload_b(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let guard = state.trace_b.lock().unwrap();
    match guard.as_ref() {
        Some(trace) => Ok(trace.to_flat_buffer()),
        None => Err("No compare trace loaded — call load_pccx_alt first".into()),
    }
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
        .map(|(core_id, util)| {
            serde_json::json!({
                "core_id": core_id,
                "util_pct": (util * 100.0 * 10.0).round() / 10.0, // 1 decimal
            })
        })
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

/// Emits one `RooflineBand` per memory tier (Cache-Aware / Hierarchical
/// Roofline — Ilic 2014 DOI 10.1109/L-CA.2013.6, Yang 2020
/// arXiv:2009.02449). The UI's Roofline panel renders each band as a
/// dashed ceiling + a trajectory segment so the user sees where the
/// workload dwells across the pccx memory hierarchy.
#[tauri::command]
fn analyze_roofline_hierarchical(state: State<'_, AppState>) -> Result<Vec<RooflineBand>, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard.as_ref().ok_or("No trace loaded")?;
    let hw = HardwareModel::pccx_reference();
    Ok(analyze_roofline_hier_fn(trace, &hw))
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
        threshold: threshold.unwrap_or(0.5),
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
    let trace_opt = trace_guard.as_ref();
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

    Ok(pccx_reports::render_markdown(trace_opt, synth_opt.as_ref()))
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

/// Returns a JSON-encoded `ResourceHeatmap` for the given grid dimensions.
/// Uses a mock `SynthReport` with realistic KV260 ZU5EV utilization figures
/// since no report is persistently cached in AppState.
#[tauri::command]
fn synth_heatmap(rows: u32, cols: u32) -> Result<String, String> {
    use pccx_core::synth_report::{generate_heatmap, SynthReport, TimingSummary, UtilSummary};

    // Mock report: ~60 % LUT, ~80 % DSP, ~55 % FF, ~40 % BRAM.
    // These are representative post-route numbers for the pccx v002 design.
    let report = SynthReport {
        utilisation: UtilSummary {
            top_module: "NPU_Top".into(),
            total_luts: 70_300,
            logic_luts: 62_000,
            ffs: 129_000,
            rams_36: 58,
            rams_18: 0,
            urams: 0,
            dsps: 998,
        },
        timing: TimingSummary {
            wns_ns: 0.12,
            tns_ns: 0.0,
            failing_endpoints: 0,
            total_endpoints: 28_602,
            is_timing_met: true,
            worst_clock: "clk_pl_0".into(),
        },
        device: "xczu5ev-sfvc784-2-e".into(),
    };

    let heatmap = generate_heatmap(&report, rows as usize, cols as usize);
    serde_json::to_string(&heatmap).map_err(|e| e.to_string())
}

/// Parses a Vivado `report_timing_summary -quiet -no_header` text file
/// into a full `TimingReport` — the Round-4 T-2 replacement for the
/// synth_report shim. Powers SynthStatusCard and the Dim-6 signoff
/// panel, exposing per-clock WNS/TNS/period so the UI can render the
/// critical-path row directly without re-parsing in JS.
#[tauri::command]
fn load_timing_report(path: String) -> Result<pccx_core::vivado_timing::TimingReport, String> {
    let txt = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read timing report '{}': {}", path, e))?;
    pccx_core::vivado_timing::parse_timing_report(&txt).map_err(|e| e.to_string())
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

    let met = stdout.contains("All user specified timing constraints are met");
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

// ─── File System Commands (Explorer / Editor) ────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}

/// Recursively reads a directory tree up to `depth` levels.
/// `depth == 0` means this level only (children = None for dirs).
/// Files always have `children = None`. Empty dirs below the depth
/// limit get `children = Some(vec![])`. Entries that fail to read
/// (permissions, broken symlinks) are silently skipped.
fn build_file_tree(root: &std::path::Path, depth: u32) -> Vec<FileNode> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut nodes: Vec<FileNode> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            let children = if is_dir && depth > 0 {
                Some(build_file_tree(&path, depth - 1))
            } else {
                None
            };
            Some(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
            })
        })
        .collect();

    // Directories first, then alphabetical by name within each group.
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    nodes
}

/// Reads a directory tree rooted at `root` up to `depth` levels deep,
/// returning a flat list of `FileNode`s suitable for the Explorer sidebar.
/// If `root` is empty (no project loaded) returns an empty vec.
#[tauri::command]
fn read_file_tree(root: String, depth: u32) -> Result<Vec<FileNode>, String> {
    if root.is_empty() {
        return Ok(Vec::new());
    }
    let path = std::path::Path::new(&root);
    if !path.is_dir() {
        return Err(format!("'{}' is not a directory", root));
    }
    Ok(build_file_tree(path, depth))
}

/// Reads a text file at the given path and returns its contents as a string.
/// Used by the code editor to populate the Monaco buffer.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes `content` to the text file at `path` (Ctrl+S save from the editor).
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

/// Merges one or more JSONL coverage-run files (emitted by the xsim
/// testbench suite) into a unified `MergedCoverage` structure. Bin
/// hits are summed across runs; the largest observed `goal` per bin
/// is retained. Empty `runs` vector returns an empty merge.
#[tauri::command]
fn merge_coverage(runs: Vec<String>) -> Result<pccx_core::coverage::MergedCoverage, String> {
    let paths: Vec<std::path::PathBuf> = runs.iter().map(std::path::PathBuf::from).collect();
    let refs: Vec<&std::path::Path> = paths.iter().map(|p| p.as_path()).collect();
    pccx_core::coverage::merge_jsonl(&refs).map_err(|e| e.to_string())
}

/// Parses an IEEE-1364 `.vcd` file (typically emitted by xsim /
/// Verilator / Icarus) into a flat `WaveformDump`.  The returned
/// JSON carries per-signal metadata plus the full value-change
/// stream; the UI then per-signal binary-searches the events for
/// O(log n) value-at-tick lookups.
#[tauri::command]
fn parse_vcd_file(path: String) -> Result<pccx_core::vcd::WaveformDump, String> {
    pccx_core::vcd::parse_vcd_file(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Writes the currently-cached trace as an IEEE 1364-2005 §18 VCD
/// file.  Returns the absolute path of the generated file so the UI
/// can offer a "Reveal in Finder" action.
#[tauri::command]
fn export_vcd(output_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard
        .as_ref()
        .ok_or("No trace loaded — open a .pccx first")?;
    let path = std::path::Path::new(&output_path);
    pccx_core::vcd_writer::write_vcd(trace, path)
        .map_err(|e| format!("vcd_writer failed: {}", e))?;
    Ok(output_path)
}

/// Writes the currently-cached trace as a Google Trace Event Format
/// JSON file (openable in chrome://tracing or ui.perfetto.dev).
#[tauri::command]
fn export_chrome_trace(output_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard
        .as_ref()
        .ok_or("No trace loaded — open a .pccx first")?;
    let path = std::path::Path::new(&output_path);
    pccx_core::chrome_trace::write_chrome_trace(trace, path)
        .map_err(|e| format!("chrome_trace writer failed: {}", e))?;
    Ok(output_path)
}

/// Reads a Spike `--log-commits` style ISA commit log from the
/// given path and returns one `IsaResult` row per retired
/// instruction.  The UI's ISA-Dashboard table renders each row
/// directly — no literal arrays remain in the tsx.
#[tauri::command]
fn validate_isa_trace(path: String) -> Result<Vec<pccx_core::isa_replay::IsaResult>, String> {
    pccx_core::isa_replay::parse_commit_log_file(std::path::Path::new(&path))
        .map_err(|e| format!("Cannot read ISA commit log '{}': {}", path, e))
}

/// Returns one row per distinct `uca_*` driver-surface call, sourced
/// **exclusively** from the cached `.pccx` event stream via
/// `api_ring::list_from_trace`. Round-3 T-1: the synthetic literal
/// fallback has been removed — when no trace is loaded or the trace
/// carries zero `API_CALL` events we surface an empty Vec and the
/// UI's empty-state branch runs (Yuan OSDI 2014 loud-fallback).
#[tauri::command]
fn list_api_calls(state: State<'_, AppState>) -> Result<Vec<pccx_core::api_ring::ApiCall>, String> {
    let trace_guard = state.trace.lock().unwrap();
    let Some(trace) = trace_guard.as_ref() else {
        // No trace cached — match `VerificationSuite.tsx:449` empty state.
        return Ok(Vec::new());
    };
    Ok(pccx_core::api_ring::list_from_trace(trace))
}

/// Round-4 T-1: reduces the cached trace into a `LiveWindow` ring of
/// `LiveSample`s so the UI panels (BottomPanel/PerfChart/Roofline)
/// can poll real MAC/DMA/stall ratios at 2 Hz instead of inventing
/// them via `Math.random`. Returns an empty `Vec` when no trace is
/// loaded — the UI must render its empty-state placeholder, never a
/// synthetic curve (Yuan OSDI 2014 loud-fallback).
#[tauri::command]
fn fetch_live_window(
    window_cycles: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<LiveSample>, String> {
    let trace_guard = state.trace.lock().unwrap();
    let Some(trace) = trace_guard.as_ref() else {
        return Ok(Vec::new());
    };
    // Default to 256-cycle windows — same as detect_bottlenecks
    // so panels line up with the hotspot scan grid.
    let win = window_cycles.unwrap_or(256);
    Ok(LiveWindow::from_trace(trace, win).snapshot())
}

/// Round-6 T-1: returns the deterministic per-cycle `RegisterSnapshot`
/// for a requested cycle so the Timeline / Waveform / HardwareVisualizer
/// / FlameGraph cursor can surface register + MAC-array state at any
/// integer clock. When no trace is loaded, returns the empty snapshot
/// instead of an error so the UI always has a stable shape to render
/// (Yuan OSDI 2014 loud-fallback convention, same as fetch_live_window).
#[tauri::command]
fn step_to_cycle(cycle: u64, state: State<'_, AppState>) -> Result<RegisterSnapshot, String> {
    let trace_guard = state.trace.lock().unwrap();
    Ok(step_to_cycle_fn(trace_guard.as_ref(), cycle))
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
    let read =
        std::fs::read_dir(work_path).map_err(|e| format!("Cannot list {}: {}", work_root, e))?;
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
        let Ok(inner) = std::fs::read_dir(&tb_dir) else {
            continue;
        };
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
        let (tbs, met, status) = parse_run_verification_stdout(FIXTURE_PASS, "/nonexistent/repo");
        assert_eq!(tbs.len(), 3);
        assert_eq!(tbs[0].name, "tb_GEMM_dsp_packer_sign_recovery");
        assert_eq!(tbs[0].verdict, "PASS");
        assert_eq!(tbs[0].cycles, 1024);
        assert_eq!(met, Some(false), "'not met' footer should be detected");
        assert!(status.contains("not met"));
    }

    #[test]
    fn test_parse_mixed_pass_fail_pass_timing() {
        let (tbs, met, status) = parse_run_verification_stdout(FIXTURE_FAIL, "/nonexistent/repo");
        assert_eq!(tbs.len(), 2);
        assert_eq!(tbs[0].verdict, "FAIL");
        assert_eq!(tbs[0].cycles, 3);
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

/// Builds a report from the currently-cached trace and renders it to
/// the requested format.  `format` must be `"markdown"` or `"html"`.
/// Returns an error when no trace is loaded or the format string is
/// unrecognised.
#[tauri::command]
fn generate_report(format: String, state: State<'_, AppState>) -> Result<String, String> {
    let fmt = match format.to_lowercase().as_str() {
        "markdown" | "md" => pccx_reports::ReportFormat::Markdown,
        "html" => pccx_reports::ReportFormat::Html,
        other => {
            return Err(format!(
                "Unknown report format '{}' — use 'markdown' or 'html'",
                other
            ))
        }
    };

    let trace_guard = state.trace.lock().unwrap();
    let trace = trace_guard
        .as_ref()
        .ok_or_else(|| "No trace loaded — open a .pccx file first".to_string())?;

    let report = pccx_reports::Report::from_trace(trace, None);
    Ok(report.render(fmt))
}

/// Input shape for a single report section delivered over IPC.
/// The `type` tag must match the lowercase variant name.
///
/// Only `Summary` and `Custom` are exposed here because the remaining
/// `Section` variants (`TraceStats`, `Roofline`, `Bottleneck`,
/// `SynthUtil`) derive their content from numeric trace data and are
/// not user-authored. They are constructed automatically by
/// `generate_report` / `Report::from_trace`. Callers who need
/// user-annotated sections (narrative text, custom tables) should
/// supply them as `Summary` or `Custom` items and then combine with a
/// trace-derived report on the application side.
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SectionInput {
    Summary { title: String, body: String },
    Custom { title: String, content: String },
}

impl From<SectionInput> for pccx_reports::Section {
    fn from(si: SectionInput) -> Self {
        match si {
            SectionInput::Summary { title, body } => pccx_reports::Section::Summary { title, body },
            SectionInput::Custom { title, content } => {
                pccx_reports::Section::Custom { title, content }
            }
        }
    }
}

/// Builds a report from caller-supplied sections and renders it to the
/// requested format.  Sections with unsupported types are ignored.
/// `format` must be `"markdown"` or `"html"`.
#[tauri::command]
fn generate_report_custom(
    title: String,
    sections: Vec<SectionInput>,
    format: String,
) -> Result<String, String> {
    let fmt = match format.to_lowercase().as_str() {
        "markdown" | "md" => pccx_reports::ReportFormat::Markdown,
        "html" => pccx_reports::ReportFormat::Html,
        other => {
            return Err(format!(
                "Unknown report format '{}' — use 'markdown' or 'html'",
                other
            ))
        }
    };

    let mut builder = pccx_reports::Report::builder(&title);
    for s in sections {
        builder = builder.section(s.into());
    }
    let report = builder.build();
    Ok(report.render(fmt))
}

// ─── LSP: SV keyword completions (Phase 2 M2.2) ─────────────────────────────

/// Returns the full set of SystemVerilog keyword completions from the
/// in-process `SvKeywordProvider`.  The Monaco editor calls this once
/// on mount to seed its auto-complete dictionary; future slices will
/// add position-aware filtering via tree-sitter.
#[tauri::command]
fn sv_completions() -> Vec<serde_json::Value> {
    use pccx_lsp::sv_provider::SvKeywordProvider;
    use pccx_lsp::CompletionProvider;
    let provider = SvKeywordProvider::new();
    let pos = pccx_lsp::SourcePos {
        line: 0,
        character: 0,
    };
    let completions = provider
        .complete(pccx_lsp::Language::SystemVerilog, "", pos, "")
        .unwrap_or_default();
    completions
        .iter()
        .map(|c| {
            serde_json::json!({
                "label": c.label,
                "detail": c.detail,
                "insertText": c.insert_text,
            })
        })
        .collect()
}

// ─── LSP: position-aware hover / completion / diagnostics (Phase 2 M2.3) ────

/// Returns hover information for a symbol at the given line/character in
/// a SystemVerilog source buffer. The Monaco `HoverProvider` calls this
/// on every cursor hover. Returns `null` when there is nothing to show.
#[tauri::command]
fn lsp_hover(
    uri: String,
    line: u32,
    character: u32,
    source: String,
) -> Result<Option<serde_json::Value>, String> {
    use pccx_lsp::sv_hover::SvHoverProvider;
    use pccx_lsp::HoverProvider;
    let provider = SvHoverProvider::new();
    let pos = pccx_lsp::SourcePos { line, character };
    let result = provider
        .hover(pccx_lsp::Language::SystemVerilog, &uri, pos, &source)
        .map_err(|e| e.to_string())?;
    match result {
        Some(hover) => Ok(Some(serde_json::json!({
            "contents": hover.contents,
            "range": hover.range.map(|r| serde_json::json!({
                "startLineNumber": r.start.line + 1,
                "startColumn": r.start.character + 1,
                "endLineNumber": r.end.line + 1,
                "endColumn": r.end.character + 1,
            })),
        }))),
        None => Ok(None),
    }
}

/// Returns position-aware completions for a SystemVerilog source buffer.
/// Combines `SvKeywordProvider` items with `SvHoverProvider`-derived
/// symbol names from the parsed AST so the dropdown covers both
/// language keywords and user-defined identifiers.
#[tauri::command]
fn lsp_complete(
    uri: String,
    line: u32,
    character: u32,
    source: String,
) -> Result<Vec<serde_json::Value>, String> {
    use pccx_lsp::sv_provider::SvKeywordProvider;
    use pccx_lsp::CompletionProvider;
    let provider = SvKeywordProvider::new();
    let pos = pccx_lsp::SourcePos { line, character };
    let completions = provider
        .complete(pccx_lsp::Language::SystemVerilog, &uri, pos, &source)
        .map_err(|e| e.to_string())?;
    Ok(completions
        .iter()
        .map(|c| {
            serde_json::json!({
                "label": c.label,
                "kind": match c.source {
                    pccx_lsp::CompletionSource::Lsp => 14,   // Keyword
                    pccx_lsp::CompletionSource::AiFast
                    | pccx_lsp::CompletionSource::AiDeep => 15, // Snippet
                    pccx_lsp::CompletionSource::Cache => 6,  // Variable
                },
                "detail": c.detail,
                "insertText": c.insert_text,
                "documentation": c.documentation,
            })
        })
        .collect())
}

/// Returns diagnostics for a SystemVerilog source buffer. Called after
/// file load and after a debounced edit. Monaco renders results via
/// `editor.setModelMarkers`.
#[tauri::command]
fn lsp_diagnostics(uri: String, source: String) -> Result<Vec<serde_json::Value>, String> {
    use pccx_lsp::sv_diagnostics::SvDiagnosticsProvider;
    use pccx_lsp::DiagnosticsProvider;
    let provider = SvDiagnosticsProvider::new();
    let diags = provider
        .diagnostics(pccx_lsp::Language::SystemVerilog, &uri, &source)
        .map_err(|e| e.to_string())?;
    Ok(diags
        .iter()
        .map(|d| {
            // Map LSP severity (1=Error..4=Hint) to Monaco MarkerSeverity
            // (8=Error, 4=Warning, 2=Info, 1=Hint).
            let monaco_severity = match d.severity {
                pccx_lsp::DiagnosticSeverity::Error => 8,
                pccx_lsp::DiagnosticSeverity::Warning => 4,
                pccx_lsp::DiagnosticSeverity::Information => 2,
                pccx_lsp::DiagnosticSeverity::Hint => 1,
            };
            serde_json::json!({
                "startLineNumber": d.range.start.line + 1,
                "startColumn": d.range.start.character + 1,
                "endLineNumber": d.range.end.line + 1,
                "endColumn": d.range.end.character + 1,
                "severity": monaco_severity,
                "message": d.message,
                "source": d.source,
            })
        })
        .collect())
}

#[tauri::command]
fn parse_sv_file(path: String) -> Result<serde_json::Value, String> {
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read '{}': {}", path, e))?;
    let result = pccx_authoring::sv_parser::parse_sv(&source, &path);
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

/// Parses SV source and returns a Mermaid flowchart of all modules
/// with inferred port-name connections.
#[tauri::command]
fn generate_block_diagram(sv_source: String, file_path: String) -> Result<String, String> {
    let result = pccx_authoring::sv_parser::parse_sv(&sv_source, &file_path);
    Ok(pccx_authoring::block_diagram::generate_mermaid(
        &result.modules,
    ))
}

/// Metadata for one extracted FSM, sent back over IPC.
#[derive(serde::Serialize)]
struct FsmDiagramResult {
    name: String,
    mermaid: String,
    states_count: u32,
    transitions_count: u32,
    dead_states: Vec<String>,
}

/// Parses SV source and returns one FsmDiagramResult per extracted FSM.
#[tauri::command]
fn generate_fsm_diagram(
    sv_source: String,
    file_path: String,
) -> Result<Vec<FsmDiagramResult>, String> {
    let result = pccx_authoring::sv_parser::parse_sv(&sv_source, &file_path);
    let diagrams = result
        .fsms
        .iter()
        .map(|fsm| {
            let mermaid = pccx_authoring::fsm_diagram::generate_mermaid_fsm(fsm);
            FsmDiagramResult {
                name: fsm.name.clone(),
                mermaid,
                states_count: fsm.states.len() as u32,
                transitions_count: fsm.transitions.len() as u32,
                dead_states: fsm.dead_states.clone(),
            }
        })
        .collect();
    Ok(diagrams)
}

/// Parses SV source and returns a detailed Mermaid subgraph diagram for
/// the named module. Returns an error if the module is not found.
#[tauri::command]
fn generate_module_detail(sv_source: String, module_name: String) -> Result<String, String> {
    let result = pccx_authoring::sv_parser::parse_sv(&sv_source, "");
    let module = result
        .modules
        .iter()
        .find(|m| m.name == module_name)
        .ok_or_else(|| format!("Module '{}' not found in source", module_name))?;
    Ok(pccx_authoring::block_diagram::generate_module_detail(
        module,
    ))
}

#[tauri::command]
fn generate_sv_docs(path: String) -> Result<String, String> {
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read '{}': {}", path, e))?;
    let result = pccx_authoring::sv_parser::parse_sv(&source, &path);
    Ok(pccx_authoring::sv_parser::generate_module_docs(&result))
}

// ─── Verification Commands ────────────────────────────────────────────────────

/// Return type for `verify_sanitize` — named so the JSON keys are stable.
#[derive(serde::Serialize)]
struct SanitizeResult {
    /// The cleaned source string after the full sanitisation pipeline.
    cleaned: String,
    /// Human-readable list of fixups that were applied (may be empty).
    fixups: Vec<String>,
}

/// Runs the robust-reader sanitisation pipeline on `content`:
/// NUL-byte removal, BOM + CRLF normalisation, and trailing-comma
/// forgiveness. Returns the cleaned string and a list of fixups applied.
/// Safe to call with any UTF-8 string; never fails.
#[tauri::command]
fn verify_sanitize(content: String) -> SanitizeResult {
    let (cleaned, fixups) = pccx_verification::robust_reader::sanitize_full(&content);
    SanitizeResult { cleaned, fixups }
}

/// Runs the golden-diff gate between a `.ref.jsonl` reference profile
/// and a `.pccx` trace file.
///
/// - `expected_path` — path to a JSONL file of `RefProfileRow` objects
///   (one per decode step). Generated by `profile_to_jsonl` or by the
///   PyTorch reference pipeline.
/// - `actual_path` — path to a `.pccx` binary trace produced by the
///   xsim testbench suite.
///
/// Returns a `GoldenDiffReport` carrying per-step metric comparisons,
/// aggregate pass/fail counts, and a one-line summary.
#[tauri::command]
fn verify_golden_diff(
    expected_path: String,
    actual_path: String,
) -> Result<pccx_verification::golden_diff::GoldenDiffReport, String> {
    use pccx_core::pccx_format::PccxFile;
    use pccx_core::trace::NpuTrace;
    use pccx_verification::golden_diff::{diff, parse_reference_jsonl_at_path};
    use std::path::Path;

    // Load and parse the reference profile.
    let reference =
        parse_reference_jsonl_at_path(Path::new(&expected_path)).map_err(|e| e.to_string())?;

    // Load and decode the actual trace from the .pccx file.
    let mut file = std::fs::File::open(&actual_path)
        .map_err(|e| format!("Cannot open '{}': {}", actual_path, e))?;
    let pccx = PccxFile::read(&mut file).map_err(|e| e.to_string())?;
    let trace = NpuTrace::from_payload(&pccx.payload)
        .map_err(|e| format!("Payload decode error: {}", e))?;

    Ok(diff(&trace, &reference))
}

/// Renders a Markdown summary of a `GoldenDiffReport` produced by
/// `verify_golden_diff`. Includes the top-level verdict, metric
/// statistics, and a per-step failures table for any steps that did
/// not pass. Passing the report across IPC a second time (rather than
/// re-running the diff) avoids a redundant file-read round-trip.
#[tauri::command]
fn verify_report(report: pccx_verification::golden_diff::GoldenDiffReport) -> String {
    use pccx_verification::golden_diff::GoldenDiffReport;

    fn render(r: &GoldenDiffReport) -> String {
        let mut out = String::new();
        out.push_str("# golden-diff report\n\n");
        out.push_str(&format!("**{}**\n\n", r.summary));
        out.push_str("## Metric statistics\n\n");
        out.push_str(&format!(
            "| metric | count |\n|---|---:|\n\
             | total comparisons | {} |\n\
             | exact matches     | {} |\n\
             | tolerance passes  | {} |\n\
             | mismatches        | {} |\n\n",
            r.total_metrics, r.exact_matches, r.tolerance_passes, r.metric_mismatches,
        ));
        let failed: Vec<_> = r.steps.iter().filter(|s| !s.is_pass).collect();
        if failed.is_empty() {
            out.push_str("All steps within tolerance.\n");
        } else {
            out.push_str("## Failing steps\n\n");
            out.push_str(
                "| step | metric | observed | expected | tol % | pass |\n\
                          |---:|---|---:|---:|---:|:---:|\n",
            );
            for step in &failed {
                for m in step.metrics.iter().filter(|m| !m.pass) {
                    out.push_str(&format!(
                        "| {} | `{}` | {} | {} | {:.1} | FAIL |\n",
                        step.step, m.name, m.observed, m.expected, m.tolerance_pct,
                    ));
                }
            }
        }
        out.push_str("\n---\n_generated by pccx-verification._\n");
        out
    }

    render(&report)
}

// ─── MMAP Trace Commands (large-file viewport streaming) ─────────────────────

/// Metadata returned by `mmap_open_trace` so the UI knows the trace
/// dimensions without a second round-trip.
#[derive(serde::Serialize)]
struct MmapTraceInfo {
    event_count: usize,
    header: PccxHeader,
}

/// Viewport query response carrying a generation_id so the frontend
/// can discard stale responses during fast scroll/zoom.
#[derive(serde::Serialize)]
struct MmapViewportResponse {
    events: Vec<NpuEvent>,
    generation_id: u32,
}

/// Opens a `.pccx` file via memory-mapping (flatbuf encoding only).
/// Stores the `MmapTrace` handle in AppState for subsequent viewport
/// and tile queries. Returns header metadata and event count.
#[tauri::command]
fn mmap_open_trace(path: &str, state: State<'_, AppState>) -> Result<MmapTraceInfo, String> {
    let mt = MmapTrace::open(path).map_err(|e| format!("Cannot mmap '{}': {}", path, e))?;
    let info = MmapTraceInfo {
        event_count: mt.event_count(),
        header: mt.header().clone(),
    };
    *state.mmap_trace.lock().unwrap() = Some(mt);
    Ok(info)
}

/// Returns events overlapping the `[start_cycle, end_cycle)` window
/// from the memory-mapped trace. The caller-supplied `generation_id`
/// is echoed back so the frontend can discard stale responses when
/// the viewport moves faster than the IPC round-trip.
#[tauri::command]
fn mmap_viewport(
    start_cycle: u64,
    end_cycle: u64,
    generation_id: u32,
    state: State<'_, AppState>,
) -> Result<MmapViewportResponse, String> {
    let guard = state.mmap_trace.lock().unwrap();
    let mt = guard
        .as_ref()
        .ok_or("No mmap trace loaded — call mmap_open_trace first")?;
    let events = mt.viewport(start_cycle, end_cycle);
    Ok(MmapViewportResponse {
        events,
        generation_id,
    })
}

/// Returns the total event count of the memory-mapped trace.
#[tauri::command]
fn mmap_event_count(state: State<'_, AppState>) -> Result<usize, String> {
    let guard = state.mmap_trace.lock().unwrap();
    let mt = guard
        .as_ref()
        .ok_or("No mmap trace loaded — call mmap_open_trace first")?;
    Ok(mt.event_count())
}

/// Returns a raw byte slice from the mmap payload for zero-copy
/// TypedArray transfer. `offset` and `count` are byte positions
/// relative to the payload start.
#[tauri::command]
fn mmap_tile(offset: usize, count: usize, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let guard = state.mmap_trace.lock().unwrap();
    let mt = guard
        .as_ref()
        .ok_or("No mmap trace loaded — call mmap_open_trace first")?;
    let slice = mt
        .tile(offset, count)
        .ok_or("Requested tile range exceeds payload bounds")?;
    Ok(slice.to_vec())
}

// ─── App Entry Point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            trace_flat_buffer: Mutex::new(Vec::new()),
            trace: Mutex::new(None),
            trace_b: Mutex::new(None),
            mmap_trace: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            load_pccx,
            get_extensions,
            get_license_info,
            lab_status,
            theme_contract,
            fetch_trace_payload,
            load_pccx_alt,
            fetch_trace_payload_b,
            get_core_utilisation,
            compress_trace_context,
            generate_uvm_sequence_cmd,
            generate_report,
            generate_report_custom,
            load_synth_report,
            synth_heatmap,
            load_timing_report,
            run_verification,
            list_pccx_traces,
            analyze_roofline,
            analyze_roofline_hierarchical,
            list_uvm_strategies,
            generate_markdown_report,
            detect_bottlenecks,
            merge_coverage,
            parse_vcd_file,
            export_vcd,
            export_chrome_trace,
            validate_isa_trace,
            list_api_calls,
            fetch_live_window,
            step_to_cycle,
            sv_completions,
            lsp_hover,
            lsp_complete,
            lsp_diagnostics,
            parse_sv_file,
            generate_sv_docs,
            generate_block_diagram,
            generate_fsm_diagram,
            generate_module_detail,
            verify_sanitize,
            verify_golden_diff,
            verify_report,
            read_file_tree,
            read_text_file,
            write_text_file,
            mmap_open_trace,
            mmap_viewport,
            mmap_event_count,
            mmap_tile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
