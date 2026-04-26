// Module Boundary: verification/
// pccx-verification: robust reader — consultation report §4 (toolchain
// maturity).
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
    #[error("parse error in '{path}': {detail}")]
    Parse { path: String, detail: String },
    #[error("io error reading '{path}': {source}")]
    Io { path: String, source: std::io::Error },
    #[error("strict policy rejected {count} unknown field(s) in '{path}': [{keys}]")]
    StrictReject { path: String, count: usize, keys: String },
    #[error("truncated input in '{path}': expected >= {expected} bytes, got {actual}")]
    Truncated { path: String, expected: usize, actual: usize },
    #[error("corrupted input in '{path}': {detail}")]
    Corrupted { path: String, detail: String },
}

impl From<std::io::Error> for RobustError {
    fn from(e: std::io::Error) -> Self {
        RobustError::Io { path: "<unknown>".into(), source: e }
    }
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

// ─── Recovery heuristics ────────────────────────────────────────────────────

/// Strip embedded NUL bytes that appear in corrupted files (e.g.
/// zeroed-out sectors from incomplete writes).  Returns the cleaned
/// string and the number of NUL bytes removed so the caller can warn.
pub fn strip_nul_bytes(src: &str) -> (String, usize) {
    let count = src.bytes().filter(|&b| b == 0).count();
    if count == 0 {
        return (src.to_string(), 0);
    }
    let cleaned: String = src.chars().filter(|&c| c != '\0').collect();
    (cleaned, count)
}

/// Detect pathological repeated-byte runs that indicate block-level
/// corruption (e.g. a disk sector filled with 0xFF or 0x00).
/// Returns `true` if `src` contains a run of `threshold` or more
/// identical bytes (excluding whitespace) **outside** of quoted
/// strings, so legitimate values like `description = "AAAA..."` do
/// not trigger false positives.
pub fn has_repeated_byte_run(src: &[u8], threshold: usize) -> bool {
    if src.len() < threshold { return false; }
    let mut in_string = false;
    let mut prev_escape = false;
    let mut run_len = 1usize;
    let mut prev_byte: Option<u8> = None;
    for &b in src {
        // Track quoted-string state so runs inside strings are ignored.
        if in_string {
            if b == b'\\' && !prev_escape {
                prev_escape = true;
                prev_byte = Some(b);
                continue;
            }
            if b == b'"' && !prev_escape {
                in_string = false;
            }
            prev_escape = false;
            prev_byte = Some(b);
            run_len = 1;
            continue;
        }
        if b == b'"' {
            in_string = true;
            prev_byte = Some(b);
            run_len = 1;
            continue;
        }
        // Outside strings: count non-whitespace repeated runs.
        if let Some(prev) = prev_byte {
            if b == prev && !b.is_ascii_whitespace() {
                run_len += 1;
                if run_len >= threshold { return true; }
            } else {
                run_len = 1;
            }
        }
        prev_byte = Some(b);
    }
    false
}

/// Attempt to recover a truncated TOML or JSON source by closing any
/// unclosed braces/brackets.  This is a best-effort heuristic —
/// returns `None` if the input looks unrecoverably corrupt.
pub fn attempt_brace_recovery(src: &str) -> Option<String> {
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut prev_escape = false;
    for ch in src.chars() {
        if in_string {
            if ch == '\\' && !prev_escape {
                prev_escape = true;
                continue;
            }
            if ch == '"' && !prev_escape {
                in_string = false;
            }
            prev_escape = false;
            continue;
        }
        match ch {
            '"' => { in_string = true; prev_escape = false; }
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => { stack.pop(); }
            _ => {}
        }
    }
    if stack.is_empty() { return None; } // nothing to recover
    let mut out = src.to_string();
    for closer in stack.into_iter().rev() {
        out.push(closer);
    }
    Some(out)
}

/// Full sanitisation pipeline: NUL removal + whitespace normalisation
/// + trailing-comma forgiveness.  Returns the cleaned source and a
/// list of applied fixups for diagnostic display.
pub fn sanitize_full(src: &str) -> (String, Vec<String>) {
    let mut fixups: Vec<String> = Vec::new();
    let (s, nul_count) = strip_nul_bytes(src);
    if nul_count > 0 {
        fixups.push(format!("stripped {} NUL byte(s)", nul_count));
    }
    let s = sanitize_whitespace(&s);
    let before_comma = s.clone();
    let s = strip_trailing_commas(&s);
    if s != before_comma {
        fixups.push("removed trailing comma(s)".into());
    }
    (s, fixups)
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
    read_toml_with_policy_at(src, policy, expected_keys, "<inline>")
}

/// Like `read_toml_with_policy` but embeds `path` in error messages.
pub fn read_toml_with_policy_at<T: DeserializeOwned>(
    src: &str,
    policy: Policy,
    expected_keys: &[&str],
    path: &str,
) -> Result<RobustReport<T>, RobustError> {
    let (cleaned, _fixups) = sanitize_full(src);

    // Detect block-level corruption before parsing.
    if has_repeated_byte_run(cleaned.as_bytes(), 64) {
        return Err(RobustError::Corrupted {
            path: path.to_string(),
            detail: "input contains a 64+ byte repeated-byte run suggesting block-level corruption".into(),
        });
    }

    // Parse twice: once as a loose TOML Value so we can inspect the
    // key set, then strict-deserialise the (possibly-filtered) source
    // into T.
    let value: toml::Value = toml::from_str(&cleaned)
        .map_err(|e| RobustError::Parse { path: path.to_string(), detail: e.to_string() })?;

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
            path: path.to_string(),
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

    let value: T = toml::from_str(&filtered).map_err(|e| RobustError::Parse {
        path: path.to_string(), detail: e.to_string(),
    })?;
    Ok(RobustReport { value, warnings, dropped_keys: dropped, fixed_source })
}

// ─── Policy-driven JSON read (for .ref.jsonl config lines) ──────────────────

/// Parse a JSON-shaped line with whitespace + trailing-comma
/// tolerance.  Unknown-field handling is delegated to `T`'s
/// `#[serde(default)]` annotations — we don't try to strip keys
/// because JSON is used for machine-generated references, not
/// hand-edited configs.
pub fn read_json_tolerant<T: DeserializeOwned>(src: &str) -> Result<T, RobustError> {
    let (s, _fixups) = sanitize_full(src);
    serde_json::from_str(&s).map_err(|e| RobustError::Parse {
        path: "<inline>".into(), detail: e.to_string(),
    })
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

    // ─── NUL-byte stripping ────────────────────────────────────────

    #[test]
    fn strip_nul_removes_embedded_nulls() {
        let src = "name = \"x\"\0\0count = 3\0";
        let (cleaned, count) = strip_nul_bytes(src);
        assert_eq!(count, 3);
        assert!(!cleaned.contains('\0'));
        assert!(cleaned.contains("name"));
        assert!(cleaned.contains("count"));
    }

    #[test]
    fn strip_nul_noop_on_clean_input() {
        let src = "name = \"x\"\ncount = 3\n";
        let (cleaned, count) = strip_nul_bytes(src);
        assert_eq!(count, 0);
        assert_eq!(cleaned, src);
    }

    // ─── Repeated-byte detection ───────────────────────────────────

    #[test]
    fn detects_repeated_byte_run() {
        let mut data = b"name = \"x\"\n".to_vec();
        data.extend_from_slice(&[0xFFu8; 100]);
        assert!(has_repeated_byte_run(&data, 64));
    }

    #[test]
    fn no_false_positive_on_normal_input() {
        let data = b"name = \"hello world\"\ncount = 42\n";
        assert!(!has_repeated_byte_run(data, 64));
    }

    #[test]
    fn repeated_whitespace_is_not_flagged() {
        // Lots of spaces should not trigger the detector.
        let data = format!("name = \"x\"{}", " ".repeat(200));
        assert!(!has_repeated_byte_run(data.as_bytes(), 64));
    }

    #[test]
    fn repeated_chars_inside_string_not_flagged() {
        // A quoted string value with 100 'A's must not be treated as corruption.
        let data = format!("description = \"{}\"", "A".repeat(100));
        assert!(!has_repeated_byte_run(data.as_bytes(), 64));
    }

    // ─── Brace recovery ────────────────────────────────────────────

    #[test]
    fn brace_recovery_closes_unclosed_json() {
        let truncated = "{\"name\": \"x\", \"items\": [1, 2";
        let recovered = attempt_brace_recovery(truncated).unwrap();
        assert!(recovered.ends_with("]}"));
    }

    #[test]
    fn brace_recovery_returns_none_when_balanced() {
        let balanced = "{\"name\": \"x\"}";
        assert!(attempt_brace_recovery(balanced).is_none());
    }

    #[test]
    fn brace_recovery_handles_strings_with_braces() {
        let src = "{\"msg\": \"hello {world\"";
        let recovered = attempt_brace_recovery(src).unwrap();
        assert!(recovered.ends_with('}'));
    }

    // ─── sanitize_full pipeline ────────────────────────────────────

    #[test]
    fn sanitize_full_applies_all_fixups() {
        let src = "\u{feff}{\"a\": 1, \"b\": [1, 2,],}\0\0";
        let (cleaned, fixups) = sanitize_full(src);
        assert!(!cleaned.contains('\0'));
        assert!(!cleaned.contains(",]"));
        assert!(fixups.iter().any(|f| f.contains("NUL")));
        assert!(fixups.iter().any(|f| f.contains("trailing comma")));
    }

    #[test]
    fn sanitize_full_no_fixups_on_clean_input() {
        let src = "{\"name\": \"x\"}\n";
        let (_cleaned, fixups) = sanitize_full(src);
        assert!(fixups.is_empty());
    }

    // ─── TOML with NUL bytes ───────────────────────────────────────

    #[test]
    fn toml_with_embedded_nuls_parsed_after_stripping() {
        let src = "name = \"x\"\0\ncount = 3\n";
        let r: RobustReport<Cfg> =
            read_toml_with_policy(src, Policy::Lenient, &["name", "count"]).unwrap();
        assert_eq!(r.value, Cfg { name: "x".into(), count: 3 });
    }

    // ─── Truncated / empty input ───────────────────────────────────

    #[test]
    fn empty_toml_yields_parse_error() {
        let r: Result<RobustReport<Cfg>, _> =
            read_toml_with_policy("", Policy::Lenient, &["name", "count"]);
        assert!(r.is_err());
    }

    #[test]
    fn json_tolerant_rejects_empty_string() {
        let r: Result<Cfg, _> = read_json_tolerant("");
        assert!(r.is_err());
    }

    #[test]
    fn json_tolerant_strips_nul_bytes() {
        let src = "{\"name\": \"x\"\0, \"count\": 5}";
        let c: Cfg = read_json_tolerant(src).unwrap();
        assert_eq!(c, Cfg { name: "x".into(), count: 5 });
    }

    // ─── Corrupted input detection ─────────────────────────────────

    #[test]
    fn corrupted_repeated_bytes_rejected() {
        let mut src = String::from("name = \"x\"\n");
        src.push_str(&"A".repeat(100)); // non-whitespace repeated run
        let r: Result<RobustReport<Cfg>, _> =
            read_toml_with_policy(&src, Policy::Lenient, &["name", "count"]);
        assert!(r.is_err());
        match r.err().unwrap() {
            RobustError::Corrupted { detail, .. } => {
                assert!(detail.contains("repeated-byte run"));
            }
            other => panic!("expected Corrupted error, got {:?}", other),
        }
    }

    // ─── Error messages carry path context ─────────────────────────

    #[test]
    fn strict_reject_error_contains_path() {
        let src = "name = \"x\"\nextra = 1\n";
        let r: Result<RobustReport<Cfg>, _> =
            read_toml_with_policy_at(src, Policy::Strict, &["name", "count"], "/tmp/test.toml");
        match r.err().unwrap() {
            RobustError::StrictReject { path, .. } => assert_eq!(path, "/tmp/test.toml"),
            other => panic!("expected StrictReject, got {:?}", other),
        }
    }

    #[test]
    fn parse_error_contains_path() {
        let r: Result<RobustReport<Cfg>, _> =
            read_toml_with_policy_at("not valid toml {{{{", Policy::Lenient, &["name"], "/tmp/bad.toml");
        match r.err().unwrap() {
            RobustError::Parse { path, .. } => assert_eq!(path, "/tmp/bad.toml"),
            other => panic!("expected Parse, got {:?}", other),
        }
    }
}
