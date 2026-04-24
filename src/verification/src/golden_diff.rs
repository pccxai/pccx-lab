// Module Boundary: core/
// pccx-core: golden-model diff — NVIDIA consultation report §6.2
// (end-to-end correctness).
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
}

impl GoldenDiffReport {
    pub fn is_clean(&self) -> bool { self.pass_count == self.step_count }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum GoldenDiffError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json parse error at line {line}: {source}")]
    Parse { line: usize, source: serde_json::Error },
    #[error("empty reference file")]
    Empty,
}

// ─── Loading ────────────────────────────────────────────────────────────────

/// Parse a JSONL reference file — one `RefProfileRow` per non-blank,
/// non-`#`-comment line.  Empty / comment lines are skipped so the
/// file can carry annotations.
pub fn parse_reference_jsonl(src: &str) -> Result<Vec<RefProfileRow>, GoldenDiffError> {
    let mut out = Vec::new();
    for (i, line) in src.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        match serde_json::from_str::<RefProfileRow>(trimmed) {
            Ok(row)  => out.push(row),
            Err(e)   => return Err(GoldenDiffError::Parse { line: i + 1, source: e }),
        }
    }
    if out.is_empty() { return Err(GoldenDiffError::Empty); }
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
                    first_cy:  ev.start_cycle,
                    last_cy:   ev.start_cycle + ev.duration,
                    ..Default::default()
                };
            } else {
                current.api_name = ev.api_name.clone();
                current.first_cy = ev.start_cycle;
                current.last_cy  = ev.start_cycle + ev.duration;
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
        let end = ev.start_cycle + ev.duration;
        // "Never accumulated anything" if no counter is set AND the
        // caller hasn't pre-seeded the span on an API_CALL boundary.
        let had_events =
            self.mac + self.dma_read + self.dma_write + self.barrier + self.stall > 0
            || self.last_cy > 0;
        if !had_events {
            self.first_cy = ev.start_cycle;
            self.last_cy  = end;
        } else {
            if ev.start_cycle < self.first_cy { self.first_cy = ev.start_cycle; }
            if end          > self.last_cy   { self.last_cy   = end; }
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

fn check(observed: i64, expected: i64, tolerance_pct: f64) -> bool {
    if expected == 0 { return observed == 0; }
    let drift = (observed - expected).abs() as f64;
    let allowed = (expected as f64).abs() * tolerance_pct / 100.0;
    drift <= allowed
}

pub fn diff(trace: &NpuTrace, reference: &[RefProfileRow]) -> GoldenDiffReport {
    let buckets = bucketise(trace);
    let mut out = Vec::with_capacity(reference.len());
    let mut pass = 0u32;

    for row in reference {
        let obs = buckets.iter().find(|b| b.step == row.step);
        let (mac, dma_r, dma_w, barrier, cycles) = match obs {
            Some(b) => (b.mac as i64, b.dma_read as i64, b.dma_write as i64,
                        b.barrier as i64, b.cycles() as i64),
            None    => (0, 0, 0, 0, 0),
        };
        let mut metrics = vec![
            mk_metric("mac",       mac,       row.expect_mac as i64,        row.tolerance_pct),
            mk_metric("dma_read",  dma_r,     row.expect_dma_read as i64,   row.tolerance_pct),
            mk_metric("dma_write", dma_w,     row.expect_dma_write as i64,  row.tolerance_pct),
            mk_metric("barrier",   barrier,   row.expect_barrier as i64,    row.tolerance_pct),
        ];
        if row.cycle_budget > 0 {
            metrics.push(mk_metric("cycles", cycles, row.cycle_budget as i64, row.tolerance_pct));
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
    GoldenDiffReport { step_count: total, pass_count: pass, steps: out, summary }
}

fn mk_metric(name: &str, observed: i64, expected: i64, tolerance_pct: f64) -> MetricDiff {
    MetricDiff {
        name:          name.to_string(),
        observed,
        expected,
        tolerance_pct,
        pass:          check(observed, expected, tolerance_pct),
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
            cycle_budget: 0, tolerance_pct: 10.0,
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
            cycle_budget: 100, tolerance_pct: 60.0,
        }];
        let rep = diff(&t, &rows);
        let step = &rep.steps[0];
        let mac = step.metrics.iter().find(|m| m.name == "mac").unwrap();
        assert!(mac.pass);
        let cy = step.metrics.iter().find(|m| m.name == "cycles").unwrap();
        assert!(!cy.pass);
    }
}
