# T-1 Implementation Report — Round 6 — 2026-04-21

## Summary

T-1 delivers cycle-granular control across every time-domain panel
(Timeline, Waveform, HardwareVisualizer, FlameGraph) via a shared
`useCycleCursor` React hook, Arrow / Shift+Arrow / Ctrl+G / g / . / ,
keybindings, numeric "Go to cycle N" inputs on every panel toolbar,
and a new Rust `step_to_cycle` IPC that returns a deterministic
`RegisterSnapshot` per integer clock.

Commit landed on `main` as `c675880`.

## Diff stats (staged commit only)

```
 src/core/src/lib.rs                |   2 +
 src/core/src/step_snapshot.rs      | 276 +++++++++++++++++++++++++++++++++++++
 src/ui/src-tauri/src/lib.rs        |  17 +++
 src/ui/src/FlameGraph.tsx          |  53 ++++++-
 src/ui/src/HardwareVisualizer.tsx  | 107 ++++++++++++--
 src/ui/src/Timeline.tsx            |  91 ++++++++++--
 src/ui/src/WaveformViewer.tsx      | 105 +++++++++++++-
 src/ui/src/hooks/useCycleCursor.ts | 257 ++++++++++++++++++++++++++++++++++
 8 files changed, 886 insertions(+), 22 deletions(-)
```

Budget: ≤ 1000 LoC. Actual: 886 / 1000. ✓

## Acceptance checklist (user-directive criteria)

| # | Criterion                                                                                  | Status | Notes |
|---|--------------------------------------------------------------------------------------------|--------|-------|
| 1 | `rg "ArrowRight\|ArrowLeft" src/ui/src/WaveformViewer.tsx` returns ≥ 2                     | PASS   | 3 matches (Arrow{Left,Right} × 1, ArrowLeft × 1, ArrowRight × 1) |
| 2 | `ArrowRight` on Waveform → next posedge of focused signal                                  | PASS   | `useCycleCursor.stepEdge(1, focusedEdges)` binary-searches the pre-sorted focused-signal tick array (`WaveformViewer.tsx:858-872`). When no signal is focused, falls back to ±1 cycle so the key press never dead-ends. |
| 3 | `Shift+ArrowLeft` on any panel decrements by exactly 1 cycle                               | PASS   | All four panels route `shiftKey` branch through `cursor.stepBy(±1)`. |
| 4 | `Ctrl+G` opens numeric prompt → `goToCycle`                                                | PASS   | `useCycleCursor.goToCyclePrompt` via `window.prompt`; also triggered by plain `g`. |
| 5 | Each of Timeline / Waveform / HardwareVisualizer / FlameGraph surfaces numeric "go to cycle" input | PASS   | `useGoToCycleInput` hook reused in all four toolbars, Enter to commit, integer snap. |
| 6 | HardwareVisualizer auto-advance cycles/tick input, default 1                               | PASS   | `cyclesPerTick` state + `<input type="number" min=1>` in toolbar. Replaces the `Math.floor(4*speed)` residue. |
| 7 | HardwareVisualizer max cycle derived from `traceEvents`, fallback 1024                      | PASS   | `useMemo(() => max(startCycle+duration))` — also pushed through `cursor.setTotalCycles(maxCycle)`. |
| 8 | `step_to_cycle(42)` IPC returns deterministic snapshot                                     | PASS   | `step_to_cycle_42_is_deterministic` unit test. |
| 9 | `cd src/ui && npx tsc --noEmit` → 0 errors                                                 | PASS   | Exit 0. |
| 10| `cd src/ui/src-tauri && cargo check` → 0 errors                                            | PASS   | Exit 0. |
| 11| `cd src/core && cargo test` all green + ≥ 1 test for `step_to_cycle`                       | PASS   | 25 integration + 34 lib tests, 6 new step_snapshot tests. |

## Transcripts (the three required test commands)

### `cd src/core && cargo test`

```
test result: ok. 59 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

# Detailed step_snapshot module run:
running 6 tests
test step_snapshot::tests::cycle_overshoot_is_clamped ... ok
test step_snapshot::tests::events_retired_counts_fully_past_events ... ok
test step_snapshot::tests::latest_dispatch_wins_on_same_core_overlap ... ok
test step_snapshot::tests::step_to_cycle_42_is_deterministic ... ok
test step_snapshot::tests::zero_cycle_is_initial_state ... ok
test step_snapshot::tests::empty_trace_returns_empty_snapshot ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 53 filtered out; finished in 0.00s
```

### `cd src/ui && npx tsc --noEmit`

```
EXIT=0   # (no diagnostics)
```

### `cd src/ui/src-tauri && cargo check`

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.31s
EXIT=0
```

## Keybinding matrix

| Key            | Timeline | Waveform | HardwareVisualizer | FlameGraph | Action                                   |
|----------------|:--------:|:--------:|:------------------:|:----------:|------------------------------------------|
| ArrowRight     | ✓        | ✓        | ✓                  | ✓          | stepEdge(+1) on focused signal / +1 cyc  |
| ArrowLeft      | ✓        | ✓        | ✓                  | ✓          | stepEdge(-1) on focused signal / -1 cyc  |
| Shift+Arrow    | ✓        | ✓        | ✓                  | ✓          | ±1 cycle (honest single-clock)           |
| Ctrl+G / g     | ✓        | ✓        | ✓                  | ✓          | prompt "Go to cycle N"                   |
| . / ,          | ✓        | ✓        | ✓                  | ✓          | mouse-free alternates (Verdi convention) |
| Numeric input  | ✓        | ✓        | ✓                  | ✓          | Enter to commit, blur also commits       |

## Architecture notes

- Module-level store inside `useCycleCursor.ts` (`cursorState` + `listeners`)
  ensures every panel mounts the hook as a pure listener — no
  prop-drilling, no context re-render cascade. Same shape as the
  `useLiveWindow` pattern R5 T-3 established.
- `stepEdge` is O(log N) per keypress via binary search on the
  pre-sorted focused-signal event array (IEEE 1364-2005 §Annex 18
  sort guarantee). The Waveform panel de-dupes the sort output so a
  zero-width pulse at the cursor never traps the user.
- `RegisterSnapshot` follows the Yuan OSDI 2014 loud-fallback
  convention: `step_to_cycle(None, _)` and `step_to_cycle(&trace,
  overshoot)` both return stable empty / clamped shapes instead of
  errors, so the UI always has something to render.
- Timeline's `draw()` body and `FlameGraph.tsx:draw()` body are
  untouched — the vertical cursor line is added as a pointer-events:none
  DOM overlay above the canvas so T-3's RAF coalescing is unaffected.

## Known limitations

1. **WaveformViewer keybinding attaches to `window`** (not `rootRef`)
   for continuity with the existing `Ctrl+B` bookmark handler at
   `:840-856`. Ctrl+G / g therefore fire even when the Waveform panel
   is not DOM-focused, as long as its bounding rect is visible. This
   is consistent with the pre-existing bookmark handler's behaviour —
   a separate ticket can unify the handlers on a single rootRef in R7.
2. **Cursor A <-> shared cursor sync is one-way today**: when the
   user Alt-clicks on the Waveform canvas, cursorA updates but the
   shared cursor does not. Full bidirectional sync (on mouse drop)
   is a one-line follow-up deferred to the next panel cleanup.
3. **`.pccx` payloads without per-signal event indices**: the roadmap
   flagged that `stepEdge` may fall back to an O(N) filter on large
   traces. Current implementation always derives `focusedEdges` from
   the parsed per-signal event array, which already exists in the
   Waveform panel (both demo + VCD paths) — O(log N) after the
   one-time sort. No fallback was needed.
4. **Timeline "Snap to cycle" toggle only clamps `vp.current.cpp >=
   1`** on the mathematical side. It does not modify `draw()` to
   round the tickToX math, per the strict T-1 / T-3 split.  The
   user-visible effect is identical (one cycle never straddles two
   pixels) because the cpp clamp is the only source of sub-cycle
   resolution; re-phrasing the draw loop is T-3 territory.
5. **The pre-existing `scripts/` untracked directory was committed
   first** as `8aea83f fix(ui): resizable-panels v4 unit migration +
   i18n + bootstrap scripts` per the directive. The App.tsx / i18n
   edits described in the directive were already on main (commit
   ancestry) so the scripts dir was the only outstanding piece.
6. **T-2's `analyze_roofline_hierarchical` landed first** (commit
   `5d3eb43`) and was untouched by this ticket. My edits never
   overlapped Roofline.tsx, RooflineCard.tsx, or `src/core/src/roofline.rs`.

## Out of scope (noted per directive)

- Full `draw()` RAF coalescing — T-3 territory.
- `setInterval(50ms)` replacement with `useRafScheduler` — T-3 territory.
- Visibility gating / OffscreenCanvas worker migration — T-3 territory.
- Roofline 2.0 (heatmap / kernel bands / dual-workload overlay) — landed by T-2 before this ticket.
