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
        "docs/examples/workflow-proposals.example.json",
        "docs/examples/workflow-results.example.json",
        "docs/examples/workflow-runner-blocked.example.json",
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
    assert!(panel.contains("invoke<WorkflowProposalSet>(\"workflow_proposals\")"));
    assert!(panel.contains("invoke<WorkflowResultSummarySet>(\"workflow_result_summaries\")"));
    assert!(panel.contains("invoke<WorkflowRunnerStatus>(\"workflow_runner_status\")"));

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
fn gui_workflow_proposals_are_display_only_core_data() {
    let panel = read_repo_file("ui/src/LabStatusPanel.tsx");
    assert!(panel.contains("workflowProposals.proposals"));
    assert!(panel.contains("proposal.label"));
    assert!(panel.contains("proposal.proposalState"));
    assert!(panel.contains("proposal.approvalRequired"));
    assert!(panel.contains("proposal.commandKind"));
    assert!(panel.contains("proposal.inputSummary"));

    for phrase in [
        "pccx-lab workflow-proposals --format json",
        "workflow-proposals",
        "Preview SystemVerilog shape diagnostics",
        "analyze <approved-file>",
    ] {
        assert!(
            !panel.contains(phrase),
            "GUI must render workflow proposals from IPC, not hardcode proposal text: {phrase}"
        );
    }
}

#[test]
fn gui_workflow_runner_status_is_display_only_core_data() {
    let panel = read_repo_file("ui/src/LabStatusPanel.tsx");
    assert!(panel.contains("workflowRunner.schemaVersion"));
    assert!(panel.contains("workflowRunner.mode"));
    assert!(panel.contains("workflowRunner.enabled"));
    assert!(panel.contains("workflowRunner.timeoutMs"));
    assert!(panel.contains("workflowRunner.maxOutputLines"));
    assert!(panel.contains("workflowRunner.allowlistedProposalIds"));

    for phrase in [
        "run-approved-workflow",
        "--runner-enabled",
        "proposal-lab-status-contract",
        "workflowRunner.enabled=false",
    ] {
        assert!(
            !panel.contains(phrase),
            "GUI must render runner status from IPC, not hardcode runner text: {phrase}"
        );
    }
}

#[test]
fn gui_workflow_results_are_summary_only_core_data() {
    let panel = read_repo_file("ui/src/LabStatusPanel.tsx");
    assert!(panel.contains("workflowResults.summaries"));
    assert!(panel.contains("summary.workflowId"));
    assert!(panel.contains("summary.status"));
    assert!(panel.contains("summary.summary"));
    assert!(panel.contains("summary.truncated"));
    assert!(panel.contains("summary.redactionApplied"));

    for phrase in [
        "workflow-results",
        "pccx-lab workflow-results --format json",
        "stdoutLines",
        "stderrLines",
        "LOG_LINE_SHOULD_NOT_APPEAR",
    ] {
        assert!(
            !panel.contains(phrase),
            "GUI must render workflow results from IPC without hardcoded logs or command text: {phrase}"
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
        "WorkflowProposalSet",
        "WorkflowProposal",
        "WorkflowRunnerStatus",
        "WorkflowResultSummarySet",
        "WorkflowResultSummary",
    ] {
        assert!(
            types.contains(field),
            "missing GUI status type field: {field}"
        );
    }
}
