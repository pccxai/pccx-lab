// Module Boundary: core/
// pccx-core: speculative decoding primitives.
//
// Building blocks for the EAGLE-family of tree speculative decoding
// algorithms that land in the UVM strategy + Sail execute pass over
// the next few IMPLEMENT cycles.  The module is deliberately scoped
// to **data operations** only — no control flow, no I/O — so it can
// be reused by:
//
//   * the pccx-lab trace analyser (`speculative_draft_probe`),
//   * the `golden_diff` regression gate (per-step accept length),
//   * the Sail execute pass (acceptance count drives `advance_cycle`),
//   * the hybrid-sim C++ simulator (mirror via a host-side wrapper).
//
// Research lineage:
//   * "EAGLE: Speculative Sampling Requires Rethinking Feature
//     Uncertainty" (arxiv 2401.15077).
//   * "EAGLE-Pangu: Accelerator-Safe Tree Speculative Decoding on
//     Ascend NPUs" (arxiv 2603.08088) — the 1.27× / 2.46× NPU
//     speedup that motivates this module.  Their key architectural
//     lesson (static tree tensorisation, no undefined indices) is
//     encoded here via index-bounded slices and `.min()` rather
//     than arbitrary pointer arithmetic.

use serde::{Deserialize, Serialize};

/// Return the length of the longest prefix where `candidate` and
/// `reference` agree, bounded by the shorter of the two slices.
/// A pure total function — safe to call from the Sail execute
/// pass once we bind Rust impls via the interpreter back-end.
#[inline]
pub fn longest_matching_prefix<T: PartialEq>(candidate: &[T], reference: &[T]) -> usize {
    let mut n = 0usize;
    let limit = candidate.len().min(reference.len());
    while n < limit && candidate[n] == reference[n] {
        n += 1;
    }
    n
}

/// Per-iteration statistics for a speculative decode step.  One row
/// per draft-tree verification on the NPU — aggregated across many
/// steps in `AcceptRate::summarise`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct AcceptStep {
    /// Number of tokens the draft proposed (= tree width × depth for
    /// tree-style, = K for chain-style EAGLE).
    pub drafted:  u32,
    /// Prefix length the target accepted this step.  `accepted <=
    /// drafted` always.
    pub accepted: u32,
}

impl AcceptStep {
    #[inline]
    pub fn new(drafted: u32, accepted: u32) -> Self {
        Self { drafted, accepted: accepted.min(drafted) }
    }

    /// Ratio in [0, 1] — 1.0 means the target kept every drafted
    /// token this step.
    #[inline]
    pub fn accept_rate(&self) -> f64 {
        if self.drafted == 0 { 0.0 } else {
            self.accepted as f64 / self.drafted as f64
        }
    }

    /// Expected per-iteration speedup this step contributes.  Derived
    /// from the EAGLE-Pangu iteration model:
    ///     speedup = 1 + accepted  (the extra tokens committed without
    ///     a target-model round trip).
    #[inline]
    pub fn speedup_contribution(&self) -> f64 {
        1.0 + self.accepted as f64
    }
}

/// Aggregated acceptance across a decode run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcceptRate {
    pub steps:        u32,
    pub total_drafted:  u64,
    pub total_accepted: u64,
    /// P50 / P95 of per-step accept length — captures the "catas-
    /// trophic miss" distribution EAGLE-Pangu calls out.
    pub p50_accept:   u32,
    pub p95_accept:   u32,
    pub mean_speedup: f64,
}

impl AcceptRate {
    /// Compute aggregate statistics from a stream of per-step rows.
    /// Uses a single pass + a sort for the percentiles; acceptable
    /// for up to ~10^6 steps which is well beyond any realistic
    /// decode horizon.
    pub fn summarise(steps: &[AcceptStep]) -> Self {
        if steps.is_empty() {
            return Self::default();
        }
        let mut accepted: Vec<u32> = steps.iter().map(|s| s.accepted).collect();
        accepted.sort_unstable();
        let p50 = accepted[accepted.len() / 2];
        let p95 = accepted[((accepted.len() as f64 * 0.95) as usize).min(accepted.len() - 1)];
        let total_drafted:  u64 = steps.iter().map(|s| s.drafted  as u64).sum();
        let total_accepted: u64 = steps.iter().map(|s| s.accepted as u64).sum();
        let mean_speedup = steps.iter()
            .map(|s| s.speedup_contribution())
            .sum::<f64>() / steps.len() as f64;
        Self {
            steps:          steps.len() as u32,
            total_drafted,
            total_accepted,
            p50_accept:     p50,
            p95_accept:     p95,
            mean_speedup,
        }
    }

    /// Overall accepted / drafted ratio across the run.
    #[inline]
    pub fn overall_rate(&self) -> f64 {
        if self.total_drafted == 0 { 0.0 } else {
            self.total_accepted as f64 / self.total_drafted as f64
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_prefix_on_identical_slices() {
        assert_eq!(longest_matching_prefix(&[1u32, 2, 3], &[1, 2, 3]), 3);
    }

    #[test]
    fn longest_prefix_is_bounded_by_shorter() {
        assert_eq!(longest_matching_prefix(&[1u32, 2, 3, 4], &[1, 2]),       2);
        assert_eq!(longest_matching_prefix::<u32>(&[], &[1, 2]),             0);
    }

    #[test]
    fn longest_prefix_stops_at_first_mismatch() {
        assert_eq!(longest_matching_prefix(&[1u32, 2, 9], &[1, 2, 3, 4]),    2);
        assert_eq!(longest_matching_prefix(&[0u32, 0, 0], &[1, 0, 0]),       0);
    }

    #[test]
    fn accept_step_clamps_overshoot() {
        let s = AcceptStep::new(4, 7);
        assert_eq!(s.accepted, 4);
        assert!((s.accept_rate() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn accept_step_handles_zero_draft() {
        let s = AcceptStep::new(0, 0);
        assert_eq!(s.accept_rate(), 0.0);
        assert_eq!(s.speedup_contribution(), 1.0);  // always at least 1 (the greedy token).
    }

    #[test]
    fn accept_rate_summary_reports_percentiles() {
        let steps: Vec<AcceptStep> = (0..100)
            .map(|i| AcceptStep::new(4, (i / 20) as u32))  // 0..5 per 20 steps
            .collect();
        let agg = AcceptRate::summarise(&steps);
        assert_eq!(agg.steps, 100);
        assert_eq!(agg.total_drafted, 400);
        // Median is at index 50 → steps[50] has accepted=2.
        assert_eq!(agg.p50_accept, 2);
        // 95th percentile is at index 95 → steps[95] has accepted=4.
        assert_eq!(agg.p95_accept, 4);
        // Mean speedup in (1, drafted+1).
        assert!(agg.mean_speedup > 1.0 && agg.mean_speedup <= 5.0);
    }

    #[test]
    fn accept_rate_on_empty_stream_is_zero() {
        let agg = AcceptRate::summarise(&[]);
        assert_eq!(agg.steps, 0);
        assert_eq!(agg.overall_rate(), 0.0);
    }

    #[test]
    fn eagle_pangu_claim_reproducible_via_mean_speedup() {
        // Paper's average claim: 1.27x over teacher-only greedy.
        // A stream where 27 % of steps accept one extra token and the
        // rest accept none reproduces the same mean_speedup.
        let mut steps: Vec<AcceptStep> = Vec::new();
        for _ in 0..27 { steps.push(AcceptStep::new(1, 1)); }
        for _ in 0..73 { steps.push(AcceptStep::new(1, 0)); }
        let agg = AcceptRate::summarise(&steps);
        // Expect mean_speedup ≈ 1 + 0.27 = 1.27.
        assert!((agg.mean_speedup - 1.27).abs() < 1e-9,
                "got mean_speedup={}", agg.mean_speedup);
    }
}
