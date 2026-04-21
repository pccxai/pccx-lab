# Research Findings — Round 6 — 2026-04-21

Scope: three topics mapped 1:1 to the Judge's Top-3 priorities. Every
citation carries a DOI, arXiv ID, or official spec URL. Local code
anchors use absolute paths under `/home/hwkim/Desktop/github/pccx-lab`.

---

## T-A — Cycle-granular single-step / scrubber UX (HW/EDA SOTA)

### Summary
- Commercial + open HW waveform viewers converge on three primitives:
  (1) *next/prev transition on focused signal*, (2) *absolute go-to-time*,
  (3) *cursor snap to event grid*. Surfer names them `transition_next` /
  `transition_previous`, `cursor_set <TIME>`, `goto_time <TIME>`.
- Surfer 0.2.0 release notes (published on researcher Frans Skarman's
  project blog) confirm **arrow keys jump cursor to next / previous
  edge of the focused variable** — the exact binding the Judge calls
  out as missing in pccx-lab's `WaveformViewer.tsx`.
- GTKWave binds **left/right arrow in the wave window to "find next
  transition of selected signal(s)"** per the 3.3 User Guide; the
  long-standing SourceForge bug #1 confirms behaviour when multiple
  signals are selected.
- IEEE 1364-2005 (VCD standard) defines time events as a monotonic
  stream of `#<time>` records. A ring-buffer cursor over the parsed
  event list lets "next edge" run in O(log N) via binary search on
  the already-sorted timestamp array — no separate index needed.
- Perfetto (Chrome Trace UI) uses **W/S for zoom, A/D for pan, and
  click-drag for cursor**, plus a deep-linking `ts=<nanoseconds>`
  URL parameter so the same cursor snap API is serialisable.
- Recommended React binding surface (derived from Surfer + GTKWave +
  Perfetto UX): `stepToCycle(n)`, `stepEdge(direction, signalId?)`,
  `snapToGrid(cpp: number)`.

### Canonical sources
- Williams / GTKWave User Guide 3.3 (arrow-key edge navigation):
  https://gtkwave.sourceforge.net/gtkwave.pdf
- Surfer command reference (`transition_next`, `cursor_set`,
  `goto_time`): https://docs.surfer-project.org/book/commands/index.html
- Surfer 0.2.0 release note confirming default arrow-key binding:
  https://blog.surfer-project.org/v0-2-0/
- IEEE 1364-2005 Verilog HDL, VCD section (Annex 18):
  https://ieeexplore.ieee.org/document/1620780 (DOI
  10.1109/IEEESTD.2006.99495)
- Perfetto UI docs — WASD nav, canvas overlay, deep-linking:
  https://perfetto.dev/docs/visualization/perfetto-ui
- Perfetto UI deep-link spec: https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui
- Efficient VCD parsing (shows ring-buffer event scan):
  doi:10.1109/TCAD.2024.3378905 —
  https://ieeexplore.ieee.org/document/10477457

### Open questions
- pccx's `.pccx` payload currently carries events as
  `{startCycle, duration}`; do we need an explicit per-signal event
  index (like GTKWave's `fst_read_next_transition`) to make
  Shift+Arrow O(log N) instead of O(N)?
- Should bindings be hard-coded (Verdi / Surfer style) or
  user-customisable (Perfetto style)? Suggest: hard-code Round 6,
  migrate to customisable later via a single `keymap.ts` module.

### Recommendation (concrete)
Add a `useCycleCursor(totalCycles)` React hook to a new file
`/home/hwkim/Desktop/github/pccx-lab/src/ui/src/hooks/useCycleCursor.ts`
that exposes `{ cycle, setCycle, stepBy(n), stepEdge(direction, signalId?), goToCycle(n) }`.
Wire it into `WaveformViewer.tsx` (around `:840`, alongside the
existing `Ctrl+B` bookmark handler), `Timeline.tsx` (`:369` filter
region), `HardwareVisualizer.tsx` (`:318–322` auto-advance), and
`FlameGraph.tsx` (`:263` toolbar). Key bindings, per Surfer 0.2.0 +
GTKWave: `ArrowRight/Left` = prev/next edge on focused signal;
`Shift+Arrow` = ±1 cycle; `Ctrl+G` = prompt for "go to cycle N";
`.` / `,` mirror of arrow keys for mouse-heavy users (Verdi convention).
A matching Rust IPC command `step_to_cycle(cycle: u64) -> StateSnapshot`
belongs in
`/home/hwkim/Desktop/github/pccx-lab/src/core/src/lib.rs`
so that register / MAC-array state can be queried at any cycle without
a JS-side recompute.

---

## T-B — Roofline 2.0 (heatmap / per-kernel bands / multi-workload)

### Summary
- The canonical paper (Williams, Waterman, Patterson 2009, CACM 52:4)
  frames the roofline as a log-log plot of attainable FLOP/s vs
  arithmetic intensity (FLOP/byte). All extensions below layer *more
  ceilings* or *richer kernel markers* on top of the same axes.
- Ilic, Pratas, Sousa 2014 ("Cache-Aware Roofline Model: Upgrading the
  Loft", IEEE CAL 13:1, DOI 10.1109/L-CA.2013.6) adds per-cache-level
  bandwidth roofs; *arithmetic intensity becomes an algorithm property,
  not a working-set property* — crucial for INT4 kernels in pccx v002
  where L1/L2/URAM/DDR all have different peaks.
- Yang et al. "Hierarchical Roofline Analysis" (arXiv:2009.02449,
  2020) is the reference implementation used by LBNL on
  NERSC systems. Data-collection recipe is directly
  transferable: collect (1) bytes from each cache level, (2) FLOPs,
  (3) runtime, then emit one line per hierarchy level.
- Nsight Compute's hierarchical roofline UI adds L1/L2/DRAM ceilings
  in a single chart + per-kernel dots with colour-coded
  stall reasons; **section files are user-authorable**, so pccx-lab
  can adopt the same "one chart, many ceilings" pattern trivially.
- Intel Advisor "Integrated Roofline" goes further: every memory-level
  sample is emitted as a *trajectory segment* rather than a single
  dot, letting the user see operational-intensity drift across phases
  of a kernel. This is exactly what the Judge asked for ("per-kernel
  duration bands").
- Lopes et al. 2021 ("Mansard Roofline Model", TOMPECS 6:3,
  DOI 10.1145/3475866) adds sloped roofs for mixed-precision peaks —
  directly applicable to pccx INT4/INT16 dual-mode DSP packing.

### Canonical sources
- Williams 2009, DOI 10.1145/1498765.1498785 —
  https://dl.acm.org/doi/10.1145/1498765.1498785
- Ilic 2014 CARM, DOI 10.1109/L-CA.2013.6 —
  https://ieeexplore.ieee.org/document/6506838
- Yang 2020 Hierarchical Roofline, arXiv:2009.02449 —
  https://arxiv.org/abs/2009.02449
- Koskela et al. "Novel roofline model for deep learning",
  arXiv:2009.05257 — https://arxiv.org/abs/2009.05257
- Lopes 2021 Mansard Roofline, DOI 10.1145/3475866 —
  https://dl.acm.org/doi/10.1145/3475866
- Intel Advisor Cache-Aware Roofline docs:
  https://www.intel.com/content/www/us/en/developer/articles/technical/memory-level-roofline-model-with-advisor.html
- NVIDIA Nsight Compute Roofline section (hierarchical model):
  https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html#roofline-charts
- LBNL Empirical Roofline Toolkit (reference impl):
  https://crd.lbl.gov/divisions/amcr/computer-science-amcr/par/research/roofline/software/ert/
- Samuel Williams "Introduction to the Roofline Model" (LBNL 2025):
  https://amcr.lbl.gov/wp-content/uploads/2025/11/roofline-intro.pdf

### Open questions
- pccx v002 has four effective memory tiers (register file / URAM /
  L2 SRAM / HBM2). Does the hardware counter set in the `.pccx`
  payload already expose per-tier byte counts, or must
  `src/core/src/lib.rs::analyze_roofline` synthesise them from
  `LiveSample.bytes_l1`, `bytes_l2`, `bytes_ddr`?
- For the intensity heatmap: should bin counts come from event count
  or weighted by `duration_cycles`? Nsight Compute uses duration-
  weighted, which avoids one-cycle spans dominating the view.

### Recommendation (concrete)
Extend `/home/hwkim/Desktop/github/pccx-lab/src/ui/src/Roofline.tsx`
with three ECharts series additions between `:126` and `:170`:
(1) `type: 'heatmap'` over 16 log-AI × 8 log-GOPS bins, duration-
weighted per Nsight Compute; (2) `type: 'custom'` per-kernel bands
using `LiveSample.mac_util` min/max across the `useLiveWindow` ring
(mimics Intel Advisor's integrated-roofline trajectory segments);
(3) a second ceiling set driven by `load_pccx_alt` + the existing
`fetch_trace_payload_b` IPC in `FlameGraph.tsx:177,193`, rendered
as dashed lines (CARM-style cache-level overlay). The existing
`KERNELS` literal at `:30-43` should be replaced by a
`useMemo(() => reduceTraceToKernels(trace), [trace])` with fallback
to the literal only when `fetch_trace_payload` returns < 24 bytes.
Add a companion Rust helper
`analyze_roofline_hierarchical(trace: &Trace) -> Vec<RoofBand>`
in `/home/hwkim/Desktop/github/pccx-lab/src/core/src/roofline.rs`
that emits one band per cache level, sized by dwell cycles — cite
Ilic 2014 DOI in a doc-comment.

---

## T-C — 60 fps Apple-grade canvas / WebGL rendering

### Summary
- **OffscreenCanvas + Worker** is the current W3C-spec answer to main-
  thread jank. `canvas.transferControlToOffscreen()` yields an
  `OffscreenCanvas` that is `postMessage`-transferable; the worker
  owns the GL context and renders independently of React reconciliation.
  Three.js ships a canonical example (`webgl_worker_offscreencanvas`).
- Rendering into a worker decouples the render loop from React's
  concurrent mode entirely — no `startTransition` needed for the
  GL path, but `useDeferredValue` still helps throttle React-side
  panels (FlameGraph tooltip, Timeline info readout).
- `requestAnimationFrame` is paused by the browser when the tab is
  hidden (MDN spec explicit), but only if the RAF loop lives on the
  main thread. Worker-owned RAF loops **are not auto-paused** — the
  app must check `document.visibilityState === "hidden"` on the main
  thread and explicitly `postMessage({type: 'pause'})` to workers.
- For Canvas2D heavy tabs (Timeline, FlameGraph, Waveform) that are
  not yet worker-moved, the answer is RAF-coalesced redraw: replace
  "draw on every `onMouseMove`" with "mark dirty + RAF commits once
  per frame". Chrome DevTools Performance, Perfetto UI, and
  Speedscope all use this idiom; Perfetto's `raf-scheduler` is the
  cleanest reference.
- React 19 `startTransition` + `useDeferredValue` demote non-urgent
  state updates (hover tooltips, sidebar summary re-renders) so the
  65 k-event trace scrub stays interruptible.
- Static/dynamic layer split (Perfetto "overlay" API, Chrome Trace
  Viewer "grid vs. slice" compositing) keeps the expensive per-frame
  redraw to O(visible slices) instead of O(total layout nodes).

### Canonical sources
- OffscreenCanvas spec (HTML Living Standard, Canvas section
  §4.12.5.2): https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface
- MDN OffscreenCanvas reference:
  https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- MDN Page Visibility API (visibilitychange, document.visibilityState):
  https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN `Window.requestAnimationFrame` (auto-throttled in hidden tabs):
  https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- MDN `DedicatedWorkerGlobalScope.requestAnimationFrame`:
  https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/requestAnimationFrame
- Three.js InstancedBufferAttribute API:
  https://threejs.org/docs/api/en/core/InstancedBufferAttribute.html
- Three.js "How to Update Things" (needsUpdate + usage hints):
  https://threejs.org/manual/en/how-to-update-things.html
- Three.js OffscreenCanvas example:
  https://threejs.org/examples/webgl_worker_offscreencanvas.html
- React 19 release (async transitions, useTransition):
  https://react.dev/blog/2024/12/05/react-19
- React `useDeferredValue`:
  https://react.dev/reference/react/useDeferredValue
- React `startTransition`:
  https://react.dev/reference/react/startTransition
- Perfetto UI architecture (Mithril + canvas overlay, raf scheduler):
  https://perfetto.dev/docs/contributing/ui-plugins
- Chrome DevTools Performance `performance_analyze_insight` inline
  docs (rendering pipeline reference):
  https://developer.chrome.com/docs/devtools/performance

### Open questions
- Tauri 2 WebView (WebKitGTK on Linux, WebView2 on Windows) —
  does it support `transferControlToOffscreen` uniformly? WebKitGTK
  ≥ 2.40 ships it, but on macOS the Safari Technology Preview only
  landed full OffscreenCanvas+WebGL2 in 17.x. Verify on the KV260
  dev host before committing the whole Hardware Visualizer to a
  worker; fallback path is "main-thread RAF + BufferGeometry
  reuse".
- Is it worth moving `HardwareVisualizer`'s Canvas2D ELK layout into
  a worker, or is the win dominated by killing the `setInterval(50ms)`
  + full redraw? Cheap first step: RAF-coalesce + layer split;
  only escalate to OffscreenCanvas if Chrome Performance still shows
  >16ms frames.

### Recommendation (concrete)
Three staged edits:

1. Create `/home/hwkim/Desktop/github/pccx-lab/src/ui/src/hooks/useRafScheduler.ts`
   exposing `scheduleDraw(draw: () => void)` that coalesces multiple
   dirty calls per RAF (Perfetto-style). Wire it into the `draw()`
   call sites in `Timeline.tsx:296-322`, `FlameGraph.tsx:263-349`,
   and `WaveformViewer.tsx` so `onMouseMove` only marks dirty.

2. Create `/home/hwkim/Desktop/github/pccx-lab/src/ui/src/hooks/useVisibilityGate.ts`
   that returns a boolean derived from `document.visibilityState` +
   an IntersectionObserver on the host element. Gate every
   `requestAnimationFrame` loop (`HardwareVisualizer.tsx:318-322`,
   `CanvasView.tsx:158-192`) on that boolean — an Apple-grade app
   never renders an off-screen tab.

3. In `/home/hwkim/Desktop/github/pccx-lab/src/ui/src/CanvasView.tsx`,
   replace the per-frame `setColorAt` sweep at `:173-188` with a
   sparse-update pattern: maintain a `Set<number>` of dirty instance
   indices on the React side, push only those via
   `InstancedBufferAttribute.updateRange` per Three.js "How to Update
   Things". For the longer horizon, create
   `/home/hwkim/Desktop/github/pccx-lab/src/ui/src/workers/hardwareRenderer.worker.ts`
   and migrate `HardwareVisualizer.tsx` to the OffscreenCanvas
   pattern from the Three.js canonical example, keeping main-thread
   React state in sync via a throttled `postMessage({type: 'state',
   cycle})`. Acceptance: Chrome DevTools trace of a mouse-drag
   scrub on Timeline + an active HardwareVisualizer shows zero
   main-thread frames longer than 16 ms, matching the user's
   "Apple-grade" bar.

---

(Document length ≈ 260 lines, well under the 400-line cap.)
