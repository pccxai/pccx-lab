//! Deterministic lab-status contract for CLI and GUI consumers.

use serde::{Deserialize, Serialize};

use crate::theme::{theme_preset_names, THEME_SCHEMA_VERSION};

pub const STATUS_SCHEMA_VERSION: &str = "pccx.lab.status.v0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStatus {
    pub schema_version: String,
    pub tool: String,
    pub version: String,
    pub lab_mode: String,
    pub workspace_state: WorkspaceState,
    pub available_workflows: Vec<WorkflowState>,
    pub plugin_state: PluginState,
    pub gui_state: GuiState,
    pub diagnostics_state: DiagnosticsState,
    pub evidence_state: EvidenceState,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub state: String,
    pub trace_loaded: bool,
    pub source: String,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub label: String,
    pub status: String,
    pub boundary: String,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub status: String,
    pub stable_abi: bool,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiState {
    pub status: String,
    pub style: String,
    pub surface: String,
    pub status_source: String,
    pub theme_schema_version: String,
    pub theme_presets: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsState {
    pub status: String,
    pub command: String,
    pub scope: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceState {
    pub hardware_probe: String,
    pub timing_closure: String,
    pub inference: String,
    pub throughput: String,
    pub note: String,
}

fn workflow(id: &str, label: &str, status: &str, boundary: &str, note: &str) -> WorkflowState {
    WorkflowState {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        boundary: boundary.to_string(),
        note: note.to_string(),
    }
}

pub fn lab_status() -> LabStatus {
    LabStatus {
        schema_version: STATUS_SCHEMA_VERSION.to_string(),
        tool: "pccx-lab".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        lab_mode: "cli-first-gui-foundation".to_string(),
        workspace_state: WorkspaceState {
            state: "host-ready".to_string(),
            trace_loaded: false,
            source: "static-core-status".to_string(),
            note: "No workspace scan, trace load, hardware probe, or provider call is performed."
                .to_string(),
        },
        available_workflows: vec![
            workflow(
                "status",
                "Lab status",
                "available",
                "pccx-lab status --format json",
                "Deterministic JSON emitted from pccx-core.",
            ),
            workflow(
                "analyze",
                "SystemVerilog shape diagnostics",
                "early-scaffold",
                "pccx-lab analyze <file> --format json",
                "File-shape checks only; deeper diagnostics stay behind the same boundary.",
            ),
            workflow(
                "theme",
                "Theme token contract",
                "experimental",
                "pccx-lab theme --format json",
                "Minimal semantic slots for theme-neutral presentation.",
            ),
            workflow(
                "workflows",
                "Workflow descriptor catalog",
                "available",
                "pccx-lab workflows --format json",
                "Descriptor-only workflow metadata emitted from pccx-core.",
            ),
            workflow(
                "workflow-proposals",
                "Workflow proposal catalog",
                "available",
                "pccx-lab workflow-proposals --format json",
                "Proposal-only workflow previews emitted from pccx-core.",
            ),
            workflow(
                "run-approved-workflow",
                "Disabled allowlisted runner pilot",
                "disabled-by-default",
                "pccx-lab run-approved-workflow <proposal-id> --format json",
                "Fixed-args allowlist pilot; disabled unless explicitly enabled.",
            ),
            workflow(
                "gui-status",
                "Compact verification dashboard",
                "foundation",
                "Tauri IPC reads pccx-core status",
                "The GUI renders status data and does not own workflow logic.",
            ),
        ],
        plugin_state: PluginState {
            status: "placeholder".to_string(),
            stable_abi: false,
            note: "Plugin-facing contracts remain experimental; no stable plugin ABI is promised."
                .to_string(),
        },
        gui_state: GuiState {
            status: "thin-surface".to_string(),
            style: "minimal native-editor style".to_string(),
            surface: "compact verification dashboard".to_string(),
            status_source: "pccx_core::status::lab_status".to_string(),
            theme_schema_version: THEME_SCHEMA_VERSION.to_string(),
            theme_presets: theme_preset_names(),
        },
        diagnostics_state: DiagnosticsState {
            status: "early-scaffold".to_string(),
            command: "pccx-lab analyze <file> --format json".to_string(),
            scope: "host file-shape diagnostics only".to_string(),
        },
        evidence_state: EvidenceState {
            hardware_probe: "not-run".to_string(),
            timing_closure: "not-claimed".to_string(),
            inference: "not-claimed".to_string(),
            throughput: "not-claimed".to_string(),
            note:
                "Status stays conservative until verified evidence exists in the proper workflow."
                    .to_string(),
        },
        limitations: vec![
            "This is a CLI-backed GUI foundation, not a full GUI.".to_string(),
            "No MCP runtime is implemented by this boundary.".to_string(),
            "No provider, launcher, or editor runtime bridge is implemented by this boundary."
                .to_string(),
            "No hardware inference, throughput, or timing-closure result is claimed.".to_string(),
            "Theme presets are early semantic tokens, not a design system.".to_string(),
        ],
    }
}

pub fn lab_status_json_pretty() -> serde_json::Result<String> {
    serde_json::to_string_pretty(&lab_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_has_required_shape() {
        let status = lab_status();
        assert_eq!(status.schema_version, STATUS_SCHEMA_VERSION);
        assert_eq!(status.tool, "pccx-lab");
        assert_eq!(status.lab_mode, "cli-first-gui-foundation");
        assert_eq!(status.workspace_state.trace_loaded, false);
        assert_eq!(status.plugin_state.stable_abi, false);
        assert_eq!(status.evidence_state.hardware_probe, "not-run");
        assert_eq!(status.evidence_state.inference, "not-claimed");
    }

    #[test]
    fn status_output_is_deterministic() {
        let first = lab_status_json_pretty().unwrap();
        let second = lab_status_json_pretty().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn status_references_theme_contract() {
        let status = lab_status();
        assert_eq!(status.gui_state.theme_schema_version, THEME_SCHEMA_VERSION);
        assert_eq!(
            status.gui_state.theme_presets,
            vec!["native-light", "native-dark", "compact-dark", "quiet-light"]
        );
    }
}
