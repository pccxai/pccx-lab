# Roadmap — Round 6 — 2026-04-21

Three tickets, one per user directive. Implementers run in parallel; see
per-file ownership map in "Coordination" below to prevent silent overlap
between T-1 and T-3 on `Timeline.tsx` / `WaveformViewer.tsx` /
`HardwareVisualizer.tsx`.

## Coordination (T-1 vs T-3 per-file ownership)

| File | T-1 owns | T-3 owns |
|---|---|---|
| `WaveformViewer.tsx` | `useCycleCursor` wiring + `ArrowLeft/Right/Shift+Arrow/Ctrl+G` keydown block (insert near existing `Ctrl+B` handler, around `:840-856`); numeric "go to tick" field in the cursor readout strip (`:934`) | No edits this round — waveform already uses viewport-culled bus draw; defer RAF migration to Round 7 |
| `Timeline.tsx` | "Go to cycle N" input + "Snap to cycle" toggle in the filter region (`:369` area); cursor cycle state + integer-snap math in `vp.current` | `draw()` RAF coalescing wrapper over `onMouseMove` call sites (`:296-322`); `draw()` body must remain T-1-compatible (no signature change) |
| `HardwareVisualizer.tsx` | Replace `setCycle(c => c + Math.floor(4*speed))` at `:318-320` with **value semantics only** — 1 cycle per tick at 1× speed, default Skip±=1 cycle, Shift+Skip=32 cycles; numeric "go to cycle" input at `:539`; derive max cycle from `traceEvents` not literal 1024 | Replace the `setInterval(…, 50)` **scheduling mechanism** at `:315-322` with a `useRafScheduler`-driven loop using `performance.now()` delta; split the redraw effect (`:393/:509`) into static-layout + dynamic-overlay layers; gate on `useVisibilityGate` |
| `FlameGraph.tsx` | Vertical cursor line + `cursorCycle` state displayed in toolbar; wire into `useCycleCursor` | RAF-coalesce `draw()` at `onMouseMove` sites (`:383-420` → schedules dirty commit at `:263-349`) |
| `CanvasView.tsx` | — | `useVisibilityGate` guard on RAF loop (`:158-192`); sparse `setColorAt` via `InstancedBufferAttribute.updateRange` |
| `Roofline.tsx` | — | — (owned by T-2) |

Rule: **T-1 never edits `draw()` bodies or RAF call sites; T-3 never edits
key bindings, cursor-cycle state, or numeric inputs.** If an implementer
hits ambiguity, the owning ticket decides and the other ticket reviews.

---

## T-1 — UI: cycle-granular control across Timeline / Waveform / Simulator / FlameGraph

**Goal.** Make every time-domain panel drivable at single-clock resolution
so the user can analyse a setup/hold-class timing event with keyboard +
"go to cycle N" input — no mandatory aggregation. (User directive #1.)

**Owner.** `implementer_ui`.

**Files to create / modify (≈800 LoC diff target).**
- CREATE `src/ui/src/hooks/useCycleCursor.ts` (~120 LoC) — exports
  `{ cycle, setCycle, stepBy(n), stepEdge(direction, signalId?), goToCycle(n) }`.
  Accepts `totalCycles` + optional per-signal event index; binary-search
  over the pre-sorted timestamp array for `stepEdge` so it is O(log N)
  per IEEE 1364-2005 §Annex 18 VCD sort guarantee.
- MODIFY `src/ui/src/WaveformViewer.tsx` (~150 LoC net) — add keydown
  effect near `:840-856` binding `ArrowRight/Left` → `stepEdge(±1, focusedSignalId)`,
  `Shift+Arrow` → `stepBy(±1)` cycle, `Ctrl+G` → `window.prompt` then
  `goToCycle`; insert numeric tick input in the cursor readout strip at
  `:934`; wire cursor A to `useCycleCursor`. **Do not** touch the
  `:1048-1168` bus-draw block.
- MODIFY `src/ui/src/Timeline.tsx` (~110 LoC net) — add `<input type="number">`
  in the `:369` filter region for "Go to cycle N" + a "Snap to cycle" toggle
  that rounds `vp.current.cpp` to integer cycles/px when on. **Do not**
  touch the `draw()` body or `onMouseMove` scheduling — that is T-3.
- MODIFY `src/ui/src/HardwareVisualizer.tsx` (~180 LoC net) — fix cycle
  semantics only: 1 cycle per tick at 1× speed (leave the scheduling
  mechanism to T-3; use whatever scheduler lands first and publish the
  `cycle` state via `useCycleCursor`); SkipBack/SkipForward buttons at
  `:522,526` default to ±1 cycle, Shift-click = ±32; derive max cycle
  from `traceEvents.reduce((m,e)=>Math.max(m, e.startCycle+e.duration), 1024)`;
  numeric "go to cycle" input next to the scrubber at `:539`.
- MODIFY `src/ui/src/FlameGraph.tsx` (~100 LoC net) — vertical cursor
  line on current hover cycle; toolbar readout of `cursorCycle`; hook
  into `useCycleCursor` so Arrow/Shift+Arrow also moves the FlameGraph
  cursor when it is the focused panel.

**Acceptance (each testable).**
1. `rg "ArrowRight|ArrowLeft" src/ui/src/WaveformViewer.tsx` returns ≥ 2
   matches (step-forward + step-back handlers present).
2. Pressing `ArrowRight` with focus on `WaveformViewer` advances cursor A
   to the next posedge of the *focused signal* (derived from the parsed
   event stream, not a wall-clock increment).
3. Each of `WaveformViewer`, `Timeline`, `HardwareVisualizer`,
   `FlameGraph` surfaces a numeric "go to cycle" input; entering `N`
   moves the respective cursor to cycle `N` exactly (integer snap).
4. `HardwareVisualizer` at speed 1× advances by exactly **1** cycle per
   tick; at speed 4× by exactly **4** cycles per tick (no `Math.floor(4*speed)`
   residue).
5. `HardwareVisualizer` max cycle is no longer the literal `1024` — it
   is `max(startCycle+duration)` across `traceEvents`, with a fallback
   of 1024 when `traceEvents` is empty.
6. `cd src/ui && npx tsc --noEmit` passes.

**Out of scope (explicit).**
- No `draw()` RAF coalescing (T-3).
- No `setInterval` replacement or visibility gating (T-3).
- No Roofline or `Roofline.tsx` edits (T-2).
- No Rust-side `step_to_cycle` IPC — deferred to Round 7 (listed in
  research as an open question; shipping the UI-only path first is
  lower-risk).
- No keymap customisation module; bindings are hard-coded this round
  (Surfer / GTKWave convention).

**Test commands.**
- `cd src/ui && npx tsc --noEmit`
- `cd src/ui && npm run build`
- Manual: load any `.pccx`, in each of the four panels confirm
  Arrow/Shift+Arrow/Ctrl+G and numeric go-to-cycle behaviours.

**References.**
- research_findings.md T-A summary: Surfer `transition_next` /
  `cursor_set` / `goto_time` (https://docs.surfer-project.org/book/commands/index.html).
- GTKWave 3.3 arrow-key edge nav (https://gtkwave.sourceforge.net/gtkwave.pdf).
- Surfer 0.2.0 release notes, arrow → next-edge binding
  (https://blog.surfer-project.org/v0-2-0/).
- IEEE 1364-2005 VCD §Annex 18, DOI 10.1109/IEEESTD.2006.99495.

**Risk.** If the `.pccx` payload lacks a per-signal event index today,
`stepEdge` may need a fallback that filters the flat event stream on the
JS side — acceptable but O(N) per key press for a large trace. Mitigation:
memoise the filtered array per focused `signalId`.

---

## T-2 — UI+CORE: Roofline 2.0 extensions (heatmap / per-kernel bands / dual-workload overlay)

**Goal.** Push the user's favourite card to Nsight-Compute / Intel-Advisor
class: add duration-weighted arithmetic-intensity heatmap, per-kernel
sustained-range bands, and a second-ceiling dual-workload overlay driven
by the existing `load_pccx_alt` + `fetch_trace_payload_b` IPC. (User directive #2.)

**Owners.** Primary `implementer_ui` on `Roofline.tsx`; handoff to
`implementer_core` for the Rust-side `analyze_roofline_hierarchical`
helper. Both land in the **same** ticket / same session / same branch;
`implementer_core` finishes first and exposes the command, then
`implementer_ui` wires it in. One ticket, two actors, explicit baton.

**Files to create / modify (≈700 LoC diff target).**
- MODIFY `src/core/src/roofline.rs` (~140 LoC net, `implementer_core`) —
  add `pub fn analyze_hierarchical(trace: &NpuTrace, hw: &HardwareModel) -> Vec<RoofBand>`
  returning one `RoofBand { level, peak_gops, peak_bw_gbps, dwell_cycles,
  ai_min, ai_max }` per memory tier (register / URAM / L2 / DDR). Cite
  Ilic 2014 CARM (DOI 10.1109/L-CA.2013.6) and Yang 2020 Hierarchical
  Roofline (arXiv:2009.02449) in a doc comment.
- MODIFY `src/core/src/lib.rs` (~30 LoC) — register
  `#[tauri::command] fn analyze_roofline_hierarchical(...)` exposing the
  new function to the UI; extend the existing `analyze_roofline`
  payload type rather than mutate it.
- MODIFY `src/core/src/bin` or nearest test file (~40 LoC, `implementer_core`)
  — one `#[test]` exercising `analyze_hierarchical` against a synthetic
  4-level trace; assert one band per level and monotonic `peak_bw_gbps`.
- MODIFY `src/ui/src/Roofline.tsx` (~280 LoC net, `implementer_ui`) —
  between `:126-170` add three ECharts series:
  1. `type: 'heatmap'` over 16 log-AI × 8 log-GOPS bins, cell weight =
     sum of `duration_cycles` (Nsight-Compute style, not event count).
  2. `type: 'custom'` per-kernel vertical bands from `LiveSample.mac_util`
     min/max across the `useLiveWindow` ring (Intel-Advisor trajectory-
     segment mimic).
  3. Second dashed ceiling set driven by `load_pccx_alt` +
     `fetch_trace_payload_b`; add a "Compare .pccx…" button in the
     toolbar mirroring `FlameGraph.tsx:177,193`.
  Replace the `KERNELS` literal at `:30-43` with
  `useMemo(() => reduceTraceToKernels(trace), [trace])`; fall back to
  the literal only when `fetch_trace_payload` returns < 24 bytes.
- MODIFY `src/ui/src/Roofline.tsx` (continued) — wire the new
  hierarchical series by calling `invoke('analyze_roofline_hierarchical')`
  once on trace load; cache in state; re-render on `load_pccx_alt`
  completion.

**Acceptance.**
1. `rg "heatmap" src/ui/src/Roofline.tsx` returns ≥ 1.
2. `rg "type: 'custom'|type: \"custom\"" src/ui/src/Roofline.tsx` returns ≥ 1
   (per-kernel band series present).
3. With a `.pccx` loaded AND `load_pccx_alt` already called, the chart
   renders **three** series simultaneously: heatmap background + kernel
   bands + dual ceiling set (primary solid, alt dashed).
4. The `KERNELS` array at `:30-43` is replaced by a `useMemo` reducer over
   the loaded trace payload (rg "KERNELS =" → 0 top-level const matches).
5. `cd src/core && cargo test` includes a new passing test for
   `analyze_hierarchical`.
6. `cd src/ui && npx tsc --noEmit` passes.

**Out of scope.**
- `RooflineCard.tsx` sidebar tile — leave untouched (T-2 would bloat).
- Ceiling sensitivity slider ("what if DDR BW doubled?") — mentioned in
  judge report but explicitly deferred to Round 7.
- Monaco / CodeEditor / bundle-size work.
- Any `setInterval` / RAF changes elsewhere (T-3).

**Test commands.**
- `cd src/core && cargo test`
- `cd src/ui && npx tsc --noEmit`
- `cd src/ui && npm run build`
- Manual: load two `.pccx` workloads in sequence; confirm the alt-ceiling
  dashed lines appear after the second load.

**References.**
- research_findings.md T-B: Williams 2009 (DOI 10.1145/1498765.1498785),
  Ilic 2014 CARM (DOI 10.1109/L-CA.2013.6), Yang 2020 arXiv:2009.02449,
  Lopes 2021 Mansard (DOI 10.1145/3475866), Nsight Compute hierarchical
  roofline docs, Intel Advisor integrated roofline docs.

**Risk.** `.pccx` payloads may not yet expose per-tier byte counters;
if so, `analyze_hierarchical` must synthesise bytes from
`LiveSample.bytes_l1/l2/ddr`. If those fields are missing too,
`implementer_core` must widen the sample schema — this expands the ticket
and is the single most likely derailment. Mitigation: check `LiveSample`
struct first; if insufficient, cut to 2 tiers (URAM + DDR) and defer the
full 4-tier hierarchy to Round 7.

---

## T-3 — UI: 60 fps Apple-grade perf (RAF coalescing + visibility gating + sparse Three.js updates)

**Goal.** Kill the System Simulator / Timeline / FlameGraph / 3D-View lag
so a 5-second Timeline pan drag on a 1600×1000 window records zero
main-thread frames longer than 16 ms — the user's "Apple-grade" bar. (User directive #3.)

**Owner.** `implementer_ui`.

**Files to create / modify (≈900 LoC diff target).**
- CREATE `src/ui/src/hooks/useRafScheduler.ts` (~80 LoC) — exports
  `scheduleDraw(key: string, draw: () => void)` that coalesces multiple
  dirty calls per RAF (Perfetto raf-scheduler idiom). Latest
  `draw` fn per key wins within a frame; a single RAF callback fires
  the queue in insertion order.
- CREATE `src/ui/src/hooks/useVisibilityGate.ts` (~70 LoC) — returns a
  boolean from `document.visibilityState === 'visible'` intersected with
  an `IntersectionObserver` on the provided host element ref. RAF loops
  consume this + skip scheduling when false.
- MODIFY `src/ui/src/HardwareVisualizer.tsx` (~200 LoC net) —
  replace the `setInterval(…, 50)` + `cycle += Math.floor(4*speed)` at
  `:315-322` with a `useRafScheduler`-driven loop using
  `performance.now()` delta to decouple cycle advancement from frame
  rate (T-1 publishes the `cycle` state via `useCycleCursor`; T-3 only
  changes **how** it advances). Split the redraw effect's dependency
  list (`:393,509 [cycle, theme, selected, flat, layout, traceEvents,
  playing]`) into two layers: (a) static-layout canvas drawn once per
  layout change, cached in an `OffscreenCanvas` or second `<canvas>`;
  (b) dynamic overlay drawn on each RAF commit — only packet dot +
  state dots + cursor line. Gate the whole RAF loop on `useVisibilityGate`.
- MODIFY `src/ui/src/Timeline.tsx` (~60 LoC net) — wrap the `draw()`
  calls inside `onMouseMove` (`:296-322`) with `scheduleDraw('timeline',
  draw)`; never call `draw()` synchronously in the mouse path. **No
  edits to `draw()` internals or `vp.current` state.** (T-1 owns the
  `vp.current` cursor/snap fields.)
- MODIFY `src/ui/src/FlameGraph.tsx` (~70 LoC net) — same RAF-coalesce
  wrapper over `draw()` at `:263-349`; the `onMouseMove` site at
  `:383-420` switches to `scheduleDraw('flamegraph', draw)`.
- MODIFY `src/ui/src/CanvasView.tsx` (~90 LoC net) — guard the RAF loop
  at `:158-192` on `useVisibilityGate`; replace the full
  `for x for y for mesh.setColorAt` sweep with a sparse update pattern
  using `InstancedBufferAttribute.updateRange` so only dirty instances
  push to the GPU. When `animRef.current === false`, skip the loop body
  entirely (don't just skip `setColorAt`).
- OPTIONAL — create a stub `src/ui/src/workers/hardwareRenderer.worker.ts`
  skeleton (~40 LoC) but **do not** migrate `HardwareVisualizer` onto it
  this round. Committed as a placeholder for Round 7 only if time permits.

**Acceptance.**
1. `rg "setInterval" src/ui/src | grep -vE "(useLiveWindow|PerfChart|BottomPanel)"`
   returns zero hits (the three allow-listed files legitimately poll IPC
   at 2 Hz and are outside the per-frame path).
2. Chrome DevTools Performance tape of a 5-second mouse-drag pan on
   `Timeline` with `HardwareVisualizer` visible in an adjacent dock
   panel records **zero** main-thread tasks > 16 ms (capture with
   `mcp__chrome-devtools__performance_start_trace` / `_stop_trace`;
   attach screenshot / JSON path in the implementer report).
3. Switching tabs or minimising the window pauses every RAF loop
   (`CanvasView`, `HardwareVisualizer`, `Timeline`, `FlameGraph`) within
   one frame; CPU usage while minimised drops to baseline idle.
4. `HardwareVisualizer` renders only the dynamic overlay per frame; the
   static-layout canvas is painted exactly once per layout change (verify
   via a `console.count('static-redraw')` hook left in place during the
   session, removed before commit).
5. `CanvasView`'s `setColorAt` fires only for instance indices that
   changed since the last frame (verify via a per-frame diff counter).
6. `cd src/ui && npx tsc --noEmit` passes.
7. `cd src/ui && npm run build` passes and bundle size does **not**
   regress more than +40 KB gzipped (baseline 3.87 MB per judge report).

**Out of scope.**
- No cursor / key-binding / numeric-input work (T-1).
- No Roofline edits (T-2).
- No full OffscreenCanvas worker migration (worker file is a stub only).
- No React 19 `useDeferredValue` refactor of sidebar components —
  defer to Round 7; scope creep risk is high.
- No `Math.random` reintroduction anywhere (R5 earned rg=0; keep it).

**Test commands.**
- `cd src/ui && npx tsc --noEmit`
- `cd src/ui && npm run build`
- `rg "setInterval" src/ui/src | grep -vE "(useLiveWindow|PerfChart|BottomPanel)"`
  (expect no output)
- Manual Chrome DevTools Performance trace per acceptance criterion #2.
- Manual: use browser task manager to confirm background-tab CPU drop.

**References.**
- research_findings.md T-C: OffscreenCanvas W3C spec, MDN Page Visibility
  API, MDN `Window.requestAnimationFrame` auto-throttle, Three.js
  `InstancedBufferAttribute.updateRange`, Perfetto UI plugin architecture
  (raf-scheduler idiom), Chrome DevTools Performance docs.

**Risk.** The layer-split in `HardwareVisualizer` depends on ELK layout
being stable across cycle changes (it is — layout depends only on
`flat` + `layout`, both memoised). If the judge test harness runs
headless without a real GPU, the DevTools trace acceptance must be
demonstrated on the developer machine, not CI — mitigation: capture
trace JSON + attach to the commit / implementer report.

---

## Backlog (do not attempt this round)

- LSP / outline-view / peek-definition for Monaco — Dim-8 polish; out of
  R6 directive scope.
- `LICENSE_SCOPE.md` (5-round ghost) — real but not user-directive; pick
  up in R7 if R6 lands cleanly.
- `hw_layout.rs` as hardware-shape source of truth replacing
  `DIAGRAM_NODES` literal in `HardwareVisualizer.tsx:189-202`.
- Rust `step_to_cycle(cycle) -> StateSnapshot` IPC (deferred from T-1).
- Ceiling sensitivity slider in Roofline (deferred from T-2).
- Full OffscreenCanvas worker migration of HardwareVisualizer (deferred
  from T-3; stub only).
- React 19 `useDeferredValue` / `startTransition` refactor (deferred
  from T-3).
- Customisable keymap module (`keymap.ts`) — hard-coded this round.
