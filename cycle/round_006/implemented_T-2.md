# Implemented — T-2 — Round 6

## Ticket T-2: Roofline 2.0 — heatmap, kernel bands, dual-workload overlay

- **Commit:** `5d3eb43` — `feat(ui): T-2 Roofline 2.0 — heatmap, kernel bands, dual-workload overlay`
- **Author:** `hkimw <54717101+hkimw@users.noreply.github.com>` (no bot attribution; pre-push hook compliant)
- **Files changed (git show --stat 5d3eb43):**
  ```
  src/core/src/lib.rs         |   2 +-
  src/core/src/roofline.rs    | 210 ++++++++++++++++
  src/ui/src-tauri/src/lib.rs |  22 +-
  src/ui/src/Roofline.tsx     | 535 ++++++++++++++++++++++++++++++++++++++++-
  4 files changed, 756 insertions(+), 13 deletions(-)
  ```
  Well inside the 1000 LoC budget.

## Acceptance self-check

| # | Criterion | Status |
|---|---|---|
| 1 | `rg "heatmap" src/ui/src/Roofline.tsx` ≥ 1 | PASS (18 matches) |
| 2 | `rg "type: 'custom'" src/ui/src/Roofline.tsx` ≥ 1 | PASS (1 match, per-kernel `custom` series) |
| 3 | With primary + alt `.pccx` loaded, chart renders 3 new series simultaneously (heatmap / kernel bands / dual ceiling) | PASS (code path renders all three; the alt-ceiling block is gated on `altKernels`, the heatmap on `heatmap.cells.length > 0`, and kernel bands unconditionally) |
| 4 | Top-level `KERNELS =` literal removed — replaced by `useMemo` reducer | PASS (`rg "^const KERNELS =" Roofline.tsx` → 0; `STUB_KERNELS` is a fallback used only when trace payload < 24 bytes, never at module scope as the active kernel source) |
| 5 | `cd src/core && cargo test` includes new passing test for `analyze_hierarchical` | PASS — 2 new tests: `test_analyze_hierarchical_emits_four_bands_monotonic_bw` + `test_analyze_hierarchical_empty_trace_emits_structural_bands`, both in the `59 passed` lib run |
| 6 | `cd src/ui && npx tsc --noEmit` passes for Roofline.tsx | PASS — `grep -c "Roofline" tsc-output` → 0 (the TSC output after stash pop flags unrelated T-1 WIP in Timeline.tsx / HardwareVisualizer.tsx; those are T-1's files and not T-2's responsibility per the roadmap ownership table) |

## What shipped (per series)

1. **AI heatmap** — series index 0, `type: 'heatmap'`, 16 × 8 log-binned grid, duration-weighted per Nsight Compute convention. Bin edges and cell contents computed in `buildHeatmap()` helper. Opacity 0.55 so underlying lines stay readable.
2. **Per-kernel duration bands** — series index 1, `type: 'custom'` with a `renderItem` closure that draws each kernel as a dashed rectangle spanning ±20 % around its (AI, GOPS) point — Intel-Advisor integrated-roofline trajectory segment analogue.
3. **Dual-workload overlay** — conditional series triple (Alt DDR ceiling, Alt URAM ceiling, Alt kernels) gated on a second `.pccx` being loaded via the new `Compare .pccx…` toolbar button. Button wires `load_pccx_alt` + `fetch_trace_payload_b` the same way FlameGraph.tsx does (mirror of `:177,193`). Dashed lines + diamond markers distinguish workload B from workload A.

## New Rust surface

- `RooflineBand` struct with doc-comment citations to **Ilic 2014 CARM (DOI 10.1109/L-CA.2013.6)** and **Yang 2020 Hierarchical Roofline (arXiv:2009.02449)**.
- `analyze_hierarchical(trace, hw) -> Vec<RooflineBand>` — emits four bands (Register / URAM L1 / L2 SRAM / DDR4) with per-tier peak BW, ridge AI, and dwell-cycle attribution.
- `#[tauri::command] analyze_roofline_hierarchical(state) -> Result<Vec<RooflineBand>, String>` registered in the handler list. UI invokes it on mount and on every `trace-loaded` event.

## Live KERNELS derivation

- `parseTraceEvents(Uint8Array) -> TraceEvent[]` — inlined flat-buffer v2 parser that shares the `FLAT_BUFFER_V2_MAGIC` constant with FlameGraph / core/trace.rs so the Roofline panel does not take a dependency on FlameGraph.
- `reduceTraceToKernels(events) -> Kernel[]` — buckets events by (coreId, typeId), rolls up per-type aggregates, emits one kernel row per type with per-core dwell in the tooltip note. MAC_COMPUTE → GEMM at AI=128; DMA_READ/WRITE → DMA at AI=0.25.
- `useMemo` guards both the primary and alt kernel derivations so re-renders are cheap.

## Test commands — transcripts

```
$ cd /home/hwkim/Desktop/github/pccx-lab/src/core && cargo test --lib
...
test roofline::tests::test_all_dma_trace_is_memory_bound ... ok
test roofline::tests::test_all_mac_trace_is_compute_bound ... ok
test roofline::tests::test_analyze_hierarchical_emits_four_bands_monotonic_bw ... ok
test roofline::tests::test_analyze_hierarchical_empty_trace_emits_structural_bands ... ok
test roofline::tests::test_empty_trace_returns_zero_intensity ... ok
test roofline::tests::test_peak_gops_matches_hw_model ... ok
...
test result: ok. 59 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
cargo-test exit=0
```

```
$ cd /home/hwkim/Desktop/github/pccx-lab/src/ui/src-tauri && cargo check
    Checking pccx-core v0.1.0
    Checking pccx-ai-copilot v0.1.0
    Checking srcui v0.1.0
warning: unused imports: `RegisterSnapshot` and `step_to_cycle as step_to_cycle_fn`
  --> src/lib.rs:11:32
   (T-1 WIP — not T-2 responsibility)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.04s
cargo-check exit=0
```

```
$ cd /home/hwkim/Desktop/github/pccx-lab/src/ui && npx tsc --noEmit
(pre-stash-pop, before T-1's WIP was reinstated into the tree)
exit=0

(post-stash-pop, after T-1's WIP Timeline.tsx / HardwareVisualizer.tsx was
 restored in the working tree, T-1's unused-variable errors surface — these
 are T-1's files and not touched by my commit 5d3eb43. My commit itself
 passes tsc cleanly; `grep -c "Roofline" tsc-output` returns 0.)
```

## Coordination notes

- Worked in parallel with T-1 `implementer_ui`. T-1 landed `src/core/src/step_snapshot.rs`, `src/ui/src/hooks/useCycleCursor.ts`, and hunks in `src/core/src/lib.rs` + `src/ui/src-tauri/src/lib.rs`. All T-1 changes were left **unstaged** by my commit — I used `git apply --cached` with hand-crafted patches to stage only my hunks in the two shared `lib.rs` files.
- After commit, `git stash pop` restored the main-thread WIP (App.tsx + i18n.tsx + scripts/) and T-1's current uncommitted work. No merge conflicts with 5d3eb43.

## Deferred / Future work

- `RooflineCard.tsx` sidebar tile was listed as *optional* in the ticket and not modified this round — its consumer is the verification dashboard and that page didn't surface any card-width complaints in the judge report.
- The per-tier AI span inside `RooflineBand` currently synthesises from the tier's ridge (±½ decade) because pccx's `.pccx` payload does not yet carry per-event byte counters. When the v003 schema lands the AI span can be computed directly from per-event bytes — doc-comment inside `analyze_hierarchical` records this as the extension path.
- Ceiling sensitivity slider ("what if DDR BW doubled?") — explicitly deferred to Round 7 per the roadmap.

## Out-of-scope items I did NOT touch

- `Timeline.tsx`, `WaveformViewer.tsx`, `HardwareVisualizer.tsx`, `FlameGraph.tsx`, `CanvasView.tsx`, `MemoryDump.tsx`, `ScenarioFlow.tsx`, `TestbenchAuthor.tsx`, `App.tsx`, `i18n.tsx`, `scripts/` — all out of T-2 scope.
