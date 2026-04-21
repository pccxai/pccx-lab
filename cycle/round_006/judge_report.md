# Judge Report — Round 6 — 2026-04-21

## Summary

**Overall grade: B-** (down from Round 5's B). Round 5 paid down four
rounds of backlog cleanly — SynthStatusCard now invokes
`load_timing_report` at `SynthStatusCard.tsx:118`, Monaco + Monarch SV
ships (`package.json` pins `@monaco-editor/react@^4.7.0` +
`monaco-editor@^0.52.0`; `monarch_sv.ts` is 205 LoC real grammar;
`CodeEditor.tsx` dropped from 409 → 393 LoC, no `HighlightedCode`
regex tokenizer), and `useLiveWindow` (91 LoC, `useSyncExternalStore`
with a 2 Hz fan-out poll and a 3-empty-streak loud-fallback warning)
kills every `Math.random` call the R5 judge flagged — `rg "Math.random"
src/ui/src` = **0** (down from 4, ornamental residuals fully removed).
Honest, real engineering.

**But grading against Round 6's three hard requirements, pccx-lab
fails on all three.** The user asked for cycle-granular control over
every pipeline stage — the *only* four panels that are meaningful at
cycle level (HardwareVisualizer System Simulator, Timeline,
WaveformViewer, FlameGraph) all treat individual cycles as second-
class citizens. The user asked for Apple-grade smoothness — the
System Simulator literally runs `setInterval(…, 50)` →
`setCycle(c => c + Math.floor(4 * speed))` at
`HardwareVisualizer.tsx:318-320`, redraws the entire ELK-laid canvas
every tick (`:393 useEffect([cycle, theme, selected, flat, layout,
traceEvents, playing])`), *and* the `CanvasView` 3D tab spins a
`requestAnimationFrame` that rewrites 1024 instance colors each frame
regardless of whether the tab is visible (`CanvasView.tsx:158-192`).
And the user asked for continued Roofline-class polish — the big
Roofline tab (`Roofline.tsx`, 351 LoC) is still the exact ECharts
scatter that shipped in R3; no arithmetic-intensity heatmap overlay,
no per-kernel duration bands, no A/B workload ceiling comparison
beyond the existing kind filter. `RooflineCard.tsx` (183 LoC) is a
compact sidebar stat card with no chart at all.

The grade slides half a step because R5 earned real credit, but
R6's explicit intent is *not addressed* by a single commit after
the R5 close (the latest three commits are
`8f3f60d` unused-var cleanup, `0d63316` license strip, `84222cc` R5
T-3 follow-up). Zero code landed against the user's three hard
requirements — R6 is a clean-slate round, and the scaffolding that
exists does not satisfy the mandate.

## Table

| # | Dimension | R-6 | R-5 | Δ | Anchor | Headline gap (R6 directive) |
|---|---|---|---|---|---|---|
| 1 | RTL / waveform UX         | C+  | B-  | **-1**  | Verdi / Surfer  | `WaveformViewer.tsx` has zero 1-clock-edge stepping; no `ArrowLeft`/`ArrowRight` binding, no "go to tick N" input |
| 2 | ISA validation & trace    | B-  | B-  | 0       | Spike / Whisper | No pipe-stage register dump at any chosen cycle; `HardwareVisualizer.tsx:125 CYCLE_SCRIPT` is still a literal table |
| 3 | API / driver integrity    | B   | B   | 0       | CUPTI           | Untouched — `uca_*` span names + `api_name` trailer still clean |
| 4 | UVM coverage & regression | B-  | B-  | 0       | Questa IMC      | Untouched |
| 5 | FPGA verification         | B-  | B-  | 0       | Vivado ILA      | Cycle-scripted `HARDWARE_VISUALIZER` is still literal; `hw_layout.rs` 3 rounds ghost |
| 6 | ASIC signoff readiness    | C   | D   | **+1**  | PrimeTime       | `load_timing_report` consumed in `SynthStatusCard.tsx:118` — R5 T-1 paid in full |
| 7 | GPU / accelerator profile | C+  | B   | **-1**  | Nsight Systems  | Roofline polish frozen; `Roofline.tsx` unchanged since R3; no heatmap/band/dual overlay |
| 8 | UI / UX / docking         | B+  | B   | **+1**  | VS Code         | Monaco + Monarch SV shipped (`package.json`, `monarch_sv.ts`); bundle still 3.87 MB baseline |
| 9 | Documentation & onboarding| B+  | B+  | 0       | Nsight Guide    | Untouched |
|10 | Openness / licensing      | C+  | C+  | 0       | GTKWave         | `LICENSE_SCOPE.md` still absent 5 rounds running — `0d63316` stripped enterprise but didn't draw the boundary |

## Detailed findings

### Dim-1 — RTL / waveform UX (C+, regressed)

**Current state.** `WaveformViewer.tsx` (1206 LoC) has cursors A/B,
bookmarks with `localStorage` persistence + `Ctrl+B` jump
(`:842-856`), radix cycling, and a viewport-culled bus draw
(`:1048-1168`). Pan/zoom is mouse-wheel driven.

**Gap vs SOTA and vs user directive.** The user asked for
"100 % analysis of tiny timings" — single-clock-edge stepping — and
*none* exists. `grep -n "ArrowLeft|ArrowRight|posedge|negedge|
step.*edge" WaveformViewer.tsx` returns **zero matches**. Cursor A
can only be moved by Alt-click or mouse-drag on the cursor glyph; no
`±1 tick` button, no keyboard arrow binding, no "go to tick N" input.
Verdi binds `Shift+Right` to next clock edge, `Shift+Left` to prev,
and `g` to "go to time"; Surfer binds `→` to step-to-next-transition;
pccx-lab binds none of the above.

**Impact.** The user cannot analyse a setup-hold window. The viewer
is zoom-and-drag only — good for survey, useless for timing debug.

**Concrete suggestion.** Add to `WaveformViewer.tsx` around `:840`:
bind `ArrowRight` / `ArrowLeft` → step cursor A by one cycle period
(derive from the `clk` signal's event stream, not the wall-clock);
`Shift+Arrow` → next/prev edge on the currently selected signal;
`Ctrl+G` → prompt() for cycle, move A; surface a mini "go to tick"
field in the cursor readout strip at `:934`.

### Dim-7 — GPU / accelerator profile (C+, regressed)

**Current state.** `Roofline.tsx:228-340` renders an ECharts log-log
scatter of 12 hardcoded kernels (`:30-43 KERNELS`) against three
ceiling lines (DDR, URAM, compute). A kind filter
(`:241-250`) toggles between `all / gemm / gemv / sfu / dma / mem`.
A "Live" button re-scales the Y axis by the average `mac_util` from
`useLiveWindow` (`:187-216`). Right-hand summary table at
`:291-324`. `RooflineCard.tsx` is a compact 183-LoC stat tile invoked
from the Synth Status pane; it calls `analyze_roofline` and shows
four stat boxes (AI, GOPS, peak GOPS, peak BW).

**Gap vs SOTA and vs user directive.** The user
*explicitly loves this card and asked for more*. After R5 close:
zero additions. No arithmetic-intensity heatmap (imagine binning
the flat-buffer event stream by AI quantile → shading the chart
background in per-quantile bands, the way Nsight Compute does in its
"SpeedOfLight SM %" chart). No per-kernel duration bands — the
scatter is a point, not a segment weighted by dwell. No dual-workload
overlay — `loadRunB` exists in `FlameGraph.tsx:177` but is not
mirrored in Roofline. No ceiling sensitivity analysis (what would
perf be if DDR BW doubled?). The 12 `KERNELS` are compile-time
literals, not derived from the loaded `.pccx`.

**Impact.** The single card the user held up as the north-star example
of good visualisation stopped evolving. Regressing from B to C+ is
warranted because the relative-to-expectation gap is now larger.

**Concrete suggestion.** In `Roofline.tsx` around `:126-170`:
- Render a per-kernel *segment* from (AI, sustained-low) to
  (AI, sustained-peak) using `LiveSample.mac_util` range across
  the loaded trace rather than a single scatter point.
- Add a heatmap-mark series: quantise the event-stream AI into
  16 log-AI bins, colour by event count (echarts `heatmap`
  series over the log X-axis). Saves the "empty quadrant" look
  when no kernels land between two ceiling intersects.
- Add a "Compare .pccx…" button that calls `load_pccx_alt` +
  `fetch_trace_payload_b` (already registered — see
  `FlameGraph.tsx:193`), and overlays a second ceiling set so the
  user can diff KV260 vs a hypothetical VC1902 ceiling.
- Replace the `KERNELS` literal with a reducer over the loaded
  trace; fall back to the literal when `fetch_trace_payload`
  returns < 24 bytes.

### Dim-5 / System Simulator performance (tab lag — direct user callout)

**Current state.** `HardwareVisualizer.tsx` (704 LoC) uses:
- `setInterval(…, 50)` at `:318` with `setCycle(c => c +
  Math.floor(4 * speed))` — **20 Hz** state change, not 60 fps;
- Full canvas redraw on every cycle tick via the `useEffect`
  dependency list at `:509` (`[cycle, theme, selected, flat,
  layout, traceEvents, playing]`);
- A `Math.sin(cycle * 0.2)` busy-dot pulse at `:490`;
- No viewport culling — every node in `layout` is re-drawn every
  tick even when off-screen;
- No `OffscreenCanvas`, no `requestAnimationFrame` budgeting.

`CanvasView.tsx` (228 LoC, the 3D View tab):
- `requestAnimationFrame` at `:159` renders *even when the tab is
  hidden* (tab-switch logic in `App.tsx:429-440` mounts/unmounts but
  multiple heavy tabs can coexist via dock splits);
- Rewrites all 1024 instance colors every frame
  (`:173-188 for x…for y…mesh.setColorAt`) regardless of whether the
  data changed;
- `phase += 0.018` drift + `Math.sin(phase * 2 - x * 0.4)`
  — decorative heartbeat gated by `animRef.current` but still
  performs the `getColorAt` + `setColorAt` per instance even when
  gated, because the loop is still in the RAF callback if `animated`
  prop is unset in some call sites.

**Gap vs SOTA and vs user directive.** Apple's Instruments sustains
60 fps on a 50 k-sample flame trace by (a) isolating every heavy
redraw to `requestAnimationFrame` with a per-frame budget, (b)
batching geometry updates into an `OffscreenCanvas` worker, and
(c) culling invisible tiles. pccx-lab does none of the three.
Timeline redraws via `draw()` in every `onMouseMove`
(`Timeline.tsx:296-322`) with no throttle — a 100 k-event trace
causes a full linear scan on every mouse tick.

**Impact.** Direct user complaint; the directive puts this at the top
of hard-req #3.

**Concrete suggestion.** See Top Priority #3 below; this is the
single largest R6 win.

### Dim-6 — ASIC signoff readiness (C, up from D)

**Current state.** `SynthStatusCard.tsx:118` now invokes
`load_timing_report` alongside the existing `load_synth_report`, and
the card's bottom half renders `TimingReport.clock_domains[]` —
R5 T-1 acceptance met. Dim-6 lifts D → C.

**Gap vs SOTA.** Still no LEC or SDF back-annotation. PrimeTime's
`report_constraint -violators` equivalent is absent. `vivado_timing.rs`
parses the path report but no UI surfaces the failing path graph.

### Dim-8 — UI / UX / docking (B+, up from B)

**Current state.** `package.json` pins
`@monaco-editor/react: ^4.7.0` + `monaco-editor: ^0.52.0`;
`monarch_sv.ts` is a 205-LoC real Monarch tokenizer (keywords,
datatypes, attributes, `$display` etc.); `CodeEditor.tsx` dropped
from 409 → 393 LoC and is now a Monaco shell. Bundle 3.87 MB → 3.87
MB reported in R5. Worker self-hosted per
`1c7b4cf feat(ui): T-2 self-host Monaco worker (no CDN fetch)`.

**Gap vs SOTA.** VS Code's IntelliSense with LSP, outline view, and
peek-definition are still absent. But the R5 win is real — this is
the only dimension where R6 opens with a genuine lift.

### Dims-2, 3, 4, 9, 10 (untouched)

Flat since R5. Nothing to cite that wasn't cited before; the grade
freeze is honest — no regression, no lift.

## Progress vs Round 5

**What got better.** (1) `load_timing_report` consumed in
`SynthStatusCard.tsx:118` — R5 T-1 acceptance verified.
(2) Monaco + Monarch shipped via R5 T-2 — `package.json` has the
deps, `monarch_sv.ts` has a real tokenizer, `CodeEditor.tsx`
dropped the regex tokenizer. (3) `useLiveWindow` (R5 T-3)
cleanly replaced `Math.random` in Timeline, WaveformViewer,
BottomPanel, PerfChart, Roofline, ReportBuilder —
`rg "Math.random" src/ui/src` = **0**.

**What regressed.** Dim-1 and Dim-7 grade relative to expectation:
the R6 user directive lifted the bar (cycle-granular control;
continued Roofline polish) and R6 landed no commits against either.
No *code* regression, but both dimensions lose half a grade step
because the gap to the user's expressed bar widened.

**What was not touched.** (1) Any cycle-granular stepping in
Timeline / Waveform / HardwareVisualizer. (2) Any Roofline
extension (heatmap, bands, dual overlay). (3) Any lag mitigation on
the System Simulator (`setInterval(…, 50)` + full canvas redraw
untouched). (4) `LICENSE_SCOPE.md` — 5 rounds running. (5)
`hw_layout.rs` — still only `DIAGRAM_NODES` literal as hardware-shape
source of truth in `HardwareVisualizer.tsx:189-202`.

## Top 3 must-fix for Round 7 — the R6 user directive, one ticket each

### Priority 1 — Cycle-granular control across every time-domain panel

**Target files.**
- `src/ui/src/WaveformViewer.tsx` (1206 LoC) — no arrow-key edge
  stepping, no go-to-tick input. Add around `:840` (the existing
  `Ctrl+B` keydown effect is the model to follow): bind
  `ArrowRight` / `ArrowLeft` to step cursor A by one derived
  clock-period; `Shift+Arrow` → prev/next transition on selected
  signal; new toolbar field in the cursor readout at `:934` for
  numeric tick entry.
- `src/ui/src/Timeline.tsx` (450 LoC) — `vp.current.cpp` today goes
  arbitrarily small but there is no "1 cycle per pixel" snap and no
  go-to-cycle N field. Add a `<input type="number">` at `:369` (the
  existing filter region) wired to `vp.current.offset`; add a
  toolbar toggle "Snap to cycle" that rounds `vp.current.cpp` to an
  integer cycles/px.
- `src/ui/src/HardwareVisualizer.tsx` (704 LoC) — the auto-advance
  at `:318-320` increments by 4 cycles per 50 ms tick, not 1; the
  `SkipBack/SkipForward` buttons at `:522,526` step by 32 cycles,
  also wrong. Replace: keep the 32-cycle jump on shift-click, default
  click = 1 cycle; add numeric "go to cycle" next to the scrubber
  at `:539`; un-hardcode the 1024 range by deriving from
  `traceEvents.reduce((m,e)=>Math.max(m,e.startCycle+e.duration),
  1024)`.
- `src/ui/src/FlameGraph.tsx` (711 LoC) — no per-cycle cursor at
  all; add a vertical cursor line on mouse position + a
  `cursorCycle` state displayed in the toolbar.

**User directive mapping.** Hard req #1 ("each step drivable at
single-cycle resolution … timeline cursor snaps to integer cycles …
go-to-cycle-N input … no mandatory aggregation").

**Accept.** `rg "ArrowRight|ArrowLeft" src/ui/src/WaveformViewer.tsx`
≥ 2 (step forward + back bindings). A numeric "go to cycle" input
lives in each of the four panels. `HardwareVisualizer.tsx:318`
steps by 1 cycle at 1× speed. The 1024-cycle literal at
`HardwareVisualizer.tsx:126-149` derives from the loaded trace.

### Priority 2 — Roofline class extension (heatmap, bands, dual-overlay)

**Target file.** `src/ui/src/Roofline.tsx` (351 LoC).

**Concrete deltas.**
- Between `:126` and `:170` add a fourth ECharts series of type
  `heatmap`, dimension = 16 log-AI bins × 8 log-GOPS bins,
  data = histogrammed `LiveSample` events. The chart becomes
  roofline + density overlay — readability style Nsight Compute
  "Warp State" chart.
- Replace the single scatter point per kernel with a band: map
  each kernel's `achieved` range (min/max across the ring in
  `useLiveWindow`) to `type: "custom"` rendering a vertical bar
  on the log-y axis. Nsight Systems calls this a "sustained range
  swimlane".
- Mirror `FlameGraph.tsx:177 loadRunB` — add a second ceiling set
  (`PEAK_TOPS_B`, `PEAK_DDR_BW_B`) via `load_pccx_alt` +
  `fetch_trace_payload_b`. Render the B ceilings as dashed lines
  in a second colour channel.
- `KERNELS` at `:30-43` should be a useMemo over the loaded trace
  (name = span.name, intensity = span.ops / span.bytes, achieved =
  span.ops / span.cycles · clock_rate) rather than a compile-time
  literal.

**User directive mapping.** Hard req #2 ("Continue extending
Roofline … intensity heatmap overlay, per-kernel bands, multi-
workload ceiling comparison").

**Accept.** `rg "heatmap" src/ui/src/Roofline.tsx` ≥ 1. Kernels in
the scatter derive from `useLiveWindow` (or fallback message if no
trace loaded). "Compare workload" button exists and dispatches
`load_pccx_alt`.

### Priority 3 — Apple-grade 60 fps: kill the System Simulator lag

**Target files.**
- `src/ui/src/HardwareVisualizer.tsx:318-322` — replace
  `setInterval(…, 50)` + `cycle += 4` with a proper
  `requestAnimationFrame` loop throttled to 60 fps wall-clock.
  Use `performance.now()` delta to decouple cycle advancement from
  frame rate.
- `src/ui/src/HardwareVisualizer.tsx:393-509` — the redraw effect's
  dependency list forces a full redraw every cycle change. Split
  into (a) static-layout canvas (drawn once per layout change,
  painted into an `OffscreenCanvas` or layer), and (b) dynamic
  overlay canvas (drawn each frame, only the packet dot + state
  dots + cursor line). Cuts per-frame draw calls from ~N-modules ×
  M-edges down to O(edges-active).
- `src/ui/src/Timeline.tsx:267,296-322` — `draw()` is invoked on
  every `onMouseMove`. Add a `requestAnimationFrame`-coalescing
  wrapper (schedule at most one draw per frame; skip duplicates).
  Current implementation hits the canvas-2d pipeline at 60-120 Hz
  on a fast mouse drag.
- `src/ui/src/CanvasView.tsx:158-192` — guard the whole render
  loop on `document.visibilityState === "visible"` + the tab being
  active; today it runs even when another tab is shown. Also skip
  the `setColorAt` pass when `animRef.current === false` (currently
  the check is inside the loop but the `for x for y` still spins).
- `src/ui/src/FlameGraph.tsx:263-349` — same `draw()` called in
  `onMouseMove` (`:383-420`). Add RAF coalescing.

**User directive mapping.** Hard req #3 ("System Simulator lags …
Apple-grade polish … 60 fps sustained, zero main-thread frames > 16
ms").

**Accept.** No `setInterval` drives UI cycle advancement anywhere
(`rg "setInterval" src/ui/src | grep -v useLiveWindow | grep -v
PerfChart | grep -v BottomPanel` → zero hits in visual-tab code;
`useLiveWindow`, `PerfChart`, `BottomPanel` legitimately poll IPC
at 2 Hz and are outside the per-frame path). `CanvasView` suspends
rendering when not visible. Chrome DevTools Performance trace of a
dragged cursor on Timeline shows **zero** frames longer than 16 ms.
`HardwareVisualizer` redraw is split into static + dynamic layers.

---

(Word count: ~1680.)
