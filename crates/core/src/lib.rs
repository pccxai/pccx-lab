// Module Boundary: core/
// pccx-core: standalone NPU performance simulator and trace analysis engine.
//
// Dependency rules (enforced by this module boundary comment):
//   No dependency on ui/, uvm_bridge/, or ai_copilot/.
//   All public APIs must be usable by foreign crates via the items re-exported below.

pub mod api_ring;
pub mod bottleneck;
pub mod chrome_trace;
pub mod coverage;
pub mod cycle_estimator;
pub mod hw_model;
pub mod isa_replay;
pub mod license;
pub mod live_window;
pub mod mmap_reader;
pub mod pccx_format;
pub mod plugin;
pub mod roofline;
pub mod simulator;
pub mod status;
pub mod step_snapshot;
pub mod synth_report;
pub mod theme;
pub mod trace;
pub mod typed;
pub mod vcd;
pub mod vcd_writer;
pub mod vivado_timing;

// ─── Convenience re-exports (public API surface) ──────────────────────────────
pub use bottleneck::{
    detect as detect_bottlenecks, BottleneckInterval, BottleneckKind, DetectorConfig,
};
pub use chrome_trace::{write_chrome_trace, write_chrome_trace_to};
pub use coverage::{
    merge_jsonl as merge_coverage_jsonl, CovBin, CovGroup, CoverageError, CrossTuple,
    MergedCoverage,
};
pub use cycle_estimator::{CycleEstimator, TileOperation};
pub use hw_model::{AxiBusConfig, BramConfig, HardwareModel, MacArrayConfig};
pub use license::{get_license_info, run_high_speed_simulation};
pub use live_window::{LiveSample, LiveWindow};
pub use mmap_reader::MmapTrace;
pub use pccx_format::{
    fnv1a_64, ArchConfig, PayloadConfig, PccxError, PccxFile, PccxHeader, TraceConfig,
};
pub use roofline::{
    analyze as analyze_roofline, analyze_hierarchical, RooflineBand, RooflinePoint,
};
pub use simulator::{generate_realistic_trace, save_dummy_pccx, SimConfig};
pub use status::{lab_status, lab_status_json_pretty, LabStatus};
pub use step_snapshot::{step_to_cycle, CoreState, RegisterSnapshot};
pub use synth_report::{load_from_files, SynthReport, TimingSummary, UtilSummary};
pub use theme::{
    theme_contract, theme_contract_json_pretty, theme_preset_names, theme_presets, ThemePreset,
    ThemeTokenContract, ThemeTokens,
};
pub use trace::{event_type_id, NpuEvent, NpuTrace};
pub use typed::{CoreId, CycleCount, EventTypeId, MemAddr, TraceId};
pub use vcd::{parse_vcd_file, SignalMeta, VcdChange, VcdError, WaveformDump};
pub use vcd_writer::{write_vcd, write_vcd_to};
pub use vivado_timing::{
    parse_timing_report, parse_worst_endpoint, ClockDomain, FailingPath,
    ParseError as TimingParseError, TimingReport,
};
