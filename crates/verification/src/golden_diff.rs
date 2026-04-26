// Module Boundary: verification/
// pccx-verification: golden-model diff — end-to-end correctness gate
// (consultation report §6.2).
//
// Compares a trace (xsim-captured or generator-synthesised) against a
// **reference profile** that says, per decode step, how many
// MAC_COMPUTE / DMA_READ / DMA_WRITE events the hardware SHOULD have
// emitted and inside what cycle budget.  Intended as the pluggable
// back-end the eventual PyTorch / HuggingFace reference pipeline
// feeds: each row of `RefProfile` becomes one line of a `.jsonl`
// emitted by `tools/pytorch_reference.py` (not yet landed).
//
// The diff is deterministic and framework-free — pure `serde_json`
// over a stable schema so a CI comparison reports identical numbers
// across machines.  Tolerances live on the reference row so the
// PyTorch side controls how strict the gate is.

use pccx_core::trace::NpuTrace;

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

// ─── Schema ─────────────────────────────────────────────────────────────────

/// One decode-step (or one prefill-step) expectation.  A reference
/// file is a JSONL stream of these rows, one per token boundary.
///
/// `step` is a 0-indexed counter along the decode axis.  `api_name`
/// matches the tag the driver emits on the API_CALL event that
/// bookends this step (e.g. `"uca_iter_0"`).
///
/// `cycle_budget` is the maximum number of cycles the step may run
/// before the diff flags a regression; `cycle_tolerance_pct` allows
/// small drift without noise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RefProfileRow {
    pub step:              u32,
    #[serde(default)]
    pub api_name:          Option<String>,
    #[serde(default)]
    pub expect_mac:        u64,
    #[serde(default)]
    pub expect_dma_read:   u64,
    #[serde(default)]
    pub expect_dma_write:  u64,
    #[serde(default)]
    pub expect_barrier:    u64,
    /// Upper bound on this step's wall-clock cycles (inclusive).
    #[serde(default)]
    pub cycle_budget:      u64,
    /// Allowable drift on `cycle_budget` and every `expect_*` count.
    /// Default = 10 % if unspecified.
    #[serde(default = "default_tolerance")]
    pub tolerance_pct:     f64,
    /// Optional absolute tolerance.  When set, a metric passes if the
    /// observed value is within `±abs_tolerance` of the expected value
    /// OR within `tolerance_pct` — whichever is more permissive.
    #[serde(default)]
    pub abs_tolerance:     Option<u64>,
}

fn default_tolerance() -> f64 { 10.0 }

/// Diff result for a single step.  `is_pass` is the bottom line the
/// CLI uses to decide its exit code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepDiff {
    pub step:               u32,
    pub is_pass:            bool,
    /// Human-readable one-liner — surfaces in the CLI.
    pub summary:            String,
    /// Per-metric `(observed, expected, tolerance_pct, pass)` rows.
    pub metrics:            Vec<MetricDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricDiff {
    pub name:           String,
    pub observed:       i64,
    pub expected:       i64,
    pub tolerance_pct:  f64,
    pub pass:           bool,
}

impl fmt::Display for MetricDiff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verdict = if self.pass { "PASS" } else { "FAIL" };
        write!(
            f,
            "{:<9} observed={} expected={} tol=+-{:.1}% [{}]",
            self.name, self.observed, self.expected, self.tolerance_pct, verdict,
        )
    }
}

impl fmt::Display for StepDiff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{}", self.summary)?;
        for m in &self.metrics {
            if !m.pass {
                writeln!(f, "    {}", m)?;
            }
        }
        Ok(())
    }
}

/// Top-level diff result — aggregates every step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldenDiffReport {
    /// Total number of reference steps.
    pub step_count:          u32,
    /// Number that passed every metric under the configured tolerance.
    pub pass_count:          u32,
    /// Per-step detail.
    pub steps:               Vec<StepDiff>,
    /// Summary sentence — feeds the CLI / UI card.
    pub summary:             String,
    /// Total individual metric comparisons performed.
    #[serde(default)]
    pub total_metrics:       u32,
    /// Metrics that passed with observed == expected (exact match).
    #[serde(default)]
    pub exact_matches:       u32,
    /// Metrics that passed but observed != expected (within tolerance).
    #[serde(default)]
    pub tolerance_passes:    u32,
    /// Metrics that failed (outside tolerance).
    #[serde(default)]
    pub metric_mismatches:   u32,
}

impl GoldenDiffReport {
    pub fn is_clean(&self) -> bool { self.pass_count == self.step_count }
}

impl fmt::Display for GoldenDiffReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{}", self.summary)?;
        writeln!(
            f,
            "metrics: {} total, {} exact, {} tolerance, {} mismatch",
            self.total_metrics, self.exact_matches,
            self.tolerance_passes, self.metric_mismatches,
        )?;
        for step in &self.steps {
            write!(f, "{}", step)?;
        }
        Ok(())
    }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum GoldenDiffError {
    #[error("io error reading '{path}': {source}")]
    Io { path: String, source: std::io::Error },
    #[error("json parse error at {path}:{line}: {source}")]
    Parse { path: String, line: usize, source: serde_json::Error },
    #[error("empty reference file: {path}")]
    Empty { path: String },
}

impl From<std::io::Error> for GoldenDiffError {
    fn from(e: std::io::Error) -> Self {
        GoldenDiffError::Io { path: "<unknown>".into(), source: e }
    }
}

// ─── Loading ────────────────────────────────────────────────────────────────

/// Parse a JSONL reference file — one `RefProfileRow` per non-blank,
/// non-`#`-comment line.  Empty / comment lines are skipped so the
/// file can carry annotations.
pub fn parse_reference_jsonl(src: &str) -> Result<Vec<RefProfileRow>, GoldenDiffError> {
    parse_reference_jsonl_inner(src, "<inline>")
}

/// Like `parse_reference_jsonl` but reads from a file path, embedding
/// the path in any error messages for better diagnostics.
pub fn parse_reference_jsonl_at_path(path: &Path) -> Result<Vec<RefProfileRow>, GoldenDiffError> {
    let display = path.display().to_string();
    let src = std::fs::read_to_string(path)
        .map_err(|e| GoldenDiffError::Io { path: display.clone(), source: e })?;
    parse_reference_jsonl_inner(&src, &display)
}

// Shared parser with configurable path label for error context.
fn parse_reference_jsonl_inner(src: &str, path: &str) -> Result<Vec<RefProfileRow>, GoldenDiffError> {
    let mut out = Vec::new();
    for (i, line) in src.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        match serde_json::from_str::<RefProfileRow>(trimmed) {
            Ok(row)  => out.push(row),
            Err(e)   => return Err(GoldenDiffError::Parse {
                path: path.to_string(),
                line: i + 1,
                source: e,
            }),
        }
    }
    if out.is_empty() {
        return Err(GoldenDiffError::Empty { path: path.to_string() });
    }
    Ok(out)
}

// ─── Trace bucketisation ────────────────────────────────────────────────────

/// Bucket the trace's events by API_CALL boundaries.  Every API_CALL
/// starts a new step; events between one API_CALL and the next are
/// attributed to the earlier step.  Events before the first API_CALL
/// land in step 0 (so prefill captures without API markers still get
/// a single bucket).
pub fn bucketise(trace: &NpuTrace) -> Vec<TraceStep> {
    let mut steps: Vec<TraceStep> = Vec::new();
    let mut current = TraceStep::default();
    current.step = 0;
    for ev in &trace.events {
        if ev.event_type == "API_CALL" {
            if !current.is_empty() || !steps.is_empty() {
                steps.push(current);
                current = TraceStep {
                    step:      (steps.len() as u32),
                    api_name:  ev.api_name.clone(),
                    first_cy:  ev.start_cycle.get(),
                    last_cy:   ev.start_cycle.get() + ev.duration.get(),
                    ..Default::default()
                };
            } else {
                current.api_name = ev.api_name.clone();
                current.first_cy = ev.start_cycle.get();
                current.last_cy  = ev.start_cycle.get() + ev.duration.get();
            }
            continue;
        }
        current.accumulate(ev);
    }
    if !current.is_empty() { steps.push(current); }
    steps
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct TraceStep {
    pub step:       u32,
    pub api_name:   Option<String>,
    pub first_cy:   u64,
    pub last_cy:    u64,
    pub mac:        u64,
    pub dma_read:   u64,
    pub dma_write:  u64,
    pub barrier:    u64,
    pub stall:      u64,
}

impl TraceStep {
    fn is_empty(&self) -> bool {
        self.mac == 0 && self.dma_read == 0 && self.dma_write == 0 &&
        self.barrier == 0 && self.stall == 0 && self.api_name.is_none()
    }
    fn accumulate(&mut self, ev: &pccx_core::trace::NpuEvent) {
        let end = ev.start_cycle.get() + ev.duration.get();
        // "Never accumulated anything" if no counter is set AND the
        // caller hasn't pre-seeded the span on an API_CALL boundary.
        let had_events =
            self.mac + self.dma_read + self.dma_write + self.barrier + self.stall > 0
            || self.last_cy > 0;
        if !had_events {
            self.first_cy = ev.start_cycle.get();
            self.last_cy  = end;
        } else {
            if ev.start_cycle.get() < self.first_cy { self.first_cy = ev.start_cycle.get(); }
            if end                  > self.last_cy   { self.last_cy   = end; }
        }
        match ev.event_type.as_str() {
            "MAC_COMPUTE"    => self.mac       += 1,
            "DMA_READ"       => self.dma_read  += 1,
            "DMA_WRITE"      => self.dma_write += 1,
            "BARRIER_SYNC"   => self.barrier   += 1,
            "SYSTOLIC_STALL" => self.stall     += 1,
            _ => {}
        }
    }
    /// Cycle budget the step actually consumed.
    pub fn cycles(&self) -> u64 {
        self.last_cy.saturating_sub(self.first_cy)
    }
}

// ─── Diff kernel ────────────────────────────────────────────────────────────

/// Check whether `observed` is within tolerance of `expected`.
/// Passes if EITHER percentage-based OR absolute tolerance is satisfied.
fn check(observed: i64, expected: i64, tolerance_pct: f64, abs_tol: Option<u64>) -> bool {
    // Percentage check.
    let pct_pass = if expected == 0 {
        observed == 0
    } else {
        let drift = (observed - expected).abs() as f64;
        let allowed = (expected as f64).abs() * tolerance_pct / 100.0;
        drift <= allowed
    };
    if pct_pass { return true; }
    // Absolute tolerance fallback — when set, permits ±N drift
    // regardless of the percentage-based gate.
    if let Some(abs) = abs_tol {
        let drift = (observed - expected).unsigned_abs();
        return drift <= abs;
    }
    false
}

pub fn diff(trace: &NpuTrace, reference: &[RefProfileRow]) -> GoldenDiffReport {
    let buckets = bucketise(trace);
    let mut out = Vec::with_capacity(reference.len());
    let mut pass = 0u32;

    // Metric-level aggregate counters.
    let mut total_metrics: u32 = 0;
    let mut exact_matches: u32 = 0;
    let mut tolerance_passes: u32 = 0;
    let mut metric_mismatches: u32 = 0;

    for row in reference {
        let obs = buckets.iter().find(|b| b.step == row.step);
        let (mac, dma_r, dma_w, barrier, cycles) = match obs {
            Some(b) => (b.mac as i64, b.dma_read as i64, b.dma_write as i64,
                        b.barrier as i64, b.cycles() as i64),
            None    => (0, 0, 0, 0, 0),
        };
        let abs_tol = row.abs_tolerance;
        let mut metrics = vec![
            mk_metric("mac",       mac,       row.expect_mac as i64,        row.tolerance_pct, abs_tol),
            mk_metric("dma_read",  dma_r,     row.expect_dma_read as i64,   row.tolerance_pct, abs_tol),
            mk_metric("dma_write", dma_w,     row.expect_dma_write as i64,  row.tolerance_pct, abs_tol),
            mk_metric("barrier",   barrier,   row.expect_barrier as i64,    row.tolerance_pct, abs_tol),
        ];
        if row.cycle_budget > 0 {
            metrics.push(mk_metric("cycles", cycles, row.cycle_budget as i64, row.tolerance_pct, abs_tol));
        }
        // Accumulate per-metric statistics.
        for m in &metrics {
            total_metrics += 1;
            if m.pass {
                if m.observed == m.expected {
                    exact_matches += 1;
                } else {
                    tolerance_passes += 1;
                }
            } else {
                metric_mismatches += 1;
            }
        }
        let step_pass = metrics.iter().all(|m| m.pass);
        if step_pass { pass += 1; }
        let summary = if step_pass {
            format!("step {:>3} pass", row.step)
        } else {
            let bad: Vec<&str> = metrics.iter().filter(|m| !m.pass).map(|m| m.name.as_str()).collect();
            format!("step {:>3} drift on [{}]", row.step, bad.join(", "))
        };
        out.push(StepDiff { step: row.step, is_pass: step_pass, summary, metrics });
    }

    let total = reference.len() as u32;
    let summary = if pass == total {
        format!("golden-diff: all {} steps within tolerance", total)
    } else {
        format!("golden-diff: {} / {} steps PASS — {} regressed", pass, total, total - pass)
    };
    GoldenDiffReport {
        step_count: total, pass_count: pass, steps: out, summary,
        total_metrics, exact_matches, tolerance_passes, metric_mismatches,
    }
}

fn mk_metric(name: &str, observed: i64, expected: i64, tolerance_pct: f64, abs_tol: Option<u64>) -> MetricDiff {
    MetricDiff {
        name:          name.to_string(),
        observed,
        expected,
        tolerance_pct,
        pass:          check(observed, expected, tolerance_pct, abs_tol),
    }
}

// ─── Reference generator (self-calibration) ─────────────────────────────────

/// Emit a reference profile from a known-good trace.  Useful for
/// bootstrapping: capture a golden run once, serialise it with this,
/// then gate future CI runs against the emitted JSONL.  The PyTorch
/// reference pipeline will eventually replace this with semantically-
/// grounded expectations, but the schema is identical.
pub fn profile_from_trace(trace: &NpuTrace, tolerance_pct: f64) -> Vec<RefProfileRow> {
    let buckets = bucketise(trace);
    buckets.into_iter().map(|b| {
        let cycles = b.cycles();
        RefProfileRow {
            step:             b.step,
            api_name:         b.api_name,
            expect_mac:       b.mac,
            expect_dma_read:  b.dma_read,
            expect_dma_write: b.dma_write,
            expect_barrier:   b.barrier,
            // Cycle budget = observed + tolerance (rounded up), so a
            // freshly-emitted profile is guaranteed to pass against
            // its own source trace.  Always at least 1 to avoid a 0
            // budget for empty steps.
            cycle_budget:     (cycles as f64 * (1.0 + tolerance_pct / 100.0)).ceil().max(1.0) as u64,
            tolerance_pct,
            abs_tolerance:    None,
        }
    }).collect()
}

/// Serialise a profile to a JSONL string — one row per line, trailing
/// newline.  Round-trips via `parse_reference_jsonl`.
pub fn profile_to_jsonl(rows: &[RefProfileRow]) -> String {
    let mut out = String::with_capacity(rows.len() * 120);
    out.push_str("# pccx-lab golden-diff reference (auto-generated).\n");
    out.push_str("# One JSON row per decode step — edit tolerance_pct to tighten the gate.\n");
    for r in rows {
        let line = serde_json::to_string(r).unwrap_or_default();
        out.push_str(&line);
        out.push('\n');
    }
    out
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use pccx_core::trace::{NpuEvent, NpuTrace};

    fn mk_trace() -> NpuTrace {
        let mut events = Vec::new();
        // Step 0 — two MAC + one DMA_READ before any API_CALL.
        events.push(NpuEvent::new(0,   0, 100, "MAC_COMPUTE"));
        events.push(NpuEvent::new(0, 100, 100, "MAC_COMPUTE"));
        events.push(NpuEvent::new(0, 200,  50, "DMA_READ"));
        events.push(NpuEvent::api_call(0, 250, 5, "uca_iter_0"));
        // Step 1 — three MAC + one DMA_WRITE.
        events.push(NpuEvent::new(0, 300, 100, "MAC_COMPUTE"));
        events.push(NpuEvent::new(0, 400, 100, "MAC_COMPUTE"));
        events.push(NpuEvent::new(0, 500, 100, "MAC_COMPUTE"));
        events.push(NpuEvent::new(0, 600,  50, "DMA_WRITE"));
        events.push(NpuEvent::api_call(0, 650, 5, "uca_iter_1"));
        // Step 2 — one stall, then done.
        events.push(NpuEvent::new(0, 700, 50, "SYSTOLIC_STALL"));
        NpuTrace { total_cycles: 800, events }
    }

    #[test]
    fn bucketise_splits_on_api_call() {
        let t = mk_trace();
        let b = bucketise(&t);
        assert_eq!(b.len(), 3, "expected 3 buckets, got {}: {:?}", b.len(), b);
        assert_eq!(b[0].mac, 2);
        assert_eq!(b[0].dma_read, 1);
        assert_eq!(b[1].mac, 3);
        assert_eq!(b[1].dma_write, 1);
        assert_eq!(b[2].stall, 1);
    }

    #[test]
    fn self_diff_is_clean() {
        let t  = mk_trace();
        let rp = profile_from_trace(&t, 10.0);
        let rep = diff(&t, &rp);
        assert!(rep.is_clean(), "self-diff should pass: {}", rep.summary);
        assert_eq!(rep.step_count, rep.pass_count);
    }

    #[test]
    fn regression_trips_the_gate() {
        let t = mk_trace();
        // Tight reference that expects 10 MAC at step 0 — trace has 2.
        let tight = vec![RefProfileRow {
            step: 0, api_name: Some("uca_iter_0".into()),
            expect_mac: 10, expect_dma_read: 0, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 0, tolerance_pct: 10.0, abs_tolerance: None,
        }];
        let rep = diff(&t, &tight);
        assert!(!rep.is_clean());
        assert!(rep.summary.contains("regressed"), "got: {}", rep.summary);
    }

    #[test]
    fn parse_jsonl_round_trips() {
        let t    = mk_trace();
        let rows = profile_from_trace(&t, 10.0);
        let s    = profile_to_jsonl(&rows);
        let back = parse_reference_jsonl(&s).unwrap();
        assert_eq!(back.len(), rows.len());
    }

    #[test]
    fn comment_lines_are_skipped() {
        let s = "# header\n{\"step\":0,\"expect_mac\":1}\n\n# tail\n";
        let r = parse_reference_jsonl(s).unwrap();
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn tolerance_allows_small_drift() {
        let t = mk_trace();
        // Expect 2 MAC with 60 % tolerance — observed=2, still passes.
        // Expect 100 cycles with 60 % tolerance — observed=250, fails.
        let rows = vec![RefProfileRow {
            step: 0, api_name: None,
            expect_mac: 2, expect_dma_read: 1, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 100, tolerance_pct: 60.0, abs_tolerance: None,
        }];
        let rep = diff(&t, &rows);
        let step = &rep.steps[0];
        let mac = step.metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(mac.pass);
        let cy = step.metrics.iter().find(|m| m.name == "cycles").unwrap();
        assert!(!cy.pass);
    }

    // ─── Identical traces ──────────────────────────────────────────

    #[test]
    fn identical_traces_produce_all_exact_matches() {
        let t = mk_trace();
        // Build a reference that exactly mirrors the trace with 0% tolerance.
        let buckets = bucketise(&t);
        let rows: Vec<RefProfileRow> = buckets.iter().map(|b| RefProfileRow {
            step: b.step, api_name: b.api_name.clone(),
            expect_mac: b.mac, expect_dma_read: b.dma_read,
            expect_dma_write: b.dma_write, expect_barrier: b.barrier,
            cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: None,
        }).collect();
        let rep = diff(&t, &rows);
        assert!(rep.is_clean());
        // All metrics should be exact matches (no cycle_budget set).
        assert_eq!(rep.exact_matches, rep.total_metrics);
        assert_eq!(rep.tolerance_passes, 0);
        assert_eq!(rep.metric_mismatches, 0);
    }

    // ─── Single-field mismatch ─────────────────────────────────────

    #[test]
    fn single_field_mismatch_reported_correctly() {
        let t = mk_trace();
        // Step 0 has mac=2; set expected to 5 with 0% tolerance.
        let rows = vec![RefProfileRow {
            step: 0, api_name: None,
            expect_mac: 5, expect_dma_read: 1, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: None,
        }];
        let rep = diff(&t, &rows);
        assert!(!rep.is_clean());
        assert_eq!(rep.metric_mismatches, 1);
        let step = &rep.steps[0];
        assert!(!step.is_pass);
        let mac = step.metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(!mac.pass);
        assert_eq!(mac.observed, 2);
        assert_eq!(mac.expected, 5);
        // Other metrics should still pass (0 observed == 0 expected).
        let others: Vec<&MetricDiff> = step.metrics.iter().filter(|m| m.name != "mac").collect();
        assert!(others.iter().all(|m| m.pass));
    }

    // ─── Multiple mismatches across steps ──────────────────────────

    #[test]
    fn multiple_mismatches_across_steps() {
        let t = mk_trace();
        let rows = vec![
            RefProfileRow {
                step: 0, api_name: None,
                expect_mac: 99, expect_dma_read: 99, expect_dma_write: 0, expect_barrier: 0,
                cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: None,
            },
            RefProfileRow {
                step: 1, api_name: None,
                expect_mac: 99, expect_dma_read: 0, expect_dma_write: 99, expect_barrier: 0,
                cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: None,
            },
        ];
        let rep = diff(&t, &rows);
        assert!(!rep.is_clean());
        assert_eq!(rep.pass_count, 0);
        assert_eq!(rep.step_count, 2);
        // mac + dma_read fail on step 0; mac + dma_write fail on step 1.
        assert!(rep.metric_mismatches >= 4);
    }

    // ─── Empty trace against non-empty reference ───────────────────

    #[test]
    fn empty_trace_mismatches_nonzero_expectations() {
        let empty = NpuTrace { total_cycles: 0, events: vec![] };
        let rows = vec![RefProfileRow {
            step: 0, api_name: None,
            expect_mac: 5, expect_dma_read: 0, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 0, tolerance_pct: 10.0, abs_tolerance: None,
        }];
        let rep = diff(&empty, &rows);
        assert!(!rep.is_clean());
        let mac = rep.steps[0].metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(!mac.pass);
        assert_eq!(mac.observed, 0);
    }

    // ─── Empty reference passes trivially ──────────────────────────

    #[test]
    fn empty_reference_yields_clean_report() {
        let t = mk_trace();
        let rep = diff(&t, &[]);
        assert!(rep.is_clean());
        assert_eq!(rep.step_count, 0);
        assert_eq!(rep.pass_count, 0);
        assert_eq!(rep.total_metrics, 0);
    }

    // ─── Absolute tolerance ────────────────────────────────────────

    #[test]
    fn abs_tolerance_passes_when_pct_fails() {
        let t = mk_trace();
        // Step 0: mac=2. Expect 10 with 0% tolerance (fails pct-wise)
        // but abs_tolerance=10 should rescue it.
        let rows = vec![RefProfileRow {
            step: 0, api_name: None,
            expect_mac: 10, expect_dma_read: 1, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: Some(10),
        }];
        let rep = diff(&t, &rows);
        let mac = rep.steps[0].metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(mac.pass, "abs_tolerance=10 should pass drift of 8");
    }

    #[test]
    fn abs_tolerance_fails_when_drift_exceeds() {
        let t = mk_trace();
        // Step 0: mac=2. Expect 100; abs_tolerance=5, pct=0%.
        let rows = vec![RefProfileRow {
            step: 0, api_name: None,
            expect_mac: 100, expect_dma_read: 0, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 0, tolerance_pct: 0.0, abs_tolerance: Some(5),
        }];
        let rep = diff(&t, &rows);
        let mac = rep.steps[0].metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(!mac.pass, "abs_tolerance=5 should not cover drift of 98");
    }

    // ─── Report statistics ─────────────────────────────────────────

    #[test]
    fn report_statistics_are_consistent() {
        let t = mk_trace();
        let rp = profile_from_trace(&t, 10.0);
        let rep = diff(&t, &rp);
        assert_eq!(
            rep.total_metrics,
            rep.exact_matches + rep.tolerance_passes + rep.metric_mismatches,
            "stats must add up",
        );
    }

    // ─── Display impls ─────────────────────────────────────────────

    #[test]
    fn display_impl_formats_without_panic() {
        let t = mk_trace();
        let rp = profile_from_trace(&t, 10.0);
        let rep = diff(&t, &rp);
        let s = format!("{}", rep);
        assert!(s.contains("golden-diff:"));
        assert!(s.contains("metrics:"));
    }

    #[test]
    fn metric_display_shows_verdict() {
        let m = MetricDiff {
            name: "mac".into(), observed: 5, expected: 5,
            tolerance_pct: 10.0, pass: true,
        };
        let s = format!("{}", m);
        assert!(s.contains("PASS"));
        assert!(s.contains("mac"));
    }

    // ─── Parse errors carry context ────────────────────────────────

    #[test]
    fn parse_error_contains_line_number() {
        let bad = "{\"step\":0}\n{bad json}\n";
        match parse_reference_jsonl(bad) {
            Err(GoldenDiffError::Parse { line, .. }) => assert_eq!(line, 2),
            other => panic!("expected Parse error, got {:?}", other),
        }
    }

    #[test]
    fn parse_empty_returns_empty_error() {
        match parse_reference_jsonl("# only comments\n\n") {
            Err(GoldenDiffError::Empty { .. }) => {}
            other => panic!("expected Empty error, got {:?}", other),
        }
    }

    // ─── JSONL round-trip preserves abs_tolerance ──────────────────

    #[test]
    fn jsonl_round_trip_preserves_abs_tolerance() {
        let rows = vec![RefProfileRow {
            step: 0, api_name: Some("test".into()),
            expect_mac: 5, expect_dma_read: 0, expect_dma_write: 0, expect_barrier: 0,
            cycle_budget: 100, tolerance_pct: 10.0, abs_tolerance: Some(3),
        }];
        let s = profile_to_jsonl(&rows);
        let back = parse_reference_jsonl(&s).unwrap();
        assert_eq!(back[0].abs_tolerance, Some(3));
    }

    #[test]
    fn jsonl_without_abs_tolerance_defaults_to_none() {
        let s = "{\"step\":0,\"expect_mac\":1}\n";
        let rows = parse_reference_jsonl(s).unwrap();
        assert_eq!(rows[0].abs_tolerance, None);
    }
}
