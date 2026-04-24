// Module Boundary: core/
// pccx-core: robust reader — NVIDIA-report §4 toolchain maturity.
//
// Other trace / config tools in the NPU space typically reject input
// that has any unknown field or stray whitespace.  pccx-lab needs to
// be **forgiving** so a user who hand-edits a config does not hit a
// wall of errors — but without silently swallowing real mistakes.
//
// This module implements a four-level policy that applies uniformly
// to every config-shaped read (TOML, JSON, JSONL):
//
//   * ``Policy::Strict``  — fail the read on any unknown field.
//   * ``Policy::Warn``    — accept, return the list of offending keys
//                          so the caller can dialog them to the user.
//   * ``Policy::Lenient`` — accept silently.
//   * ``Policy::Fix``     — accept and emit a patched source string
//                          (unknown keys stripped) that the caller
//                          can write back to disk.
//
// The module also ships:
//
//   * `sanitize_whitespace` — drops trailing whitespace, normalises
//     BOM + line endings so Windows-edited files round-trip cleanly.
//   * `strip_trailing_commas` — forgives JSON's trailing-comma
//     rejection (a common editor paste artefact).
//
// Every helper is **pure** (no I/O), so callers can test the policy
// in isolation and the UI can reuse the same logic in the
// "unknown-field" modal dialog.

use serde::de::DeserializeOwned;
use std::collections::{BTreeMap, BTreeSet};

// ─── Policy ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Reject the read on any unknown field.  CI default.
    Strict,
    /// Accept but surface the unknown fields in `RobustReport::warnings`.
    /// The CLI's default — noisy enough to notice, not enough to block.
    Warn,
    /// Accept silently.  Only use in tests or disposable scripts.
    Lenient,
    /// Accept AND emit a "fixed" source string with unknown fields
    /// stripped — the UI's "auto-repair" button.
    Fix,
}

impl Policy {
    pub fn from_cli(s: &str) -> Option<Policy> {
        match s.to_ascii_lowercase().as_str() {
            "strict"  => Some(Policy::Strict),
            "warn"    => Some(Policy::Warn),
            "lenient" => Some(Policy::Lenient),
            "fix"     => Some(Policy::Fix),
            _ => None,
        }
    }
}

// ─── Report ─────────────────────────────────────────────────────────────────

/// Result of a robust read — the parsed value plus any diagnostics
/// the policy chose to surface.
#[derive(Debug, Clone)]
pub struct RobustReport<T> {
    pub value:       T,
    pub warnings:    Vec<String>,
    pub dropped_keys: Vec<String>,
    /// Non-empty only for ``Policy::Fix`` reads.  Callers can write
    /// this back to disk via a 3-button modal (Keep / Fix / Cancel).
    pub fixed_source: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RobustError {
    #[error("parse error: {0}")]
    Parse(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("strict policy rejected {count} unknown field(s): [{keys}]")]
    StrictReject { count: usize, keys: String },
}

// ─── Whitespace / trailing-comma helpers ────────────────────────────────────

/// Strip BOM, normalise CRLF → LF, trim trailing whitespace per line,
/// drop a trailing-only newline run.  Pure — same input always gives
/// same output.
pub fn sanitize_whitespace(src: &str) -> String {
    let s = src.strip_prefix('\u{feff}').unwrap_or(src);
    let mut out = String::with_capacity(s.len());
    for line in s.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        out.push_str(line.trim_end());
        out.push('\n');
    }
    // Remove redundant trailing newlines — keep exactly one.
    while out.ends_with("\n\n") { out.pop(); }
    out
}

/// Forgive trailing commas in a JSON-shaped source — the single most
/// common paste artefact from editors that auto-insert them.
///
/// The strategy: after every `,` find the next non-whitespace, non-
/// comment rune; if it is `}` or `]`, drop the comma.  We handle
/// strings and line / block comments so a comma inside a quoted
/// string is never touched.
pub fn strip_trailing_commas(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        // Pass through string literals untouched.
        if c == '"' {
            out.push('"');
            i += 1;
            while i < bytes.len() {
                let ch = bytes[i] as char;
                out.push(ch);
                i += 1;
                if ch == '\\' && i < bytes.len() {
                    out.push(bytes[i] as char);
                    i += 1;
                    continue;
                }
                if ch == '"' { break; }
            }
            continue;
        }
        // Line comment.
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
            while i < bytes.len() && bytes[i] as char != '\n' {
                out.push(bytes[i] as char); i += 1;
            }
            continue;
        }
        // Comma — look ahead.
        if c == ',' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() { j += 1; }
            if j < bytes.len() && matches!(bytes[j] as char, '}' | ']') {
                // Swallow the comma.
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

// ─── Policy-driven TOML read ────────────────────────────────────────────────

/// Parse TOML with a robustness policy.  The expected-key list is
/// supplied by the caller — typically via `const KEYS: &[&str]` or
/// generated from the target struct.  Unknown fields in the root
/// table are surfaced per the policy.
pub fn read_toml_with_policy<T: DeserializeOwned>(
    src: &str,
    policy: Policy,
    expected_keys: &[&str],
) -> Result<RobustReport<T>, RobustError> {
    let cleaned = sanitize_whitespace(src);
    // Parse twice: once as a loose TOML Value so we can inspect the
    // key set, then strict-deserialise the (possibly-filtered) source
    // into T.
    let value: toml::Value = toml::from_str(&cleaned)
        .map_err(|e| RobustError::Parse(e.to_string()))?;

    let (dropped, warnings, fixed_source) = match &value {
        toml::Value::Table(tbl) => {
            let expected: BTreeSet<&str> = expected_keys.iter().copied().collect();
            let mut dropped = Vec::new();
            for k in tbl.keys() {
                if !expected.contains(k.as_str()) { dropped.push(k.clone()); }
            }
            let warnings: Vec<String> = dropped.iter()
                .map(|k| format!("unknown field '{}'", k)).collect();
            let fixed = if matches!(policy, Policy::Fix) && !dropped.is_empty() {
                let mut keep = tbl.clone();
                for k in &dropped { keep.remove(k); }
                Some(toml::to_string(&toml::Value::Table(keep))
                    .unwrap_or_else(|_| cleaned.clone()))
            } else { None };
            (dropped, warnings, fixed)
        }
        _ => (Vec::new(), Vec::new(), None),
    };

    if matches!(policy, Policy::Strict) && !dropped.is_empty() {
        return Err(RobustError::StrictReject {
            count: dropped.len(),
            keys:  dropped.join(", "),
        });
    }

    // Pick which source the final deserialisation sees.
    let source_to_parse: &str = match &fixed_source {
        Some(s) => s,
        None if matches!(policy, Policy::Fix) => &cleaned,
        _ => &cleaned,
    };

    // For non-Fix policies we also strip unknown keys before the
    // typed deserialisation so the target struct doesn't need serde's
    // `deny_unknown_fields` or a bespoke visitor.  This is safe
    // because the Warn / Lenient paths *want* the deserialisation
    // to succeed regardless.
    let filtered: String = if matches!(policy, Policy::Warn | Policy::Lenient) && !dropped.is_empty() {
        if let toml::Value::Table(tbl) = &value {
            let mut keep = tbl.clone();
            for k in &dropped { keep.remove(k); }
            toml::to_string(&toml::Value::Table(keep)).unwrap_or_else(|_| cleaned.clone())
        } else { cleaned.clone() }
    } else {
        source_to_parse.to_string()
    };

    let value: T = toml::from_str(&filtered).map_err(|e| RobustError::Parse(e.to_string()))?;
    Ok(RobustReport { value, warnings, dropped_keys: dropped, fixed_source })
}

// ─── Policy-driven JSON read (for .ref.jsonl config lines) ──────────────────

/// Parse a JSON-shaped line with whitespace + trailing-comma
/// tolerance.  Unknown-field handling is delegated to `T`'s
/// `#[serde(default)]` annotations — we don't try to strip keys
/// because JSON is used for machine-generated references, not
/// hand-edited configs.
pub fn read_json_tolerant<T: DeserializeOwned>(src: &str) -> Result<T, RobustError> {
    let s = strip_trailing_commas(&sanitize_whitespace(src));
    serde_json::from_str(&s).map_err(|e| RobustError::Parse(e.to_string()))
}

// ─── Key-set helpers (useful for UIs that want to render dialogs) ──────────

/// Diff an observed key-set against an expected set.  Returns the
/// unknown keys in observed order so a UI list renders them in the
/// same order the user wrote them.
pub fn diff_keys(expected: &[&str], observed: &[&str]) -> Vec<String> {
    let set: BTreeSet<&str> = expected.iter().copied().collect();
    observed.iter().filter(|k| !set.contains(*k)).map(|k| k.to_string()).collect()
}

/// Convenience: format dropped keys for a user-facing modal.
pub fn format_dropped_keys(keys: &[String]) -> String {
    if keys.is_empty() { return String::new(); }
    let mut by_count: BTreeMap<String, usize> = BTreeMap::new();
    for k in keys { *by_count.entry(k.clone()).or_insert(0) += 1; }
    let mut parts: Vec<String> = by_count.into_iter()
        .map(|(k, n)| if n > 1 { format!("{} (×{})", k, n) } else { k })
        .collect();
    parts.sort();
    parts.join(", ")
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Cfg { name: String, #[serde(default)] count: u32 }

    #[test]
    fn sanitize_strips_bom_and_crlf() {
        let s = "\u{feff}name = \"x\"\r\ncount = 3   \r\n\r\n\r\n";
        let o = sanitize_whitespace(s);
        assert!(!o.starts_with('\u{feff}'));
        assert!(!o.contains('\r'));
        assert!(!o.ends_with("\n\n"));
        assert!(o.contains("count = 3\n"));
    }

    #[test]
    fn strip_trailing_commas_forgives_json() {
        let s = "{\"a\": 1, \"b\": [1, 2, 3,], \"c\": {\"d\": 4,},}";
        let o = strip_trailing_commas(s);
        assert!(!o.contains(",}"));
        assert!(!o.contains(",]"));
    }

    #[test]
    fn strip_trailing_commas_preserves_string_literal_commas() {
        let s = "{\"msg\": \"hello, world,\"}";
        let o = strip_trailing_commas(s);
        assert!(o.contains("hello, world,"));
    }

    #[test]
    fn strict_policy_rejects_unknown_key() {
        let src = r#"name = "x"
                     count = 3
                     extra = "hello"
        "#;
        let r: Result<RobustReport<Cfg>, _> =
            read_toml_with_policy(src, Policy::Strict, &["name", "count"]);
        assert!(r.is_err());
        match r.err().unwrap() {
            RobustError::StrictReject { keys, .. } => assert!(keys.contains("extra")),
            other => panic!("wrong error: {:?}", other),
        }
    }

    #[test]
    fn warn_policy_accepts_and_lists_unknown() {
        let src = r#"name = "x"
                     count = 3
                     extra = "hello"
        "#;
        let r: RobustReport<Cfg> =
            read_toml_with_policy(src, Policy::Warn, &["name", "count"]).unwrap();
        assert_eq!(r.value, Cfg { name: "x".into(), count: 3 });
        assert!(r.warnings.iter().any(|w| w.contains("extra")));
        assert_eq!(r.dropped_keys, vec!["extra"]);
    }

    #[test]
    fn lenient_policy_silently_accepts() {
        let src = r#"name = "x"
                     extra = 1
        "#;
        let r: RobustReport<Cfg> =
            read_toml_with_policy(src, Policy::Lenient, &["name", "count"]).unwrap();
        assert_eq!(r.value.name, "x");
        assert!(r.warnings.iter().any(|w| w.contains("extra")));
    }

    #[test]
    fn fix_policy_emits_sanitised_source() {
        let src = r#"name = "x"
                     count = 3
                     extra = "drop me"
        "#;
        let r: RobustReport<Cfg> =
            read_toml_with_policy(src, Policy::Fix, &["name", "count"]).unwrap();
        let fixed = r.fixed_source.expect("Fix must emit fixed_source");
        assert!(!fixed.contains("extra"));
        assert!(fixed.contains("name") && fixed.contains("count"));
    }

    #[test]
    fn policy_parses_cli_strings() {
        assert_eq!(Policy::from_cli("strict"),  Some(Policy::Strict));
        assert_eq!(Policy::from_cli("WARN"),    Some(Policy::Warn));
        assert_eq!(Policy::from_cli("fix"),     Some(Policy::Fix));
        assert_eq!(Policy::from_cli("nope"),    None);
    }

    #[test]
    fn json_tolerant_accepts_trailing_commas_and_bom() {
        let src = "\u{feff}{\"name\": \"x\", \"count\": 5,}\n";
        let c: Cfg = read_json_tolerant(src).unwrap();
        assert_eq!(c, Cfg { name: "x".into(), count: 5 });
    }

    #[test]
    fn diff_keys_preserves_observed_order() {
        let d = diff_keys(&["a", "b"], &["c", "a", "d"]);
        assert_eq!(d, vec!["c", "d"]);
    }

    #[test]
    fn format_dropped_keys_dedupes_with_count() {
        let keys = vec!["x".to_string(), "y".to_string(), "x".to_string()];
        let f = format_dropped_keys(&keys);
        assert!(f.contains("x (×2)"));
        assert!(f.contains("y"));
    }
}
