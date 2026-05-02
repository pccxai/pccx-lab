use std::path::{Path, PathBuf};

// Keep these phrases out of public surfaces even when a sentence is
// phrased negatively. The plugin ABI disclaimer has a narrow legacy
// allowance below because current status/docs already use that wording.
const FORBIDDEN_PUBLIC_CLAIMS: &[&str] = &[
    "production-ready",
    "production ready",
    "stable mcp",
    "stable mcp interface",
    "mcp ready",
    "ai ide",
    "autonomous verification",
    "vibe coding",
    "jetbrains clone",
    "xcode clone",
    "kv260 inference works",
    "20 tok/s achieved",
    "timing closed",
    "timing closure achieved",
    "timing-closed bitstream is available",
    "claude controls pccx-lab",
    "gpt controls pccx-lab",
    "openai api integration",
    "forwards requests to the openai api",
    "configure the api key",
    "20 tok/s on kv260",
    "gemma-3n e4b decoding at 20 tok/s",
    "rtl + bitstream + correctness proof",
];

const SAFE_STABLE_PLUGIN_ABI_MENTIONS: &[&str] = &["no stable plugin abi is promised"];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn read_repo_file(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn is_public_static_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("css" | "json" | "md" | "rst" | "ts" | "tsx")
    )
}

fn collect_public_static_files(root: &Path, dir: &Path, files: &mut Vec<PathBuf>) {
    let mut entries = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()));
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if relative.starts_with("docs/_build") || relative.starts_with("ui/node_modules") {
            continue;
        }

        if path.is_dir() {
            collect_public_static_files(root, &path, files);
        } else if is_public_static_file(&path) {
            files.push(path);
        }
    }
}

fn public_static_surfaces() -> Vec<(String, String)> {
    let root = repo_root();
    let mut files = vec![root.join("README.md")];
    collect_public_static_files(&root, &root.join("docs"), &mut files);
    collect_public_static_files(&root, &root.join("ui/src"), &mut files);
    files.sort();
    files.dedup();

    files
        .into_iter()
        .map(|path| {
            let label = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .display()
                .to_string();
            (label, read_repo_file(&path))
        })
        .collect()
}

fn public_core_json_contracts() -> Vec<(String, String)> {
    let runner_config = pccx_core::workflow_runner_config();
    vec![
        (
            "status".to_string(),
            pccx_core::lab_status_json_pretty().expect("status JSON must serialize"),
        ),
        (
            "theme".to_string(),
            pccx_core::theme_contract_json_pretty().expect("theme JSON must serialize"),
        ),
        (
            "workflow descriptors".to_string(),
            pccx_core::workflow_descriptors_json_pretty()
                .expect("workflow descriptor JSON must serialize"),
        ),
        (
            "workflow proposals".to_string(),
            pccx_core::workflow_proposals_json_pretty()
                .expect("workflow proposal JSON must serialize"),
        ),
        (
            "workflow results".to_string(),
            pccx_core::workflow_result_summaries_json_pretty()
                .expect("workflow result JSON must serialize"),
        ),
        (
            "workflow runner status".to_string(),
            pccx_core::workflow_runner_status_json_pretty(&runner_config)
                .expect("workflow runner status JSON must serialize"),
        ),
    ]
}

fn assert_no_forbidden_public_claims(label: &str, text: &str) {
    let lower = text.to_lowercase();
    for phrase in FORBIDDEN_PUBLIC_CLAIMS {
        assert!(
            !lower.contains(phrase),
            "{label} contains guarded public claim wording: {phrase}"
        );
    }
}

fn assert_stable_plugin_abi_mentions_are_negated(label: &str, text: &str) {
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("stable plugin abi") {
            assert!(
                SAFE_STABLE_PLUGIN_ABI_MENTIONS
                    .iter()
                    .any(|phrase| lower.contains(phrase)),
                "{label} contains a non-negated stable plugin ABI mention: {line}"
            );
        }
    }
}

#[test]
fn public_static_surfaces_do_not_use_guarded_claim_wording() {
    for (label, text) in public_static_surfaces() {
        assert_no_forbidden_public_claims(&label, &text);
        assert_stable_plugin_abi_mentions_are_negated(&label, &text);
    }
}

#[test]
fn public_core_json_contracts_do_not_use_guarded_claim_wording() {
    for (label, text) in public_core_json_contracts() {
        assert_no_forbidden_public_claims(&label, &text);
        assert_stable_plugin_abi_mentions_are_negated(&label, &text);
    }
}
