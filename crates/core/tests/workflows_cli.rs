// workflows_cli — end-to-end CLI tests for descriptor-only workflow metadata.

use std::collections::HashSet;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pccx-lab"))
}

fn workflows_json() -> serde_json::Value {
    let out = bin()
        .args(["workflows", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflows --format json");

    assert_eq!(out.status.code(), Some(0));
    serde_json::from_slice(&out.stdout).expect("workflows stdout is not valid JSON")
}

#[test]
fn workflows_command_emits_descriptor_catalog() {
    let parsed = workflows_json();

    assert_eq!(parsed["schemaVersion"], "pccx.lab.workflow-descriptors.v0");
    assert_eq!(parsed["tool"], "pccx-lab");

    let descriptors = parsed["descriptors"]
        .as_array()
        .expect("descriptors must be an array");
    assert!(
        descriptors.len() >= 6,
        "expected a reusable descriptor catalog"
    );
}

#[test]
fn workflows_command_is_deterministic() {
    let first = bin()
        .args(["workflows", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflows --format json");
    let second = bin()
        .args(["workflows", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflows --format json");

    assert_eq!(first.status.code(), Some(0));
    assert_eq!(second.status.code(), Some(0));
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn workflows_reject_unsupported_format() {
    let out = bin()
        .args(["workflows", "--format", "text"])
        .output()
        .expect("failed to run pccx-lab workflows --format text");

    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("unsupported format"));
}

#[test]
fn workflow_descriptors_are_descriptor_only() {
    let parsed = workflows_json();
    let descriptors = parsed["descriptors"]
        .as_array()
        .expect("descriptors must be an array");

    for item in descriptors {
        assert_eq!(
            item["executionState"].as_str().unwrap_or(""),
            "descriptor_only",
            "descriptor must not advertise execution"
        );
        assert_eq!(
            item["evidenceState"].as_str().unwrap_or(""),
            "metadata-only",
            "descriptor must stay metadata-only"
        );

        let flags = item["safetyFlags"]
            .as_array()
            .expect("safetyFlags must be an array");
        assert!(flags.iter().any(|flag| flag == "no-execution"));
        assert!(flags.iter().any(|flag| flag == "no-shell"));
        assert!(flags.iter().any(|flag| flag == "no-fpga-repo"));
    }
}

#[test]
fn workflow_descriptor_ids_are_unique_and_status_references_workflows() {
    let parsed = workflows_json();
    let descriptors = parsed["descriptors"]
        .as_array()
        .expect("descriptors must be an array");

    let mut seen = HashSet::new();
    for item in descriptors {
        let id = item["workflowId"].as_str().expect("workflowId missing");
        assert!(seen.insert(id), "duplicate workflowId: {id}");
    }

    let status = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");
    assert_eq!(status.status.code(), Some(0));
    let status_json: serde_json::Value =
        serde_json::from_slice(&status.stdout).expect("status stdout is not valid JSON");
    let status_workflows = status_json["availableWorkflows"]
        .as_array()
        .expect("availableWorkflows must be an array");
    assert!(
        status_workflows
            .iter()
            .any(|item| item["id"].as_str() == Some("workflows")),
        "status output must advertise the workflow descriptor boundary"
    );
}

#[test]
fn workflows_do_not_expose_private_paths_or_secrets() {
    let out = bin()
        .args(["workflows", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflows --format json");
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
            "workflow descriptors contain private path or secret marker: {phrase}"
        );
    }
}

#[test]
fn workflows_do_not_claim_unsupported_runtime_state() {
    let out = bin()
        .args(["workflows", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab workflows --format json");
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
    ] {
        assert!(
            !text.contains(phrase),
            "workflow descriptors contain unsupported claim: {phrase}"
        );
    }
}

#[test]
fn workflow_descriptor_keys_match_example_json() {
    use std::path::Path;

    let example_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs/examples/workflow-descriptors.example.json");

    let example_text = std::fs::read_to_string(&example_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", example_path.display()));
    let example: serde_json::Value =
        serde_json::from_str(&example_text).expect("workflow example JSON is not valid");

    let example_keys: HashSet<&str> = example
        .as_object()
        .expect("workflow example JSON must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    let live = workflows_json();
    let live_keys: HashSet<&str> = live
        .as_object()
        .expect("workflow stdout must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    assert_eq!(
        live_keys,
        example_keys,
        "live workflow descriptor keys differ from example JSON.\n  live only: {:?}\n  example only: {:?}",
        live_keys.difference(&example_keys).collect::<Vec<_>>(),
        example_keys.difference(&live_keys).collect::<Vec<_>>(),
    );
}
