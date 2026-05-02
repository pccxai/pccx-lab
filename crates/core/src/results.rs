//! Summary-only workflow result metadata shared by CLI/core and GUI consumers.

use serde::{Deserialize, Serialize};

use crate::runner::{
    allowlisted_command_for, blocked_workflow_result, rejected_workflow_result,
    workflow_runner_config, WorkflowRunResult,
};

pub const WORKFLOW_RESULT_SUMMARY_SCHEMA_VERSION: &str = "pccx.lab.workflow-results.v0";
pub const WORKFLOW_RESULT_SUMMARY_MAX_ENTRIES: usize = 20;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResultSummarySet {
    pub schema_version: String,
    pub tool: String,
    pub max_entries: usize,
    pub summaries: Vec<WorkflowResultSummary>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResultSummary {
    pub schema_version: String,
    pub proposal_id: String,
    pub workflow_id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u64,
    pub summary: String,
    pub truncated: bool,
    pub redaction_applied: bool,
    pub output_policy: String,
    pub limitations: Vec<String>,
}

pub fn workflow_result_summaries() -> WorkflowResultSummarySet {
    let config = workflow_runner_config();
    let status_command = allowlisted_command_for("proposal-lab-status-contract")
        .expect("status proposal must stay allowlisted");
    let blocked = blocked_workflow_result(&status_command, &config);
    let rejected = rejected_workflow_result(
        "unreviewed proposal input",
        "proposal id is not in the fixed allowlist",
        &config,
    );

    WorkflowResultSummarySet {
        schema_version: WORKFLOW_RESULT_SUMMARY_SCHEMA_VERSION.to_string(),
        tool: "pccx-lab".to_string(),
        max_entries: WORKFLOW_RESULT_SUMMARY_MAX_ENTRIES,
        summaries: vec![
            workflow_result_summary_from_run(&blocked),
            workflow_result_summary_from_run(&rejected),
        ],
        limitations: vec![
            "Result summaries are summary-only; stdout and stderr lines are omitted.".to_string(),
            "The current list is deterministic metadata, not a persistent execution cache."
                .to_string(),
            "No artifacts, hardware logs, provider logs, or FPGA repo paths are stored."
                .to_string(),
        ],
    }
}

pub fn workflow_result_summary_from_run(result: &WorkflowRunResult) -> WorkflowResultSummary {
    let (proposal_id, proposal_redacted) = safe_summary_id(&result.proposal_id);
    let (workflow_id, workflow_redacted) = safe_summary_id(&result.workflow_id);
    let (status, status_redacted) = safe_summary_status(&result.status);

    WorkflowResultSummary {
        schema_version: WORKFLOW_RESULT_SUMMARY_SCHEMA_VERSION.to_string(),
        proposal_id,
        workflow_id,
        status: status.clone(),
        exit_code: result.exit_code,
        started_at: "not-recorded".to_string(),
        finished_at: "not-recorded".to_string(),
        duration_ms: result.duration_ms,
        summary: summary_for_status(&status),
        truncated: result.truncated,
        redaction_applied: result.redaction_applied
            || proposal_redacted
            || workflow_redacted
            || status_redacted,
        output_policy: "summary-only; stdout and stderr lines are omitted".to_string(),
        limitations: vec![
            "No full logs are included in this summary.".to_string(),
            "No generated artifacts or hardware logs are referenced.".to_string(),
        ],
    }
}

pub fn workflow_result_summaries_json_pretty() -> serde_json::Result<String> {
    serde_json::to_string_pretty(&workflow_result_summaries())
}

fn summary_for_status(status: &str) -> String {
    match status {
        "blocked" => "Workflow did not run because runner execution is disabled.".to_string(),
        "rejected" => {
            "Workflow did not run because the proposal was not accepted by the allowlist."
                .to_string()
        }
        "completed" => {
            "Allowlisted workflow completed; full stdout and stderr are omitted.".to_string()
        }
        "failed" => {
            "Allowlisted workflow exited with a non-zero status; full logs are omitted.".to_string()
        }
        "timed_out" => {
            "Allowlisted workflow timed out; full stdout and stderr are omitted.".to_string()
        }
        _ => "Workflow result summary is available; full logs are omitted.".to_string(),
    }
}

fn safe_summary_id(value: &str) -> (String, bool) {
    if value == "[rejected-proposal-id]" {
        return (value.to_string(), false);
    }

    if value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && !contains_private_marker(value)
    {
        return (value.to_string(), false);
    }

    ("[redacted-id]".to_string(), true)
}

fn safe_summary_status(value: &str) -> (String, bool) {
    match value {
        "blocked" | "rejected" | "completed" | "failed" | "timed_out" => (value.to_string(), false),
        _ => ("unknown".to_string(), true),
    }
}

fn contains_private_marker(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "/home/",
        "sk-",
        "ghp_",
        "github_pat_",
        "private key",
        "begin rsa private key",
        "begin openssh private key",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::{allowlisted_command_for, completed_workflow_result, RawProcessResult};

    #[test]
    fn result_summaries_have_required_shape() {
        let set = workflow_result_summaries();
        assert_eq!(set.schema_version, WORKFLOW_RESULT_SUMMARY_SCHEMA_VERSION);
        assert_eq!(set.max_entries, WORKFLOW_RESULT_SUMMARY_MAX_ENTRIES);
        assert!(set.summaries.len() <= set.max_entries);
        assert!(set.summaries.iter().any(|item| item.status == "blocked"));
        assert!(set.summaries.iter().any(|item| item.status == "rejected"));
    }

    #[test]
    fn result_summaries_serialize_deterministically() {
        let first = workflow_result_summaries_json_pretty().unwrap();
        let second = workflow_result_summaries_json_pretty().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn summary_from_run_omits_full_output() {
        let mut config = workflow_runner_config();
        config.enabled = true;
        config.mode = "allowlist".to_string();
        let command = allowlisted_command_for("proposal-lab-status-contract").unwrap();
        let result = completed_workflow_result(
            &command,
            &config,
            RawProcessResult {
                exit_code: Some(0),
                stdout: "LOG_LINE_SHOULD_NOT_APPEAR\n".to_string(),
                stderr: "ERR_LINE_SHOULD_NOT_APPEAR\n".to_string(),
                duration_ms: 9,
                timed_out: false,
            },
        );

        let summary = workflow_result_summary_from_run(&result);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert_eq!(summary.status, "completed");
        assert!(!serialized.contains("LOG_LINE_SHOULD_NOT_APPEAR"));
        assert!(!serialized.contains("ERR_LINE_SHOULD_NOT_APPEAR"));
        assert!(!serialized.contains("stdoutLines"));
        assert!(!serialized.contains("stderrLines"));
    }

    #[test]
    fn summary_from_run_redacts_untrusted_ids() {
        let mut result = rejected_workflow_result(
            "raw proposal with spaces",
            "proposal id is not in the fixed allowlist",
            &workflow_runner_config(),
        );
        result.workflow_id = "raw workflow with spaces".to_string();

        let summary = workflow_result_summary_from_run(&result);
        assert_eq!(summary.proposal_id, "[rejected-proposal-id]");
        assert_eq!(summary.workflow_id, "[redacted-id]");
        assert_eq!(summary.redaction_applied, true);
    }

    #[test]
    fn summary_from_run_redacts_untrusted_status() {
        let mut result = rejected_workflow_result(
            "unreviewed proposal input",
            "proposal id is not in the fixed allowlist",
            &workflow_runner_config(),
        );
        result.status = "raw status with spaces".to_string();

        let summary = workflow_result_summary_from_run(&result);
        assert_eq!(summary.status, "unknown");
        assert_eq!(summary.redaction_applied, true);
    }
}
