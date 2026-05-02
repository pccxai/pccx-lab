// workflow_results_cli — end-to-end CLI tests for summary-only workflow results.

use std::collections::HashSet;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pccx-lab"))
}

fn results_json() -> serde_json::Value {
    let out = bin()
        .args(["workflow-results", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format json");

    assert_eq!(out.status.code(), Some(0));
    serde_json::from_slice(&out.stdout).expect("workflow-results stdout is not valid JSON")
}

#[test]
fn workflow_results_command_emits_summary_catalog() {
    let parsed = results_json();

    assert_eq!(parsed["schemaVersion"], "pccx.lab.workflow-results.v0");
    assert_eq!(parsed["tool"], "pccx-lab");
    assert_eq!(parsed["maxEntries"], 20);

    let summaries = parsed["summaries"]
        .as_array()
        .expect("summaries must be an array");
    assert!(!summaries.is_empty(), "expected result summaries");
    assert!(summaries.len() <= parsed["maxEntries"].as_u64().unwrap() as usize);
}

#[test]
fn workflow_results_command_is_deterministic() {
    let first = bin()
        .args(["workflow-results", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format json");
    let second = bin()
        .args(["workflow-results", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format json");

    assert_eq!(first.status.code(), Some(0));
    assert_eq!(second.status.code(), Some(0));
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn workflow_results_reject_unsupported_format() {
    let out = bin()
        .args(["workflow-results", "--format", "text"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format text");

    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("unsupported format"));
}

#[test]
fn workflow_results_are_summary_only() {
    let parsed = results_json();
    let summaries = parsed["summaries"]
        .as_array()
        .expect("summaries must be an array");

    for item in summaries {
        assert_eq!(
            item["schemaVersion"], "pccx.lab.workflow-results.v0",
            "summary must carry the result schema"
        );
        assert_eq!(
            item["outputPolicy"].as_str().unwrap_or(""),
            "summary-only; stdout and stderr lines are omitted"
        );
        assert!(item.get("stdoutLines").is_none());
        assert!(item.get("stderrLines").is_none());
        assert!(item.get("fullLog").is_none());
        assert!(
            item["summary"]
                .as_str()
                .expect("summary must be a string")
                .contains("full")
                || item["summary"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Workflow did not run")
        );
    }
}

#[test]
fn workflow_results_do_not_expose_private_paths_or_secrets() {
    let out = bin()
        .args(["workflow-results", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format json");
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
        "log_line_should_not_appear",
        "err_line_should_not_appear",
    ] {
        assert!(
            !text.contains(phrase),
            "workflow results contain private path, secret marker, or full log marker: {phrase}"
        );
    }
}

#[test]
fn workflow_results_do_not_claim_unsupported_runtime_state() {
    let out = bin()
        .args(["workflow-results", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflow-results --format json");
    assert_eq!(out.status.code(), Some(0));

    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    for phrase in [
        "production-ready",
        "stable plugin abi is supported",
        "stable plugin abi is available",
        "mcp ready",
        "stable mcp interface",
        "kv260 inference works",
        "20 tok/s achieved",
        "timing closure achieved",
        "timing-closed bitstream is available",
        "hardware log captured",
    ] {
        assert!(
            !text.contains(phrase),
            "workflow results contain unsupported claim: {phrase}"
        );
    }
}

#[test]
fn workflow_result_keys_match_example_json() {
    use std::path::Path;

    let example_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs/examples/workflow-results.example.json");

    let example_text = std::fs::read_to_string(&example_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", example_path.display()));
    let example: serde_json::Value =
        serde_json::from_str(&example_text).expect("workflow results example JSON is not valid");

    let example_keys: HashSet<&str> = example
        .as_object()
        .expect("workflow results example JSON must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    let live = results_json();
    let live_keys: HashSet<&str> = live
        .as_object()
        .expect("workflow results stdout must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    assert_eq!(
        live_keys,
        example_keys,
        "live workflow result keys differ from example JSON.\n  live only: {:?}\n  example only: {:?}",
        live_keys.difference(&example_keys).collect::<Vec<_>>(),
        example_keys.difference(&live_keys).collect::<Vec<_>>(),
    );
}
