// Module Boundary: core/
// pccx-core: standalone NPU performance simulator and trace analysis engine.
//
// Dependency rules (enforced by this module boundary comment):
//   No dependency on ui/, uvm_bridge/, or ai_copilot/.
//   All public APIs must be usable by foreign crates via the items re-exported below.

pub mod pccx_format;
pub mod trace;
pub mod simulator;
pub mod license;
pub mod hw_model;
pub mod cycle_estimator;
pub mod synth_report;
pub mod roofline;
pub mod bottleneck;
pub mod coverage;
pub mod vcd;
pub mod vcd_writer;
pub mod chrome_trace;
pub mod isa_replay;
pub mod api_ring;
pub mod live_window;
pub mod vivado_timing;
pub mod step_snapshot;
pub mod speculative;
pub mod isa_spec;
pub mod api_spec;

// ─── Convenience re-exports (public API surface) ──────────────────────────────
pub use pccx_format::{PccxFile, PccxHeader, PccxError, ArchConfig, TraceConfig, PayloadConfig, fnv1a_64};
pub use trace::{NpuTrace, NpuEvent, event_type_id};
pub use simulator::{SimConfig, generate_realistic_trace, save_dummy_pccx};
pub use license::{get_license_info, run_high_speed_simulation};
pub use hw_model::{HardwareModel, AxiBusConfig, BramConfig, MacArrayConfig};
pub use cycle_estimator::{CycleEstimator, TileOperation};
pub use synth_report::{SynthReport, UtilSummary, TimingSummary, load_from_files};
pub use roofline::{RooflinePoint, RooflineBand, analyze as analyze_roofline, analyze_hierarchical};
pub use bottleneck::{detect as detect_bottlenecks, BottleneckInterval, BottleneckKind, DetectorConfig};
pub use coverage::{merge_jsonl as merge_coverage_jsonl, CovBin, CovGroup, CrossTuple, MergedCoverage, CoverageError};
pub use vcd::{parse_vcd_file, WaveformDump, SignalMeta, VcdChange, VcdError};
pub use vcd_writer::{write_vcd, write_vcd_to};
pub use chrome_trace::{write_chrome_trace, write_chrome_trace_to};
pub use live_window::{LiveSample, LiveWindow};
pub use step_snapshot::{step_to_cycle, CoreState, RegisterSnapshot};
pub use vivado_timing::{
    parse_timing_report, parse_worst_endpoint,
    TimingReport, ClockDomain, FailingPath, ParseError as TimingParseError,
};
pub use speculative::{
    AcceptStep, AcceptRate,
    longest_matching_prefix,
};
