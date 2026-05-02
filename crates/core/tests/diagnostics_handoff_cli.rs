// diagnostics_handoff_cli — read-only consumer tests for launcher handoff JSON.
//
// The validator parses local JSON only. It must not execute launcher flows,
// call providers, touch hardware, load plugins, or write files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use pccx_core::{
    diagnostics_handoff_summary_json_pretty, validate_diagnostics_handoff_json,
    HANDOFF_VALIDATION_SCHEMA_VERSION, LAUNCHER_HANDOFF_SCHEMA_VERSION,
};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pccx-lab"))
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn fixture_path() -> PathBuf {
    repo_root().join("docs/examples/launcher-diagnostics-handoff.example.json")
}

fn read_fixture() -> String {
    std::fs::read_to_string(fixture_path()).expect("cannot read handoff fixture")
}

fn fixture_value() -> serde_json::Value {
    serde_json::from_str(&read_fixture()).expect("fixture JSON must be valid")
}

fn object_mut(value: &mut serde_json::Value) -> &mut serde_json::Map<String, serde_json::Value> {
    value.as_object_mut().expect("fixture must be an object")
}

#[test]
fn valid_fixture_summary_has_expected_shape() {
    let summary = validate_diagnostics_handoff_json(&read_fixture()).unwrap();

    assert_eq!(summary.schema_version, HANDOFF_VALIDATION_SCHEMA_VERSION);
    assert_eq!(summary.tool, "pccx-lab");
    assert!(summary.valid);
    assert_eq!(
        summary.handoff_schema_version,
        LAUNCHER_HANDOFF_SCHEMA_VERSION
    );
    assert_eq!(
        summary.handoff_id,
        "launcher_diagnostics_handoff_gemma3n_e4b_kv260_placeholder"
    );
    assert_eq!(summary.handoff_kind, "read_only_handoff");
    assert_eq!(summary.producer_id, "pccx-llm-launcher");
    assert_eq!(summary.consumer_id, "pccx-lab");
    assert_eq!(summary.target_kind, "kv260");
    assert_eq!(summary.diagnostic_count, 5);
    assert_eq!(summary.diagnostics_by_severity["info"], 2);
    assert_eq!(summary.diagnostics_by_severity["warning"], 1);
    assert_eq!(summary.diagnostics_by_severity["blocked"], 2);
    assert_eq!(summary.diagnostics_by_severity["error"], 0);
    assert_eq!(summary.diagnostics_by_category["configuration"], 1);
    assert_eq!(summary.diagnostics_by_category["runtime_descriptor"], 1);
    assert_eq!(summary.diagnostics_by_category["evidence"], 1);
    assert_eq!(summary.diagnostics_by_category["safety"], 1);
}

#[test]
fn valid_fixture_reports_read_only_boundary_flags() {
    let summary = validate_diagnostics_handoff_json(&read_fixture()).unwrap();
    let flags = summary.read_only_flags;

    assert!(flags.no_user_data_upload);
    assert!(flags.no_telemetry);
    assert!(flags.no_automatic_upload);
    assert!(flags.no_write_back);
    assert!(flags.no_runtime_execution);
    assert!(flags.no_hardware_access);
    assert!(flags.no_pccx_lab_execution);
    assert!(flags.no_launcher_execution);
    assert!(flags.no_provider_calls);
    assert!(flags.no_network_calls);
    assert!(flags.no_mcp);
    assert!(flags.no_lsp);
    assert!(flags.no_marketplace_flow);
}

#[test]
fn valid_fixture_references_launcher_descriptors_without_embedding_runtime_state() {
    let value = fixture_value();
    let root = value.as_object().unwrap();
    let summary = validate_diagnostics_handoff_json(&read_fixture()).unwrap();

    assert!(!root.contains_key("modelDescriptor"));
    assert!(!root.contains_key("runtimeDescriptor"));
    assert_eq!(
        summary.descriptor_refs.launcher_status_operation_id,
        "pccxlab.diagnostics.handoff"
    );
    assert_eq!(summary.descriptor_refs.model_id, "gemma3n_e4b_placeholder");
    assert_eq!(summary.descriptor_refs.runtime_id, "kv260_pccx_placeholder");
    assert_eq!(
        summary.descriptor_refs.descriptor_policy,
        "descriptor_ref_only"
    );
}

#[test]
fn transport_summary_is_deterministic_and_future_safe() {
    let summary = validate_diagnostics_handoff_json(&read_fixture()).unwrap();
    let kinds: HashSet<&str> = summary.transport_kinds.iter().map(String::as_str).collect();

    assert_eq!(
        kinds,
        HashSet::from([
            "json_file",
            "stdout_json",
            "read_only_local_artifact_reference"
        ])
    );

    let first = diagnostics_handoff_summary_json_pretty(&summary).unwrap();
    let second = diagnostics_handoff_summary_json_pretty(&summary).unwrap();
    assert_eq!(first, second);
}

#[test]
fn missing_required_field_is_rejected() {
    let mut value = fixture_value();
    object_mut(&mut value).remove("handoffId");
    let text = serde_json::to_string(&value).unwrap();

    let err = validate_diagnostics_handoff_json(&text).unwrap_err();
    assert!(err.to_string().contains("missing required field handoffId"));
}

#[test]
fn invalid_severity_and_category_are_rejected() {
    let mut value = fixture_value();
    let diagnostic = value["diagnostics"]
        .as_array_mut()
        .unwrap()
        .first_mut()
        .unwrap();
    diagnostic["severity"] = serde_json::Value::String("fatal".to_string());
    diagnostic["category"] = serde_json::Value::String("runtime".to_string());
    let text = serde_json::to_string(&value).unwrap();

    let err = validate_diagnostics_handoff_json(&text).unwrap_err();
    assert!(err.to_string().contains("unsupported value"));
}

#[test]
fn private_paths_secrets_weight_paths_and_claim_markers_are_rejected() {
    let mut private_path = fixture_value();
    private_path["artifactRefs"][0]["reference"] =
        serde_json::Value::String("/home/user/private.log".to_string());
    assert!(
        validate_diagnostics_handoff_json(&serde_json::to_string(&private_path).unwrap()).is_err()
    );

    let mut weight_path = fixture_value();
    weight_path["artifactRefs"][0]["reference"] =
        serde_json::Value::String("models/private/model.safetensors".to_string());
    assert!(
        validate_diagnostics_handoff_json(&serde_json::to_string(&weight_path).unwrap()).is_err()
    );

    let mut unsupported_claim = fixture_value();
    unsupported_claim["diagnostics"][0]["summary"] =
        serde_json::Value::String("KV260 inference works".to_string());
    assert!(
        validate_diagnostics_handoff_json(&serde_json::to_string(&unsupported_claim).unwrap())
            .is_err()
    );
}

#[test]
fn telemetry_upload_writeback_and_provider_configs_are_rejected_when_enabled() {
    let mut value = fixture_value();
    value["privacyFlags"]["automaticUpload"] = serde_json::Value::Bool(true);
    assert!(validate_diagnostics_handoff_json(&serde_json::to_string(&value).unwrap()).is_err());

    let mut value = fixture_value();
    value["safetyFlags"]["writeBack"] = serde_json::Value::Bool(true);
    assert!(validate_diagnostics_handoff_json(&serde_json::to_string(&value).unwrap()).is_err());

    let mut value = fixture_value();
    value["privacyFlags"]["providerConfigsIncluded"] = serde_json::Value::Bool(true);
    assert!(validate_diagnostics_handoff_json(&serde_json::to_string(&value).unwrap()).is_err());
}

#[test]
fn cli_validate_emits_json_summary_and_exits_zero() {
    let out = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            fixture_path().to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .expect("failed to run pccx-lab diagnostics-handoff validate");

    assert_eq!(out.status.code(), Some(0));
    assert!(out.stderr.is_empty());
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout must be valid JSON");
    assert_eq!(parsed["schemaVersion"], HANDOFF_VALIDATION_SCHEMA_VERSION);
    assert_eq!(parsed["valid"].as_bool(), Some(true));
    assert_eq!(parsed["diagnosticCount"].as_u64(), Some(5));
    assert_eq!(
        parsed["readOnlyFlags"]["noPccxLabExecution"].as_bool(),
        Some(true)
    );
}

#[test]
fn cli_validate_output_is_deterministic() {
    let first = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            fixture_path().to_str().unwrap(),
        ])
        .output()
        .expect("failed to run first validation");
    let second = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            fixture_path().to_str().unwrap(),
        ])
        .output()
        .expect("failed to run second validation");

    assert_eq!(first.status.code(), Some(0));
    assert_eq!(second.status.code(), Some(0));
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn cli_validate_does_not_write_files() {
    let tmp = tempfile::tempdir().unwrap();
    let fixture = tmp.path().join("handoff.json");
    std::fs::write(&fixture, read_fixture()).unwrap();

    let before = std::fs::read_dir(tmp.path()).unwrap().count();
    let out = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            fixture.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run validation");
    let after = std::fs::read_dir(tmp.path()).unwrap().count();

    assert_eq!(out.status.code(), Some(0));
    assert_eq!(before, after);
}

#[test]
fn cli_invalid_handoff_exits_one_without_private_path_leak() {
    let tmp = tempfile::tempdir().unwrap();
    let fixture = tmp.path().join("handoff.json");
    let mut value = fixture_value();
    value["artifactRefs"][0]["reference"] =
        serde_json::Value::String("/home/user/private.log".to_string());
    std::fs::write(&fixture, serde_json::to_string(&value).unwrap()).unwrap();

    let out = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            fixture.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run invalid validation");

    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    let parsed: serde_json::Value =
        serde_json::from_str(&stderr).expect("stderr must be JSON error");
    assert_eq!(parsed["valid"].as_bool(), Some(false));
    assert!(!stderr.contains("/home/user"));
}

#[test]
fn cli_missing_file_exits_two_without_echoing_path() {
    let missing = repo_root().join("missing-private-handoff.json");
    let out = bin()
        .args([
            "diagnostics-handoff",
            "validate",
            "--file",
            missing.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run missing-file validation");

    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("cannot read diagnostics handoff file"));
    assert!(!stderr.contains(missing.to_str().unwrap()));
}

#[test]
fn core_and_cli_sources_do_not_add_runtime_side_effect_terms() {
    let core = std::fs::read_to_string(repo_root().join("crates/core/src/diagnostics_handoff.rs"))
        .expect("cannot read diagnostics_handoff.rs");
    let cli = std::fs::read_to_string(repo_root().join("crates/core/src/bin/pccx_lab.rs"))
        .expect("cannot read pccx_lab.rs");
    let diagnostics_cli = cli
        .split("fn diagnostics_handoff_usage")
        .nth(1)
        .and_then(|tail| tail.split("fn run_approved_workflow_usage").next())
        .expect("cannot isolate diagnostics handoff CLI handler");
    let text = format!("{core}\n{diagnostics_cli}").to_lowercase();

    for phrase in [
        "command::new",
        "tokio::process",
        "std::net",
        "tcpstream",
        "udpsocket",
        "reqwest",
        "ureq",
        "openai",
        "anthropic",
        "modelcontextprotocol",
        "pccx-llm-launcher status",
        "pccx-llm-launcher run",
        "tauri::",
    ] {
        assert!(
            !text.contains(phrase),
            "diagnostics handoff boundary added runtime side effect term: {phrase}"
        );
    }
}
