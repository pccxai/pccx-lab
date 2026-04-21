# User Directive — Round 6 (2026-04-21)

Received verbatim from the user immediately before the loop resumed:

> 루프 돌리고 각각 단계들 클럭 단위로 컨트롤 가능하게 해줘, 정말 작은 타이밍도
> 100% 분석 가능하게 해야돼. roofline같은 시각화 너무 좋네 계속 강화해줘
> 시스템을 렉 안걸리게(지금 system simulator가 조금 렉 걸리네. Apple 프로그램
> 급으로 최적화 잘 해서 렉 안걸리게 해줘 꼭!!)

## Three hard requirements

1. **Cycle-granular control** — every pipeline stage, simulator step,
   and waveform must be drivable at single-cycle resolution. Concretely:
   - Single-step forward / backward by exactly one clock edge from the
     Timeline / Waveform / System Simulator / Memory panels.
   - Timeline cursor snaps to integer cycles; zoom level reaches
     "1 cycle per pixel" without losing event markers.
   - Register / memory / MAC-array state is inspectable at any chosen
     cycle (scrubber + "go to cycle N" input).
   - No mandatory aggregation or windowing — aggregation is opt-in only.

2. **Visualisation — keep pushing Roofline-class polish**
   The user explicitly loves the Roofline card. Continue extending it
   (arithmetic-intensity heatmap overlay, per-kernel bands, multi-
   workload ceiling comparison) and carry the same visual-density /
   readability standard into every analysis panel.

3. **Performance — "Apple-grade" smoothness**
   The System Simulator tab currently lags visibly. Target:
   - Sustained 60 fps on a 1600×1000 window while scrolling / zooming.
   - Zero main-thread frames longer than 16 ms.
   - GPU-accelerated rendering where possible (Three.js / WebGL 2 /
     OffscreenCanvas / `requestAnimationFrame` budgeting).
   - Same UX standard as Apple's Instruments / Xcode profiler.
   This applies to *every* heavy tab (System Simulator, 3D View,
   FlameGraph, Waveform), not just HardwareVisualizer.

## Pre-round-6 maintenance already shipped on main (today, 2026-04-21)

The judge should NOT re-raise these as new issues in its report; they
are already fixed and are on main locally:

- **react-resizable-panels v4 unit migration**: all `defaultSize={24}`
  style literals in `src/ui/src/App.tsx` migrated to `"24%"` strings
  because v4 treats `number` as px rather than percent (breaking
  change from v3). Right-dock AI Copilot + Live Telemetry now grow to
  `maxSize="70%"` correctly; center-panel content wrapper got
  `min-w-0 min-h-0` to stop tabs from pushing the flex container
  out of the viewport.
- **i18n leak fix**: 14 new keys under `copilot.*` in
  `src/ui/src/i18n.tsx`; all Korean string literals in `App.tsx`
  (trace-load success / failure, IPC / HTTP / API / UVM / generic
  errors, context label, sample-question block, keyboard hint) now
  route through `t()`. English mode is now fully English.
- **`scripts/` bootstrap**: `setup_env.sh` (system / rust / node /
  install / verify subcommands, all idempotent), `run_dev.sh`
  (cargo + nvm sourced wrapper), `doctor.sh` (read-only diagnostic),
  `README.md` explaining the AI-agent-friendly exit-code contract.

## Where to aim

Judge should evaluate Round 5's landed tickets (SynthStatusCard
`load_timing_report`, Monaco+Monarch SV, `useLiveWindow` hook) against
these three user requirements. Likely Round 6 hotspots:

- **HardwareVisualizer / System Simulator** — suspected GPU hog;
  check Three.js instancing, texture updates per frame, whether it
  re-renders on every live-window poll.
- **Timeline / Waveform / FlameGraph** — no per-cycle scrubber today;
  Timeline lacks "go to cycle N" input; Waveform has no 1-clock-edge
  step binding.
- **Roofline** — already a strong card; push further with intensity
  heatmap, per-kernel bands, dual-workload overlay.

Hand the judge a full copy of this file so it grades against Round 6
intent rather than generic criteria.
