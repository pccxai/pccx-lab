//! Descriptor-only workflow catalog shared by CLI/core and GUI consumers.

use serde::{Deserialize, Serialize};

pub const WORKFLOW_DESCRIPTOR_SCHEMA_VERSION: &str = "pccx.lab.workflow-descriptors.v0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDescriptorSet {
    pub schema_version: String,
    pub tool: String,
    pub descriptors: Vec<WorkflowDescriptor>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDescriptor {
    pub workflow_id: String,
    pub label: String,
    pub category: String,
    pub description: String,
    pub availability_state: String,
    pub execution_state: String,
    pub input_policy: String,
    pub output_policy: String,
    pub safety_flags: Vec<String>,
    pub evidence_state: String,
    pub future_consumers: Vec<String>,
    pub limitations: Vec<String>,
}

fn descriptor(
    workflow_id: &str,
    label: &str,
    category: &str,
    description: &str,
    availability_state: &str,
    input_policy: &str,
    output_policy: &str,
    future_consumers: &[&str],
    limitations: &[&str],
) -> WorkflowDescriptor {
    WorkflowDescriptor {
        workflow_id: workflow_id.to_string(),
        label: label.to_string(),
        category: category.to_string(),
        description: description.to_string(),
        availability_state: availability_state.to_string(),
        execution_state: "descriptor_only".to_string(),
        input_policy: input_policy.to_string(),
        output_policy: output_policy.to_string(),
        safety_flags: vec![
            "no-execution".to_string(),
            "no-shell".to_string(),
            "no-hardware".to_string(),
            "no-fpga-repo".to_string(),
            "no-network".to_string(),
            "no-provider-call".to_string(),
            "no-private-paths".to_string(),
            "no-secrets".to_string(),
        ],
        evidence_state: "metadata-only".to_string(),
        future_consumers: future_consumers
            .iter()
            .map(|item| item.to_string())
            .collect(),
        limitations: limitations.iter().map(|item| item.to_string()).collect(),
    }
}

pub fn workflow_descriptors() -> WorkflowDescriptorSet {
    WorkflowDescriptorSet {
        schema_version: WORKFLOW_DESCRIPTOR_SCHEMA_VERSION.to_string(),
        tool: "pccx-lab".to_string(),
        descriptors: vec![
            descriptor(
                "lab-status-contract",
                "Lab status contract",
                "status",
                "Deterministic host status metadata for CLI and GUI consumers.",
                "available",
                "No user input is read by this descriptor.",
                "Pretty JSON with conservative status and evidence markers.",
                &[
                    "GUI",
                    "CI/headless worker",
                    "future IDE/launcher consumer",
                    "future MCP/tool consumer",
                ],
                &[
                    "Status metadata does not scan workspaces, load traces, or probe hardware.",
                    "Evidence fields stay conservative until a separate workflow produces results.",
                ],
            ),
            descriptor(
                "theme-token-contract",
                "Theme token contract",
                "status",
                "Theme-neutral presentation metadata for compact GUI surfaces.",
                "experimental",
                "No user input is read by this descriptor.",
                "Pretty JSON with semantic token slots and named presets.",
                &["GUI", "future IDE/launcher consumer"],
                &[
                    "Theme presets are early semantic slots, not a stable design system.",
                    "Component-level styling remains owned by the GUI surface.",
                ],
            ),
            descriptor(
                "workflow-descriptor-catalog",
                "Workflow descriptor catalog",
                "status",
                "Descriptor-only workflow metadata for shared consumers.",
                "available",
                "No user input is read by this descriptor.",
                "Pretty JSON with descriptor-only workflow metadata.",
                &[
                    "GUI",
                    "CI/headless worker",
                    "future IDE/launcher consumer",
                    "future MCP/tool consumer",
                ],
                &[
                    "Descriptor catalog listing does not execute workflows.",
                    "Descriptors are not plugin loading or runtime integration.",
                ],
            ),
            descriptor(
                "workflow-proposal-catalog",
                "Workflow proposal catalog",
                "status",
                "Proposal-only workflow previews for future approval boundaries.",
                "available",
                "No user input is read by this descriptor.",
                "Pretty JSON with proposal-only workflow previews.",
                &[
                    "GUI",
                    "CI/headless worker",
                    "future IDE/launcher consumer",
                    "future MCP/tool consumer",
                ],
                &[
                    "Proposal catalog listing does not execute workflows.",
                    "A separate approval boundary is required before any future run.",
                ],
            ),
            descriptor(
                "allowlisted-runner-pilot",
                "Disabled allowlisted runner pilot",
                "verification",
                "Disabled-by-default runner pilot for fixed pccx-lab proposal commands.",
                "disabled-by-default",
                "Accepts only a known proposal id; no raw command input is accepted.",
                "Bounded and redacted run-result JSON when explicitly enabled.",
                &["GUI", "CI/headless worker"],
                &[
                    "Runner execution is disabled by default.",
                    "Only fixed allowlisted pccx-lab commands may run when explicitly enabled.",
                    "No hardware, network, provider, launcher, IDE, or FPGA repo access is allowed.",
                ],
            ),
            descriptor(
                "systemverilog-shape-diagnostics",
                "SystemVerilog shape diagnostics",
                "diagnostics",
                "File-shape diagnostics boundary for future controlled proposal flows.",
                "early-scaffold",
                "Descriptor lists the boundary only; any file path belongs to a later approved proposal.",
                "Bounded diagnostics JSON from the CLI/core boundary.",
                &[
                    "CI/headless worker",
                    "future IDE/launcher consumer",
                    "future MCP/tool consumer",
                ],
                &[
                    "Descriptor listing does not read files.",
                    "Current diagnostics remain file-shape checks, not full semantic analysis.",
                ],
            ),
            descriptor(
                "trace-import-summary",
                "Trace import summary",
                "trace",
                "Planned metadata summary for trace discovery and import readiness.",
                "planned",
                "Descriptor accepts no trace path and performs no trace load.",
                "Future output should be bounded summary metadata only.",
                &["GUI", "CI/headless worker", "future IDE/launcher consumer"],
                &[
                    "No raw trace data crosses this descriptor boundary.",
                    "No generated artifacts are produced by descriptor listing.",
                ],
            ),
            descriptor(
                "verification-report-summary",
                "Verification report summary",
                "report",
                "Planned compact report summary for verification-oriented dashboards.",
                "planned",
                "Descriptor accepts no project path and performs no verification run.",
                "Future output should be summary-only report metadata.",
                &["GUI", "CI/headless worker"],
                &[
                    "No verification script is launched by descriptor listing.",
                    "No timing closure or hardware result is claimed.",
                ],
            ),
            descriptor(
                "plugin-candidate-metadata",
                "Plugin candidate metadata",
                "plugin_candidate",
                "Future plugin candidate surface described without loading plugins.",
                "planned",
                "Descriptor accepts no plugin path and loads no dynamic code.",
                "Metadata-only JSON for future reviewable contract design.",
                &["future plugin candidate"],
                &[
                    "No stable plugin ABI is promised.",
                    "No plugin discovery or execution is performed.",
                ],
            ),
            descriptor(
                "tool-consumer-handoff",
                "Tool consumer handoff",
                "future_mcp_candidate",
                "Future tool-consumer handoff described as a contract candidate only.",
                "planned",
                "Descriptor accepts no external tool input.",
                "Metadata-only JSON for future controlled consumers.",
                &["future MCP/tool consumer"],
                &[
                    "No MCP runtime is implemented.",
                    "No launcher or IDE runtime integration is implemented.",
                ],
            ),
        ],
        limitations: vec![
            "Workflow descriptors are metadata only and never execute workflows.".to_string(),
            "No arbitrary command runner is exposed by this contract.".to_string(),
            "No hardware, provider, network, MCP, launcher, or IDE runtime is invoked."
                .to_string(),
            "The FPGA repo is not required and is not touched by descriptor listing.".to_string(),
        ],
    }
}

pub fn workflow_descriptors_json_pretty() -> serde_json::Result<String> {
    serde_json::to_string_pretty(&workflow_descriptors())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_descriptors_have_required_shape() {
        let set = workflow_descriptors();
        assert_eq!(set.schema_version, WORKFLOW_DESCRIPTOR_SCHEMA_VERSION);
        assert_eq!(set.tool, "pccx-lab");
        assert!(set.descriptors.len() >= 6);

        for item in set.descriptors {
            assert!(!item.workflow_id.is_empty());
            assert!(!item.label.is_empty());
            assert!(!item.category.is_empty());
            assert_eq!(item.execution_state, "descriptor_only");
            assert_eq!(item.evidence_state, "metadata-only");
            assert!(item.safety_flags.iter().any(|flag| flag == "no-execution"));
        }
    }

    #[test]
    fn workflow_categories_are_allowlisted() {
        let allowed = [
            "status",
            "diagnostics",
            "verification",
            "trace",
            "report",
            "plugin_candidate",
            "future_mcp_candidate",
        ];

        for item in workflow_descriptors().descriptors {
            assert!(
                allowed.contains(&item.category.as_str()),
                "unexpected workflow category: {}",
                item.category
            );
        }
    }

    #[test]
    fn workflow_descriptors_serialize_deterministically() {
        let first = workflow_descriptors_json_pretty().unwrap();
        let second = workflow_descriptors_json_pretty().unwrap();
        assert_eq!(first, second);
    }
}
