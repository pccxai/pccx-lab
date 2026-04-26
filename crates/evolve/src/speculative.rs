// Module Boundary: evolve/speculative
// pccx-evolve: speculative decoding primitives.
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
//     Static-Graph NPU Class" (arxiv 2603.08088) — the 1.27x / 2.46x
//     speedup that motivates this module.  Their key architectural
//     lesson (static tree tensorisation, no undefined indices) is
//     encoded here via index-bounded slices and `.min()` rather
//     than arbitrary pointer arithmetic.

use serde::{Deserialize, Serialize};
use std::fmt;

// ─── Errors ────────────────────────────────────────────────────────────────────

/// Structural errors in a tree mask — caught by `assert_no_undefined_index`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecError {
    /// A branch references a parent index that exceeds `branches.len()`.
    ParentOutOfRange { branch_idx: usize, parent_idx: usize },
    /// A branch's parent index is not strictly less than its own index
    /// (violates BFS ordering invariant).
    ParentAfterChild { branch_idx: usize, parent_idx: usize },
    /// A non-root branch has `depth == 0`, or the root has `depth != 0`.
    DepthMismatch { branch_idx: usize, depth: u32, expected_min: u32 },
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecError::ParentOutOfRange { branch_idx, parent_idx } => {
                write!(
                    f,
                    "branch {} references parent {} which is out of range",
                    branch_idx, parent_idx,
                )
            }
            SpecError::ParentAfterChild { branch_idx, parent_idx } => {
                write!(
                    f,
                    "branch {} has parent {} which violates BFS order (parent >= child)",
                    branch_idx, parent_idx,
                )
            }
            SpecError::DepthMismatch { branch_idx, depth, expected_min } => {
                write!(
                    f,
                    "branch {} has depth {} but expected >= {}",
                    branch_idx, depth, expected_min,
                )
            }
        }
    }
}

impl std::error::Error for SpecError {}

// ─── Branch ────────────────────────────────────────────────────────────────────

/// One node in a static tree mask.  Branches are stored in BFS order
/// so `parent_idx < token_idx` is always true for non-root nodes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Branch {
    /// Position of this node in the flattened tree (= index in `TreeMask::branches`).
    pub token_idx: usize,
    /// Parent position.  `None` only for the root (index 0).
    pub parent_idx: Option<usize>,
    /// Depth in the tree (root = 0).
    pub depth: u32,
    /// Whether this branch has been committed.  Always `false` after
    /// construction — `SpeculativeVerifier::verify_and_commit` returns
    /// commit results externally rather than mutating the mask.
    pub committed: bool,
}

// ─── TreeMask ──────────────────────────────────────────────────────────────────

/// Precomputed static tree structure for speculative decoding paths.
///
/// Matches the EAGLE-Pangu pattern: the tree is built once (at graph
/// compile time on a static-graph accelerator) and reused across every
/// decode iteration.  All indexing is bounded — no negative or
/// undefined indices can exist by construction.
///
/// Layout: a complete `branch_factor`-ary tree of `max_depth` levels
/// (root at depth 0, leaves at depth `max_depth - 1`).  Stored in BFS
/// order so parent indices are always smaller than child indices.
///
/// Node count for a complete tree: `(b^d - 1) / (b - 1)` where
/// `b = branch_factor` and `d = max_depth`.  When `b == 1` the tree
/// degenerates to a chain of `max_depth` nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeMask {
    pub branches: Vec<Branch>,
    pub max_depth: usize,
    pub total_tokens: usize,
    /// Precomputed contiguous index list — mirrors the paper's static
    /// tensor layout.  Built once in `new()`, never mutated.
    valid_indices: Vec<usize>,
}

impl TreeMask {
    /// Build a complete `branch_factor`-ary tree with `max_depth` levels.
    ///
    /// `max_depth` is the number of levels including the root.  A depth
    /// of 1 yields a single root node (no actual speculation).  A depth
    /// of 3 with branch_factor=2 yields 7 nodes (1 + 2 + 4).
    ///
    /// Panics if `max_depth == 0` (a tree must have at least a root).
    pub fn new(max_depth: usize, branch_factor: usize) -> Self {
        assert!(max_depth > 0, "max_depth must be >= 1 (at least a root)");
        assert!(branch_factor > 0, "branch_factor must be >= 1");

        // Total node count for a complete b-ary tree of d levels.
        let total = if branch_factor == 1 {
            max_depth
        } else {
            // (b^d - 1) / (b - 1)
            (branch_factor.pow(max_depth as u32) - 1) / (branch_factor - 1)
        };

        let mut branches = Vec::with_capacity(total);

        // Root node.
        branches.push(Branch {
            token_idx: 0,
            parent_idx: None,
            depth: 0,
            committed: false,
        });

        // BFS expansion: for each existing node, append its children.
        let mut cursor = 0;
        while cursor < branches.len() {
            let parent_depth = branches[cursor].depth;
            if (parent_depth as usize) < max_depth - 1 {
                for _ in 0..branch_factor {
                    let idx = branches.len();
                    branches.push(Branch {
                        token_idx: idx,
                        parent_idx: Some(cursor),
                        depth: parent_depth + 1,
                        committed: false,
                    });
                }
            }
            cursor += 1;
        }

        debug_assert_eq!(branches.len(), total);

        let valid_indices: Vec<usize> = (0..total).collect();

        Self {
            branches,
            max_depth,
            total_tokens: total,
            valid_indices,
        }
    }

    /// Return indices of all valid token positions.  For a well-formed
    /// tree this is simply `0..total_tokens`, precomputed in `new()`.
    /// Provided for API symmetry with the paper's static tensor layout.
    pub fn valid_indices(&self) -> &[usize] {
        &self.valid_indices
    }
}

// ─── Structural invariant check ────────────────────────────────────────────────

/// Validate the structural invariant required by static-graph accelerators:
/// no undefined indices, all parent references valid, BFS ordering
/// respected.  This is the Rust encoding of the EAGLE-Pangu paper's
/// `assert_no_undefined_index()` runtime check.
pub fn assert_no_undefined_index(mask: &TreeMask) -> Result<(), SpecError> {
    for (i, branch) in mask.branches.iter().enumerate() {
        match branch.parent_idx {
            None => {
                // Root must be at depth 0.
                if branch.depth != 0 {
                    return Err(SpecError::DepthMismatch {
                        branch_idx: i,
                        depth: branch.depth,
                        expected_min: 0,
                    });
                }
            }
            Some(pidx) => {
                // Parent must be in range.
                if pidx >= mask.branches.len() {
                    return Err(SpecError::ParentOutOfRange {
                        branch_idx: i,
                        parent_idx: pidx,
                    });
                }
                // BFS ordering: parent index strictly less than child.
                if pidx >= i {
                    return Err(SpecError::ParentAfterChild {
                        branch_idx: i,
                        parent_idx: pidx,
                    });
                }
                // Non-root must have depth > 0.
                if branch.depth == 0 {
                    return Err(SpecError::DepthMismatch {
                        branch_idx: i,
                        depth: 0,
                        expected_min: 1,
                    });
                }
            }
        }
    }
    Ok(())
}

// ─── Verification + commit ─────────────────────────────────────────────────────

/// Result of `SpeculativeVerifier::verify_and_commit`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitResult {
    /// Token indices that the target model accepted (committed via MEMCPY).
    pub committed_tokens: Vec<usize>,
    /// Token indices whose subtrees were rejected and discarded.
    pub discarded_tokens: Vec<usize>,
    /// Length of the longest root-to-leaf accepted path.
    pub longest_accepted_path: usize,
}

/// Walks a `TreeMask` against a target-model acceptance vector and
/// determines which branches to commit and which to discard.
///
/// Follows the EAGLE-Pangu commit/discard protocol: a branch is
/// committed only if it is accepted AND every ancestor on its path
/// back to the root is also accepted.  Rejected branches cause their
/// entire subtree to be discarded (the target model's MEMCPY boundary).
pub struct SpeculativeVerifier;

impl SpeculativeVerifier {
    /// Verify a tree mask against an acceptance vector.
    ///
    /// `accepted` must be parallel to `mask.branches` — `accepted[i]`
    /// is `true` when the target model agrees with the draft at
    /// position `i`.  If `accepted` is shorter than `branches`, missing
    /// entries are treated as rejected.
    pub fn verify_and_commit(mask: &TreeMask, accepted: &[bool]) -> CommitResult {
        let n = mask.branches.len();

        // Per-node effective acceptance: true only if this node AND all
        // ancestors are accepted.
        let mut effectively_accepted = vec![false; n];

        // Walk in BFS order (index order).  Because parents always
        // precede children, a single forward pass suffices.
        for i in 0..n {
            let self_accepted = accepted.get(i).copied().unwrap_or(false);
            let parent_ok = match mask.branches[i].parent_idx {
                None => true,  // root has no ancestor constraint
                Some(pidx) => effectively_accepted[pidx],
            };
            effectively_accepted[i] = self_accepted && parent_ok;
        }

        let mut committed_tokens = Vec::new();
        let mut discarded_tokens = Vec::new();

        for i in 0..n {
            if effectively_accepted[i] {
                committed_tokens.push(i);
            } else {
                discarded_tokens.push(i);
            }
        }

        // Longest accepted path: the maximum depth among committed nodes,
        // plus 1 (depth is 0-indexed, path length is 1-indexed).
        let longest_accepted_path = committed_tokens
            .iter()
            .map(|&i| mask.branches[i].depth as usize + 1)
            .max()
            .unwrap_or(0);

        CommitResult {
            committed_tokens,
            discarded_tokens,
            longest_accepted_path,
        }
    }
}

// ─── Original primitives ───────────────────────────────────────────────────────

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
    /// Number of tokens the draft proposed (= tree width x depth for
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

// ─── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Original primitive tests ────────────────────────────────────────

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
        // Median is at index 50 -> steps[50] has accepted=2.
        assert_eq!(agg.p50_accept, 2);
        // 95th percentile is at index 95 -> steps[95] has accepted=4.
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
        // Expect mean_speedup ~= 1 + 0.27 = 1.27.
        assert!((agg.mean_speedup - 1.27).abs() < 1e-9,
                "got mean_speedup={}", agg.mean_speedup);
    }

    // ── TreeMask construction tests ─────────────────────────────────────

    #[test]
    fn tree_mask_depth3_branch2_has_7_nodes() {
        let mask = TreeMask::new(3, 2);
        assert_eq!(mask.total_tokens, 7);
        assert_eq!(mask.branches.len(), 7);
        assert_eq!(mask.max_depth, 3);

        // Root.
        assert_eq!(mask.branches[0].parent_idx, None);
        assert_eq!(mask.branches[0].depth, 0);

        // Level 1: indices 1, 2 — children of root.
        assert_eq!(mask.branches[1].parent_idx, Some(0));
        assert_eq!(mask.branches[1].depth, 1);
        assert_eq!(mask.branches[2].parent_idx, Some(0));
        assert_eq!(mask.branches[2].depth, 1);

        // Level 2: indices 3..6 — children of 1 and 2.
        assert_eq!(mask.branches[3].parent_idx, Some(1));
        assert_eq!(mask.branches[3].depth, 2);
        assert_eq!(mask.branches[4].parent_idx, Some(1));
        assert_eq!(mask.branches[4].depth, 2);
        assert_eq!(mask.branches[5].parent_idx, Some(2));
        assert_eq!(mask.branches[5].depth, 2);
        assert_eq!(mask.branches[6].parent_idx, Some(2));
        assert_eq!(mask.branches[6].depth, 2);
    }

    #[test]
    fn tree_mask_chain_degenerate() {
        // branch_factor=1 -> chain: 4 nodes at depths 0,1,2,3.
        let mask = TreeMask::new(4, 1);
        assert_eq!(mask.total_tokens, 4);
        for i in 0..4 {
            assert_eq!(mask.branches[i].depth, i as u32);
            if i == 0 {
                assert_eq!(mask.branches[i].parent_idx, None);
            } else {
                assert_eq!(mask.branches[i].parent_idx, Some(i - 1));
            }
        }
    }

    #[test]
    fn tree_mask_depth1_single_root() {
        // depth=1 -> root only, no speculation children.
        let mask = TreeMask::new(1, 2);
        assert_eq!(mask.total_tokens, 1);
        assert_eq!(mask.branches.len(), 1);
        assert_eq!(mask.branches[0].depth, 0);
        assert_eq!(mask.branches[0].parent_idx, None);
    }

    #[test]
    fn valid_indices_is_contiguous() {
        let mask = TreeMask::new(3, 2);
        let indices = mask.valid_indices();
        assert_eq!(indices, &[0, 1, 2, 3, 4, 5, 6]);
    }

    // ── assert_no_undefined_index tests ─────────────────────────────────

    #[test]
    fn well_formed_tree_passes_invariant() {
        let mask = TreeMask::new(3, 2);
        assert!(assert_no_undefined_index(&mask).is_ok());
    }

    #[test]
    fn well_formed_chain_passes_invariant() {
        let mask = TreeMask::new(5, 1);
        assert!(assert_no_undefined_index(&mask).is_ok());
    }

    #[test]
    fn parent_out_of_range_detected() {
        let mut mask = TreeMask::new(2, 2);
        // Corrupt branch 1 to reference a nonexistent parent.
        mask.branches[1].parent_idx = Some(999);
        let err = assert_no_undefined_index(&mask).unwrap_err();
        assert!(matches!(err, SpecError::ParentOutOfRange { branch_idx: 1, parent_idx: 999 }));
    }

    #[test]
    fn parent_after_child_detected() {
        let mut mask = TreeMask::new(2, 2);
        // Corrupt: make branch 1's parent point to branch 2 (forward ref).
        mask.branches[1].parent_idx = Some(2);
        let err = assert_no_undefined_index(&mask).unwrap_err();
        assert!(matches!(err, SpecError::ParentAfterChild { branch_idx: 1, parent_idx: 2 }));
    }

    #[test]
    fn depth_mismatch_on_nonroot_depth_zero() {
        let mut mask = TreeMask::new(2, 2);
        // Corrupt: set child depth to 0.
        mask.branches[1].depth = 0;
        let err = assert_no_undefined_index(&mask).unwrap_err();
        assert!(matches!(err, SpecError::DepthMismatch { branch_idx: 1, depth: 0, .. }));
    }

    // ── SpeculativeVerifier tests ───────────────────────────────────────

    #[test]
    fn verify_all_accepted_commits_everything() {
        let mask = TreeMask::new(3, 2);  // 7 nodes
        let accepted = vec![true; 7];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert_eq!(result.committed_tokens, vec![0, 1, 2, 3, 4, 5, 6]);
        assert!(result.discarded_tokens.is_empty());
        // Longest path: depth 2 + 1 = 3 (root -> level1 -> level2).
        assert_eq!(result.longest_accepted_path, 3);
    }

    #[test]
    fn verify_root_rejected_discards_everything() {
        let mask = TreeMask::new(3, 2);  // 7 nodes
        let mut accepted = vec![true; 7];
        accepted[0] = false;  // reject root
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert!(result.committed_tokens.is_empty());
        assert_eq!(result.discarded_tokens.len(), 7);
        assert_eq!(result.longest_accepted_path, 0);
    }

    #[test]
    fn verify_partial_acceptance_prunes_subtree() {
        //       0 (accept)
        //      / \
        //    1     2 (accept / reject)
        //   / \   / \
        //  3   4 5   6  (all accept)
        //
        // Branch 2 rejected -> its children 5, 6 are discarded even
        // though they are individually "accepted".
        let mask = TreeMask::new(3, 2);
        let accepted = vec![true, true, false, true, true, true, true];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert_eq!(result.committed_tokens, vec![0, 1, 3, 4]);
        assert_eq!(result.discarded_tokens, vec![2, 5, 6]);
        // Longest accepted path: root(0) -> 1(1) -> 3 or 4 (2) = depth 2 + 1 = 3.
        assert_eq!(result.longest_accepted_path, 3);
    }

    #[test]
    fn verify_only_root_accepted() {
        let mask = TreeMask::new(3, 2);
        let accepted = vec![true, false, false, false, false, false, false];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert_eq!(result.committed_tokens, vec![0]);
        assert_eq!(result.discarded_tokens, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(result.longest_accepted_path, 1);
    }

    #[test]
    fn verify_short_accepted_slice_treats_missing_as_rejected() {
        let mask = TreeMask::new(3, 2);  // 7 nodes
        // Only provide acceptance for first 3 nodes.
        let accepted = vec![true, true, true];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        // Nodes 0, 1, 2 accepted; 3..6 have no entry -> rejected.
        // But 3, 4 are children of 1 (accepted) — still rejected because
        // accepted[3] defaults to false.
        assert_eq!(result.committed_tokens, vec![0, 1, 2]);
        assert_eq!(result.discarded_tokens, vec![3, 4, 5, 6]);
        assert_eq!(result.longest_accepted_path, 2);
    }

    #[test]
    fn verify_depth1_single_node_accepted() {
        let mask = TreeMask::new(1, 2);
        let accepted = vec![true];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert_eq!(result.committed_tokens, vec![0]);
        assert!(result.discarded_tokens.is_empty());
        assert_eq!(result.longest_accepted_path, 1);
    }

    #[test]
    fn verify_depth1_single_node_rejected() {
        let mask = TreeMask::new(1, 2);
        let accepted = vec![false];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        assert!(result.committed_tokens.is_empty());
        assert_eq!(result.discarded_tokens, vec![0]);
        assert_eq!(result.longest_accepted_path, 0);
    }

    #[test]
    fn verify_chain_partial_acceptance() {
        // Chain: 0 -> 1 -> 2 -> 3
        // Accept first 2, reject at depth 2.
        let mask = TreeMask::new(4, 1);
        let accepted = vec![true, true, false, true];
        let result = SpeculativeVerifier::verify_and_commit(&mask, &accepted);

        // Node 3 is accepted individually but parent 2 is rejected.
        assert_eq!(result.committed_tokens, vec![0, 1]);
        assert_eq!(result.discarded_tokens, vec![2, 3]);
        assert_eq!(result.longest_accepted_path, 2);
    }
}
