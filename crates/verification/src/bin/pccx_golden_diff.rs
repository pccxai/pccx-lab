//! pccx_golden_diff — end-to-end correctness gate (consultation report §6.2).
//!
//! ```text
//! pccx_golden_diff --emit-profile <trace.pccx> [--tolerance-pct N] > ref.jsonl
//! pccx_golden_diff --check ref.jsonl <trace.pccx> [--json]
//! ```
//!
//! The tool has two modes:
//!
//! * ``--emit-profile`` — self-calibration.  Loads a known-good trace,
//!   buckets it by API_CALL boundary, and writes a JSONL reference
//!   with the observed counts + a configurable tolerance.  The
//!   PyTorch / HuggingFace reference pipeline (forthcoming) will
//!   replace this with a semantically-grounded profile, but the
//!   on-disk schema is identical so neither end changes when that
//!   lands.
//! * ``--check`` — regression gate.  Loads a reference JSONL + a
//!   candidate trace, runs ``golden_diff::diff``, prints a one-line
//!   verdict + per-step metric table, and exits 1 if any step drifts
//!   outside its tolerance.
//!
//! The CLI intentionally has no other knobs — tolerances live on the
//! reference rows so the PyTorch side controls strictness without a
//! flag explosion here.

use pccx_core::pccx_format::PccxFile;
use pccx_core::trace::NpuTrace;
use pccx_verification::golden_diff;

use std::fs::File;
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let help = args.len() < 2 || args.iter().any(|a| a == "--help" || a == "-h");
    if help {
        eprintln!("\
usage:\n  \
  {bin} --emit-profile <trace.pccx> [--tolerance-pct N]\n  \
  {bin} --check <ref.jsonl> <trace.pccx> [--json]\n\
  \n\
flags:\n  \
  --emit-profile TRACE   self-calibrate: write a JSONL reference to stdout\n  \
  --tolerance-pct N      tolerance stamped onto every emitted row (default: 10)\n  \
  --check REF TRACE      regression gate: exits 1 on any drift\n  \
  --json                 machine-readable GoldenDiffReport instead of pretty output\n",
            bin = args[0]);
        return ExitCode::from(if help && args.len() < 2 { 2 } else { 0 });
    }

    // ── --emit-profile branch ──────────────────────────────────────
    if let Some(pos) = args.iter().position(|a| a == "--emit-profile") {
        let Some(path) = args.get(pos + 1) else {
            eprintln!("--emit-profile requires <trace.pccx>");
            return ExitCode::from(2);
        };
        let tolerance = args.iter().position(|a| a == "--tolerance-pct")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(10.0);
        let trace = match load_trace(path) {
            Ok(t) => t,
            Err(e) => { eprintln!("{e}"); return ExitCode::from(1); }
        };
        let profile = golden_diff::profile_from_trace(&trace, tolerance);
        print!("{}", golden_diff::profile_to_jsonl(&profile));
        return ExitCode::SUCCESS;
    }

    // ── --check branch ─────────────────────────────────────────────
    if let Some(pos) = args.iter().position(|a| a == "--check") {
        let Some(ref_path)   = args.get(pos + 1) else {
            eprintln!("--check requires <ref.jsonl> <trace.pccx>");
            return ExitCode::from(2);
        };
        let Some(trace_path) = args.get(pos + 2) else {
            eprintln!("--check requires <ref.jsonl> <trace.pccx>");
            return ExitCode::from(2);
        };
        let want_json = args.iter().any(|a| a == "--json");

        let mut src = String::new();
        if let Err(e) = File::open(ref_path)
            .and_then(|mut f| f.read_to_string(&mut src)) {
            eprintln!("cannot read '{}': {}", ref_path, e);
            return ExitCode::from(1);
        }
        let reference = match golden_diff::parse_reference_jsonl(&src) {
            Ok(r)  => r,
            Err(e) => { eprintln!("reference parse error: {}", e); return ExitCode::from(1); }
        };
        let trace = match load_trace(trace_path) {
            Ok(t) => t,
            Err(e) => { eprintln!("{e}"); return ExitCode::from(1); }
        };
        let report = golden_diff::diff(&trace, &reference);

        if want_json {
            match serde_json::to_string_pretty(&report) {
                Ok(s) => println!("{}", s),
                Err(e) => { eprintln!("json encode failed: {}", e); return ExitCode::from(1); }
            }
        } else {
            pretty_print(&report);
        }
        return if report.is_clean() { ExitCode::SUCCESS } else { ExitCode::from(1) };
    }

    eprintln!("specify --emit-profile or --check (see --help)");
    ExitCode::from(2)
}

fn load_trace(path: &str) -> Result<NpuTrace, String> {
    let mut f = File::open(path).map_err(|e| format!("cannot open '{}': {}", path, e))?;
    let p = PccxFile::read(&mut f).map_err(|e| format!("parse error in '{}': {}", path, e))?;
    NpuTrace::from_payload(&p.payload).map_err(|e| format!("decode error in '{}': {}", path, e))
}

fn pretty_print(r: &golden_diff::GoldenDiffReport) {
    println!("═══════════════════════════════════════════════════════════════════════");
    println!("  {}", r.summary);
    println!("═══════════════════════════════════════════════════════════════════════");
    for s in &r.steps {
        println!("{}", s.summary);
        if !s.is_pass {
            for m in &s.metrics {
                if !m.pass {
                    println!("    └─ {:<9} observed={} · expected={} · tol ±{:.1}%",
                        m.name, m.observed, m.expected, m.tolerance_pct);
                }
            }
        }
    }
}
