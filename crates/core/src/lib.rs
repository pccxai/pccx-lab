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
pub mod diagnostics_handoff;
pub mod hw_model;
pub mod isa_replay;
pub mod license;
pub mod live_window;
pub mod mmap_reader;
pub mod pccx_format;
pub mod plugin;
pub mod proposals;
pub mod results;
pub mod roofline;
pub mod runner;
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
pub mod workflows;

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
pub use diagnostics_handoff::{
    diagnostics_handoff_error_json_pretty, diagnostics_handoff_summary_json_pretty,
    validate_diagnostics_handoff_json, DescriptorRefs, DiagnosticsHandoffError,
    DiagnosticsHandoffSummary, ReadOnlyFlags, HANDOFF_VALIDATION_SCHEMA_VERSION,
    LAUNCHER_HANDOFF_SCHEMA_VERSION,
};
pub use hw_model::{AxiBusConfig, BramConfig, HardwareModel, MacArrayConfig};
pub use license::{get_license_info, run_high_speed_simulation};
pub use live_window::{LiveSample, LiveWindow};
pub use mmap_reader::MmapTrace;
pub use pccx_format::{
    fnv1a_64, ArchConfig, PayloadConfig, PccxError, PccxFile, PccxHeader, TraceConfig,
};
pub use proposals::{
    workflow_proposals, workflow_proposals_json_pretty, WorkflowProposal, WorkflowProposalSet,
};
pub use results::{
    workflow_result_summaries, workflow_result_summaries_json_pretty,
    workflow_result_summary_from_run, WorkflowResultSummary, WorkflowResultSummarySet,
};
pub use roofline::{
    analyze as analyze_roofline, analyze_hierarchical, RooflineBand, RooflinePoint,
};
pub use runner::{
    allowlisted_command_for, allowlisted_workflow_commands, blocked_workflow_result,
    completed_workflow_result, rejected_workflow_result, workflow_run_result_json_pretty,
    workflow_runner_config, workflow_runner_status, workflow_runner_status_json_pretty,
    FixedWorkflowCommand, RawProcessResult, WorkflowRunResult, WorkflowRunnerConfig,
    WorkflowRunnerStatus,
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
pub use workflows::{
    workflow_descriptors, workflow_descriptors_json_pretty, WorkflowDescriptor,
    WorkflowDescriptorSet,
};
