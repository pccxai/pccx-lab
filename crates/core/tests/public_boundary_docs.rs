use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn read_repo_file(path: &str) -> String {
    let full = repo_root().join(path);
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("cannot read {}: {e}", full.display()))
}

fn public_boundary_text() -> String {
    [
        "README.md",
        "docs/CLI_CORE_BOUNDARY.md",
        "docs/DIAGNOSTICS_HANDOFF_CONSUMER.md",
        "docs/examples/launcher-diagnostics-handoff.example.json",
        "docs/examples/run-status.example.json",
        "docs/examples/theme-tokens.example.json",
        "docs/examples/workflow-descriptors.example.json",
    ]
    .into_iter()
    .map(read_repo_file)
    .collect::<Vec<_>>()
    .join("\n")
}

#[test]
fn public_boundary_docs_do_not_use_forbidden_clone_wording() {
    let text = public_boundary_text().to_lowercase();
    for phrase in [
        "jetbrains clone",
        "xcode clone",
        "ai ide",
        "vibe coding gui",
        "autonomous verification gui",
    ] {
        assert!(
            !text.contains(phrase),
            "public boundary docs contain forbidden wording: {phrase}"
        );
    }
}

#[test]
fn public_boundary_docs_do_not_claim_unsupported_runtime_state() {
    let text = public_boundary_text().to_lowercase();
    for phrase in [
        "production-ready gui",
        "full gui ready",
        "stable plugin abi is supported",
        "stable plugin abi is available",
        "mcp ready",
        "hardware inference ready",
        "kv260 inference works",
        "20 tok/s achieved",
        "timing closure achieved",
        "timing-closed bitstream is available",
    ] {
        assert!(
            !text.contains(phrase),
            "public boundary docs contain unsupported claim: {phrase}"
        );
    }
}

#[test]
fn public_boundary_docs_do_not_contain_private_paths_or_secrets() {
    let text = public_boundary_text();
    let lower = text.to_lowercase();
    for phrase in [
        "/home/",
        "sk-",
        "ghp_",
        "github_pat_",
        "private key",
        "begin rsa private key",
        "begin openSSH private key",
    ] {
        assert!(
            !lower.contains(&phrase.to_lowercase()),
            "public boundary docs contain private path or secret marker: {phrase}"
        );
    }
}

#[test]
fn gui_status_panel_consumes_core_status_without_runtime_side_effects() {
    let panel = read_repo_file("ui/src/LabStatusPanel.tsx");
    assert!(panel.contains("invoke<LabStatus>(\"lab_status\")"));
    assert!(panel.contains("invoke<ThemeTokenContract>(\"theme_contract\")"));
    assert!(panel.contains("invoke<WorkflowDescriptorSet>(\"workflow_descriptors\")"));

    for phrase in [
        "run_verification",
        "generate_uvm_sequence_cmd",
        "fetch(",
        "Command::new",
        "child_process",
        "openai",
        "pccx-llm-launcher",
    ] {
        assert!(
            !panel.to_lowercase().contains(&phrase.to_lowercase()),
            "GUI status panel must not add runtime side effect: {phrase}"
        );
    }
}

#[test]
fn gui_workflow_descriptors_are_display_only_core_data() {
    let panel = read_repo_file("ui/src/LabStatusPanel.tsx");
    assert!(panel.contains("workflowDescriptors.descriptors"));
    assert!(panel.contains("descriptor.label"));
    assert!(panel.contains("descriptor.category"));
    assert!(panel.contains("descriptor.availabilityState"));
    assert!(panel.contains("descriptor.executionState"));

    for phrase in [
        "pccx-lab workflows --format json",
        "SystemVerilog shape diagnostics",
        "pccx-lab analyze <file> --format json",
        "No MCP runtime is implemented.",
    ] {
        assert!(
            !panel.contains(phrase),
            "GUI must render workflow descriptors from IPC, not hardcode boundary text: {phrase}"
        );
    }
}

#[test]
fn gui_status_types_include_contract_fields() {
    let types = read_repo_file("ui/src/labStatus.ts");
    for field in [
        "schemaVersion",
        "workspaceState",
        "availableWorkflows",
        "pluginState",
        "guiState",
        "diagnosticsState",
        "evidenceState",
        "limitations",
        "ThemeTokenContract",
        "WorkflowDescriptorSet",
        "WorkflowDescriptor",
    ] {
        assert!(
            types.contains(field),
            "missing GUI status type field: {field}"
        );
    }
}
