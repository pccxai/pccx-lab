use pccx_core::pccx_format::{PccxFile, PccxHeader};
use pccx_core::license::{get_license_info as core_license_info, validate_token, LicenseToken};
use pccx_core::trace::NpuTrace;
use pccx_core::hw_model::HardwareModel;
use pccx_ai_copilot::{Extension, get_available_extensions, compress_context, generate_uvm_sequence};
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
