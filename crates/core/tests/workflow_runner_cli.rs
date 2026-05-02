// workflow_runner_cli — CLI tests for the disabled allowlisted runner pilot.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pccx-lab"))
}

fn parse_stdout(out: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).expect("stdout is not valid JSON")
}

#[test]
fn runner_default_blocks_execution() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-lab-status-contract",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run disabled workflow runner");

    assert_eq!(out.status.code(), Some(0));
    let parsed = parse_stdout(&out);
    assert_eq!(
        parsed["schemaVersion"],
        "pccx.lab.workflow-runner-result.v0"
    );
    assert_eq!(parsed["status"], "blocked");
    assert_eq!(parsed["runnerEnabled"], false);
    assert_eq!(parsed["mode"], "disabled");
    assert_eq!(parsed["stdoutLines"].as_array().map(Vec::len), Some(0));
}

#[test]
fn runner_rejects_unknown_proposal_when_enabled() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-not-known",
            "--runner-enabled",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run enabled workflow runner with unknown proposal");

    assert_eq!(out.status.code(), Some(1));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "rejected");
    assert_eq!(parsed["runnerEnabled"], true);
    assert_eq!(parsed["stdoutLines"].as_array().map(Vec::len), Some(0));
}

#[test]
fn runner_rejects_unknown_proposal_even_when_disabled() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-not-known",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run disabled workflow runner with unknown proposal");

    assert_eq!(out.status.code(), Some(1));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "rejected");
    assert_eq!(parsed["runnerEnabled"], false);
    assert_eq!(parsed["stdoutLines"].as_array().map(Vec::len), Some(0));
}

#[test]
fn runner_rejects_raw_command_string() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "status --format json",
            "--runner-enabled",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run enabled workflow runner with raw command string");

    assert_eq!(out.status.code(), Some(1));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "rejected");
    assert_eq!(parsed["proposalId"], "[rejected-proposal-id]");
    assert_eq!(parsed["redactionApplied"], true);
}

#[test]
fn runner_executes_allowlisted_status_only_when_enabled() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-lab-status-contract",
            "--runner-enabled",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run allowlisted status proposal");

    assert_eq!(out.status.code(), Some(0));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "completed");
    assert_eq!(parsed["runnerEnabled"], true);
    assert_eq!(parsed["exitCode"], 0);
    assert_eq!(parsed["workflowId"], "lab-status-contract");
    assert!(parsed["stdoutLines"]
        .as_array()
        .expect("stdoutLines must be an array")
        .iter()
        .any(|line| line.as_str() == Some("  \"schemaVersion\": \"pccx.lab.status.v0\",")));
}

#[test]
fn runner_bounds_output_lines() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-workflow-descriptor-catalog",
            "--runner-enabled",
            "--max-output-lines",
            "2",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run bounded workflow descriptor proposal");

    assert_eq!(out.status.code(), Some(0));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "completed");
    assert_eq!(parsed["truncated"], true);
    assert_eq!(parsed["stdoutLines"].as_array().map(Vec::len), Some(2));
}

#[test]
fn runner_rejects_unsupported_format_as_json() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-lab-status-contract",
            "--format",
            "text",
        ])
        .output()
        .expect("failed to run workflow runner with unsupported format");

    assert_eq!(out.status.code(), Some(2));
    let parsed = parse_stdout(&out);
    assert_eq!(parsed["status"], "rejected");
}

#[test]
fn runner_rejection_does_not_echo_private_paths_or_secrets() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "/home/user/sk-secret",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run workflow runner with secret-shaped proposal");

    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    for phrase in ["/home/", "sk-secret", "sk-", "ghp_", "github_pat_"] {
        assert!(
            !text.contains(phrase),
            "workflow runner rejection echoed private input marker: {phrase}"
        );
    }
}

#[test]
fn runner_output_does_not_expose_private_paths_or_secrets() {
    let out = bin()
        .args([
            "run-approved-workflow",
            "proposal-workflow-proposal-catalog",
            "--runner-enabled",
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run allowlisted proposal catalog");

    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    for phrase in [
        "/home/",
        "sk-",
        "ghp_",
        "github_pat_",
        "private key",
        "begin rsa private key",
        "begin openssh private key",
    ] {
        assert!(
            !text.contains(phrase),
            "workflow runner output contains private path or secret marker: {phrase}"
        );
    }
}

#[test]
fn runner_source_does_not_use_shell_interpolation() {
    let source = std::fs::read_to_string("src/bin/pccx_lab.rs").expect("cannot read CLI source");
    for phrase in ["sh -c", "bash -c", "cmd /C", "powershell -Command"] {
        assert!(
            !source.contains(phrase),
            "runner source must not use shell interpolation: {phrase}"
        );
    }
}
