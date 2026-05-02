// status_cli — end-to-end CLI tests for `pccx-lab status`.
//
// Invokes the built binary and checks JSON output + exit codes.
// No external deps: uses std::process::Command + env!("CARGO_BIN_EXE_pccx-lab").

use std::collections::HashSet;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pccx-lab"))
}

#[test]
fn status_exits_zero() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    assert_eq!(out.status.code(), Some(0), "expected exit 0 for status");
}

#[test]
fn status_emits_valid_json() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(parsed["schemaVersion"], "pccx.lab.status.v0");
    assert_eq!(parsed["tool"], "pccx-lab");
}

#[test]
fn status_format_json_flag_accepted() {
    let out = bin()
        .args(["status", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab status --format json");

    assert_eq!(
        out.status.code(),
        Some(0),
        "expected exit 0 with --format json"
    );

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON with --format json");

    assert_eq!(parsed["schemaVersion"], "pccx.lab.status.v0");
}

#[test]
fn status_unsupported_format_exits_two() {
    let out = bin()
        .args(["status", "--format", "text"])
        .output()
        .expect("failed to run pccx-lab status --format text");

    assert_eq!(
        out.status.code(),
        Some(2),
        "expected exit 2 for unsupported format"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("unsupported format"),
        "expected 'unsupported format' in stderr, got: {stderr}"
    );
}

#[test]
fn status_version_matches_cargo_version() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(
        parsed["version"].as_str().unwrap_or(""),
        env!("CARGO_PKG_VERSION"),
        "status version must match CARGO_PKG_VERSION"
    );
}

#[test]
fn status_mode_is_cli_first_gui_foundation() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(parsed["labMode"], "cli-first-gui-foundation");
}

#[test]
fn status_workspace_does_not_probe_or_load() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(
        parsed["workspaceState"]["traceLoaded"].as_bool(),
        Some(false),
        "status must not imply a GUI trace load"
    );
    assert_eq!(parsed["workspaceState"]["source"], "static-core-status");
}

#[test]
fn status_evidence_is_not_claimed() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(
        parsed["evidenceState"]["inference"].as_str().unwrap_or(""),
        "not-claimed",
        "status must not claim inference"
    );
    assert_eq!(
        parsed["evidenceState"]["timingClosure"]
            .as_str()
            .unwrap_or(""),
        "not-claimed",
        "status must not claim timing closure"
    );
}

#[test]
fn status_has_diagnostics_boundary() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(
        parsed["diagnosticsState"]["status"].as_str().unwrap_or(""),
        "early-scaffold",
        "diagnosticsState.status must stay conservative"
    );
    assert_eq!(
        parsed["diagnosticsState"]["command"].as_str().unwrap_or(""),
        "pccx-lab analyze <file> --format json"
    );
}

#[test]
fn status_plugin_state_has_no_stable_abi() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    assert_eq!(
        parsed["pluginState"]["stableAbi"].as_bool(),
        Some(false),
        "status must not promise a stable plugin ABI"
    );
}

#[test]
fn status_output_is_deterministic() {
    let first = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");
    let second = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    assert_eq!(first.status.code(), Some(0));
    assert_eq!(second.status.code(), Some(0));
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn status_lists_theme_presets() {
    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is not valid JSON");

    let presets = parsed["guiState"]["themePresets"]
        .as_array()
        .expect("themePresets must be an array");
    let names: Vec<&str> = presets.iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(
        names,
        vec!["native-light", "native-dark", "compact-dark", "quiet-light"]
    );
}

// Drift-prevention: output keys must match the example JSON keys.
// If the struct gains or loses a field, this test will catch the mismatch.
#[test]
fn status_keys_match_example_json() {
    use std::path::Path;

    let example_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs/examples/run-status.example.json");

    let example_text = std::fs::read_to_string(&example_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", example_path.display()));
    let example: serde_json::Value =
        serde_json::from_str(&example_text).expect("example JSON is not valid");

    let example_keys: HashSet<&str> = example
        .as_object()
        .expect("example JSON must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    let out = bin()
        .arg("status")
        .output()
        .expect("failed to run pccx-lab status");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let live: serde_json::Value =
        serde_json::from_str(&stdout).expect("status stdout is not valid JSON");

    let live_keys: HashSet<&str> = live
        .as_object()
        .expect("status stdout must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    assert_eq!(
        live_keys,
        example_keys,
        "live status keys differ from example JSON.\n  live only: {:?}\n  example only: {:?}",
        live_keys.difference(&example_keys).collect::<Vec<_>>(),
        example_keys.difference(&live_keys).collect::<Vec<_>>(),
    );
}

#[test]
fn theme_command_emits_theme_contract() {
    let out = bin()
        .args(["theme", "--format", "json"])
        .output()
        .expect("failed to run pccx-lab theme --format json");

    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("theme stdout is not valid JSON");

    assert_eq!(parsed["schemaVersion"], "pccx.lab.theme-tokens.v0");
    assert_eq!(
        parsed["tokenSlots"].as_array().map(Vec::len),
        Some(9),
        "theme contract must expose the minimal token slots"
    );
    assert_eq!(
        parsed["presets"].as_array().map(Vec::len),
        Some(4),
        "theme contract must expose the four named presets"
    );
}

#[test]
fn theme_keys_match_example_json() {
    use std::path::Path;

    let example_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs/examples/theme-tokens.example.json");

    let example_text = std::fs::read_to_string(&example_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", example_path.display()));
    let example: serde_json::Value =
        serde_json::from_str(&example_text).expect("theme example JSON is not valid");

    let example_keys: HashSet<&str> = example
        .as_object()
        .expect("theme example JSON must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    let out = bin()
        .arg("theme")
        .output()
        .expect("failed to run pccx-lab theme");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let live: serde_json::Value =
        serde_json::from_str(&stdout).expect("theme stdout is not valid JSON");

    let live_keys: HashSet<&str> = live
        .as_object()
        .expect("theme stdout must be an object")
        .keys()
        .map(String::as_str)
        .collect();

    assert_eq!(
        live_keys,
        example_keys,
        "live theme keys differ from example JSON.\n  live only: {:?}\n  example only: {:?}",
        live_keys.difference(&example_keys).collect::<Vec<_>>(),
        example_keys.difference(&live_keys).collect::<Vec<_>>(),
    );
}
