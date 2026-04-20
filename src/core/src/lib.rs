// Module Boundary: core/
// pccx-core: standalone NPU performance simulator and trace analysis engine.
//
// Dependency rules (enforced by this module boundary comment):
//   ✅ No dependency on ui/, uvm_bridge/, or ai_copilot/.
//   ✅ All public APIs must be usable by foreign crates via the items re-exported below.

pub mod pccx_format;
pub mod trace;
pub mod simulator;
pub mod license;
pub mod hw_model;
pub mod cycle_estimator;
pub mod synth_report;
pub mod roofline;
pub mod report;
pub mod bottleneck;

// ─── Convenience re-exports (public API surface) ──────────────────────────────
pub use pccx_format::{PccxFile, PccxHeader, PccxError, ArchConfig, TraceConfig, PayloadConfig, fnv1a_64};
pub use trace::{NpuTrace, NpuEvent, event_type_id};
pub use simulator::{SimConfig, generate_realistic_trace, save_dummy_pccx};
pub use license::{
    get_license_info, is_enterprise_enabled, run_high_speed_simulation,
    validate_token, issue_token, LicenseToken, LicenseTier, LicenseError,
};
pub use hw_model::{HardwareModel, AxiBusConfig, BramConfig, MacArrayConfig};
pub use cycle_estimator::{CycleEstimator, TileOperation};
pub use synth_report::{SynthReport, UtilSummary, TimingSummary, load_from_files};
pub use roofline::{RooflinePoint, analyze as analyze_roofline};
pub use report::render_markdown;
pub use bottleneck::{detect as detect_bottlenecks, BottleneckInterval, BottleneckKind, DetectorConfig};
