//! Disabled-by-default allowlisted workflow runner pilot.

use serde::{Deserialize, Serialize};

pub const WORKFLOW_RUNNER_STATUS_SCHEMA_VERSION: &str = "pccx.lab.workflow-runner-status.v0";
pub const WORKFLOW_RUNNER_RESULT_SCHEMA_VERSION: &str = "pccx.lab.workflow-runner-result.v0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunnerConfig {
    pub enabled: bool,
    pub mode: String,
    pub timeout_ms: u64,
    pub max_output_lines: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunnerStatus {
    pub schema_version: String,
    pub enabled: bool,
    pub mode: String,
    pub timeout_ms: u64,
    pub max_output_lines: usize,
    pub allowlisted_proposal_ids: Vec<String>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedWorkflowCommand {
    pub proposal_id: String,
    pub workflow_id: String,
    pub label: String,
    pub fixed_args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunResult {
    pub schema_version: String,
    pub proposal_id: String,
    pub workflow_id: String,
    pub status: String,
    pub runner_enabled: bool,
    pub mode: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout_lines: Vec<String>,
    pub stderr_lines: Vec<String>,
    pub truncated: bool,
    pub redaction_applied: bool,
    pub safety_flags: Vec<String>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawProcessResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

pub fn workflow_runner_config() -> WorkflowRunnerConfig {
    WorkflowRunnerConfig {
        enabled: false,
        mode: "disabled".to_string(),
        timeout_ms: 30_000,
        max_output_lines: 120,
    }
}

pub fn workflow_runner_status(config: &WorkflowRunnerConfig) -> WorkflowRunnerStatus {
    WorkflowRunnerStatus {
        schema_version: WORKFLOW_RUNNER_STATUS_SCHEMA_VERSION.to_string(),
        enabled: config.enabled,
        mode: config.mode.clone(),
        timeout_ms: config.timeout_ms,
        max_output_lines: config.max_output_lines,
        allowlisted_proposal_ids: allowlisted_workflow_commands()
            .into_iter()
            .map(|command| command.proposal_id)
            .collect(),
        limitations: vec![
            "Workflow runner execution is disabled by default.".to_string(),
            "Only fixed allowlisted pccx-lab commands may run when explicitly enabled."
                .to_string(),
            "No raw shell commands, hardware calls, provider calls, network calls, or FPGA repo access are allowed."
                .to_string(),
            "Output is line-bounded and redacted before it is returned.".to_string(),
        ],
    }
}

pub fn workflow_runner_status_json_pretty(
    config: &WorkflowRunnerConfig,
) -> serde_json::Result<String> {
    serde_json::to_string_pretty(&workflow_runner_status(config))
}

pub fn allowlisted_workflow_commands() -> Vec<FixedWorkflowCommand> {
    vec![
        fixed_command(
            "proposal-lab-status-contract",
            "lab-status-contract",
            "Lab status contract",
            &["status", "--format", "json"],
        ),
        fixed_command(
            "proposal-theme-token-contract",
            "theme-token-contract",
            "Theme token contract",
            &["theme", "--format", "json"],
        ),
        fixed_command(
            "proposal-workflow-descriptor-catalog",
            "workflow-descriptor-catalog",
            "Workflow descriptor catalog",
            &["workflows", "--format", "json"],
        ),
        fixed_command(
            "proposal-workflow-proposal-catalog",
            "workflow-proposal-catalog",
            "Workflow proposal catalog",
            &["workflow-proposals", "--format", "json"],
        ),
    ]
}

pub fn allowlisted_command_for(proposal_id: &str) -> Option<FixedWorkflowCommand> {
    allowlisted_workflow_commands()
        .into_iter()
        .find(|command| command.proposal_id == proposal_id)
}

pub fn blocked_workflow_result(
    command: &FixedWorkflowCommand,
    config: &WorkflowRunnerConfig,
) -> WorkflowRunResult {
    base_result(
        &command.proposal_id,
        &command.workflow_id,
        "blocked",
        config,
        None,
        0,
        Vec::new(),
        Vec::new(),
        false,
        false,
        vec![
            "Runner is disabled by default.",
            "Pass explicit local runner enablement before any allowlisted pilot command can run.",
        ],
    )
}

pub fn rejected_workflow_result(
    proposal_id: &str,
    reason: &str,
    config: &WorkflowRunnerConfig,
) -> WorkflowRunResult {
    let (proposal_id, redaction_applied) = safe_rejected_proposal_id(proposal_id);
    base_result(
        &proposal_id,
        "unknown",
        "rejected",
        config,
        None,
        0,
        Vec::new(),
        Vec::new(),
        false,
        redaction_applied,
        vec![
            "Proposal is not allowlisted for the disabled-by-default runner pilot.",
            reason,
        ],
    )
}

pub fn completed_workflow_result(
    command: &FixedWorkflowCommand,
    config: &WorkflowRunnerConfig,
    raw: RawProcessResult,
) -> WorkflowRunResult {
    let (stdout_lines, stdout_truncated, stdout_redacted) =
        bound_and_redact_lines(&raw.stdout, config.max_output_lines);
    let remaining = config.max_output_lines.saturating_sub(stdout_lines.len());
    let (stderr_lines, stderr_truncated, stderr_redacted) =
        bound_and_redact_lines(&raw.stderr, remaining);

    let status = if raw.timed_out {
        "timed_out"
    } else if raw.exit_code == Some(0) {
        "completed"
    } else {
        "failed"
    };

    base_result(
        &command.proposal_id,
        &command.workflow_id,
        status,
        config,
        raw.exit_code,
        raw.duration_ms,
        stdout_lines,
        stderr_lines,
        stdout_truncated || stderr_truncated,
        stdout_redacted || stderr_redacted,
        vec![
            "Only fixed allowlisted pccx-lab arguments were used.",
            "Output was bounded and redacted before serialization.",
        ],
    )
}

pub fn workflow_run_result_json_pretty(result: &WorkflowRunResult) -> serde_json::Result<String> {
    serde_json::to_string_pretty(result)
}

fn fixed_command(
    proposal_id: &str,
    workflow_id: &str,
    label: &str,
    args: &[&str],
) -> FixedWorkflowCommand {
    FixedWorkflowCommand {
        proposal_id: proposal_id.to_string(),
        workflow_id: workflow_id.to_string(),
        label: label.to_string(),
        fixed_args: args.iter().map(|arg| arg.to_string()).collect(),
    }
}

fn base_result(
    proposal_id: &str,
    workflow_id: &str,
    status: &str,
    config: &WorkflowRunnerConfig,
    exit_code: Option<i32>,
    duration_ms: u64,
    stdout_lines: Vec<String>,
    stderr_lines: Vec<String>,
    truncated: bool,
    redaction_applied: bool,
    limitations: Vec<&str>,
) -> WorkflowRunResult {
    WorkflowRunResult {
        schema_version: WORKFLOW_RUNNER_RESULT_SCHEMA_VERSION.to_string(),
        proposal_id: proposal_id.to_string(),
        workflow_id: workflow_id.to_string(),
        status: status.to_string(),
        runner_enabled: config.enabled,
        mode: config.mode.clone(),
        exit_code,
        duration_ms,
        stdout_lines,
        stderr_lines,
        truncated,
        redaction_applied,
        safety_flags: vec![
            "allowlist-only".to_string(),
            "fixed-args-only".to_string(),
            "no-shell".to_string(),
            "timeout-enforced".to_string(),
            "bounded-output".to_string(),
            "redaction-applied-before-return".to_string(),
            "no-hardware".to_string(),
            "no-fpga-repo".to_string(),
            "no-network".to_string(),
            "no-provider-call".to_string(),
        ],
        limitations: limitations
            .into_iter()
            .map(|item| item.to_string())
            .collect(),
    }
}

fn safe_rejected_proposal_id(proposal_id: &str) -> (String, bool) {
    if allowlisted_command_for(proposal_id).is_some() {
        return (proposal_id.to_string(), false);
    }

    ("[rejected-proposal-id]".to_string(), true)
}

fn bound_and_redact_lines(input: &str, max_lines: usize) -> (Vec<String>, bool, bool) {
    let mut redaction_applied = false;
    let mut lines = Vec::new();
    let mut truncated = false;

    for (index, line) in input.lines().enumerate() {
        if index >= max_lines {
            truncated = true;
            break;
        }
        let (line, redacted) = redact_line(line);
        redaction_applied |= redacted;
        lines.push(line);
    }

    (lines, truncated, redaction_applied)
}

fn redact_line(line: &str) -> (String, bool) {
    let lower = line.to_lowercase();
    for marker in [
        "/home/",
        "sk-",
        "ghp_",
        "github_pat_",
        "private key",
        "begin rsa private key",
        "begin openssh private key",
    ] {
        if lower.contains(marker) {
            return ("[redacted-line]".to_string(), true);
        }
    }
    (line.to_string(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runner_config_is_disabled() {
        let config = workflow_runner_config();
        assert_eq!(config.enabled, false);
        assert_eq!(config.mode, "disabled");
        assert_eq!(config.timeout_ms, 30_000);
        assert_eq!(config.max_output_lines, 120);
    }

    #[test]
    fn runner_status_lists_allowlisted_proposals() {
        let status = workflow_runner_status(&workflow_runner_config());
        assert_eq!(status.schema_version, WORKFLOW_RUNNER_STATUS_SCHEMA_VERSION);
        assert!(status
            .allowlisted_proposal_ids
            .iter()
            .any(|id| id == "proposal-lab-status-contract"));
    }

    #[test]
    fn disabled_result_blocks_execution() {
        let command = allowlisted_command_for("proposal-lab-status-contract").unwrap();
        let result = blocked_workflow_result(&command, &workflow_runner_config());
        assert_eq!(result.status, "blocked");
        assert_eq!(result.runner_enabled, false);
        assert_eq!(result.workflow_id, "lab-status-contract");
        assert!(result.stdout_lines.is_empty());
        assert!(result.stderr_lines.is_empty());
    }

    #[test]
    fn unknown_proposal_is_rejected() {
        let mut config = workflow_runner_config();
        config.enabled = true;
        config.mode = "allowlist".to_string();
        let result = rejected_workflow_result("run whatever", "unknown proposal", &config);
        assert_eq!(result.status, "rejected");
        assert_eq!(result.proposal_id, "[rejected-proposal-id]");
        assert_eq!(result.runner_enabled, true);
        assert_eq!(result.redaction_applied, true);
    }

    #[test]
    fn process_result_bounds_and_redacts_output() {
        let mut config = workflow_runner_config();
        config.enabled = true;
        config.mode = "allowlist".to_string();
        config.max_output_lines = 2;
        let command = allowlisted_command_for("proposal-lab-status-contract").unwrap();
        let result = completed_workflow_result(
            &command,
            &config,
            RawProcessResult {
                exit_code: Some(0),
                stdout: "ok\n/home/user/private\nextra\n".to_string(),
                stderr: "sk-secret\n".to_string(),
                duration_ms: 7,
                timed_out: false,
            },
        );

        assert_eq!(result.status, "completed");
        assert_eq!(result.stdout_lines, vec!["ok", "[redacted-line]"]);
        assert_eq!(result.stderr_lines.len(), 0);
        assert_eq!(result.truncated, true);
        assert_eq!(result.redaction_applied, true);
    }
}
