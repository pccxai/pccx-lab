# Implemented — UI — Round 5

## Ticket T-3: Finish `Math.random|Math.sin` dragnet via `useLiveWindow`

- Primary commit: `679e386` —
  `feat(ui): T-3 useLiveWindow hook + kill Math.random in 6 panels`
- Follow-up commit: _(this round, see below)_ —
  tightens HardwareVisualizer gating and wires `useLiveWindow` into
  `ReportBuilder` so the import isn't dead.
- Files touched (combined):
  - `src/ui/src/hooks/useLiveWindow.ts` (new, 91 LoC) — the hook.
  - `src/ui/src/WaveformViewer.tsx` (+28 / −3) — `p_accum` sourced
    from the hook when a real trace is loaded; seeded deterministically
    (no RNG) for the first-run demo.
  - `src/ui/src/Timeline.tsx` (+15 / −5) — deterministic demo
    durations; header pill now shows `liveEventRate` from the hook.
  - `src/ui/src/ReportBuilder.tsx` (+36 / −14) — utilisation grid
    renders real per-core `mac_util` from the hook, or a dashed
    "no trace" notice (Yuan 2014 loud-fallback) when empty.
  - `src/ui/src/ExtensionManager.tsx` (+4 / −1) — fixed 20 %/tick
    install-bar progression replaces RNG.
  - `src/ui/src/CanvasView.tsx` (+31 / −19) — removed dead
    heartbeat pulse (scale was never written back), gated remaining
    colour-wave behind `animated={isPlaying}` prop (default true).
  - `src/ui/src/HardwareVisualizer.tsx` (+5 / −2) — busy-dot pulse
    gated on existing `playing` state; useCallback dep list updated.

## Acceptance self-check

- [x] `rg "Math\.random" src/ui/src` → **0 hits**.
- [x] `rg "Math\.random|Math\.sin" src/ui/src | wc -l` → **2**
  (CanvasView.tsx:182 wave, HardwareVisualizer.tsx:486 busy-dot —
  both behind explicit animation guards: `animRef.current` and
  `playing` respectively).
- [x] `src/ui/src/hooks/useLiveWindow.ts` exists (91 LoC).
- [x] `rg "useSyncExternalStore" src/ui/src/hooks/useLiveWindow.ts`
  → **2 hits** (import + call site inside the hook).
- [x] `rg "useLiveWindow" src/ui/src` → **4 files** (hook itself +
  WaveformViewer + Timeline + ReportBuilder).
- [x] WaveformViewer / Timeline / ReportBuilder / ExtensionManager /
  CanvasView / HardwareVisualizer all type-check and build via
  `npx tsc --noEmit` + `npx vite build` (build succeeded in ~26 s,
  same 7.22 MB main chunk as R4).
- [x] No regression in the R4-migrated files (BottomPanel.tsx,
  PerfChart.tsx, Roofline.tsx) — the shared hook reads from the
  same `fetch_live_window` IPC; inspection confirms they still
  compile against the untouched `LiveSample` schema.

## What landed

1. **`useLiveWindow` hook.** Module-level store + single
   `setInterval(poll, 500)` fan-outs to every subscriber via
   `useSyncExternalStore` so React 19 concurrent rendering cannot
   tear across a sample update. `getServerSnapshot` returns the
   frozen `EMPTY` object so SSR hydration checks stay stable.
   Empty streak of 3 triggers one `console.warn` (Yuan OSDI 2014
   loud-fallback, emitted once per streak boundary to avoid drowning
   the console).
2. **Honest empty states everywhere.** Every consumer renders a
   dashed "no trace" card / pill / empty-lane overlay when the hook
   reports `hasTrace: false`, rather than synthesising values with
   RNG or falling back to hard-coded percentiles. This mirrors the
   R4 `(synthetic)` pattern landed on `FlameGraph.tsx:549`.
3. **Ornamental animations gated.** The two remaining `Math.sin`
   sites are decorative, not data sources:
   - `CanvasView.tsx:182` — column-wave colour shimmer, guarded by
     `animRef.current` (fed from the new `animated` / `isPlaying`
     prop, default true to preserve `<CanvasView />` call-site).
   - `HardwareVisualizer.tsx:486` — busy-dot breathing glow, guarded
     by the existing `playing` state so a paused timeline shows a
     steady dot. Added `playing` to the `useCallback` deps so the
     canvas redraws when play/pause toggles.

## Deferred

Nothing from T-3 scope. The five R4-era panels that already used
`fetch_live_window` directly (BottomPanel, PerfChart, Roofline)
still each hold their own `useEffect` poller. Consolidating them
onto the new shared hook is a pure-refactor follow-up (drops
roughly 40 LoC of duplicated polling boilerplate) — not required
by T-3's acceptance and out of the 250-LoC ceiling once you add
the verification surface. Filed as a R6 backlog candidate.

## Notes

- Net diff: primary commit 204 insertions / 40 deletions (≈ 164
  net) + follow-up 16 insertions / 3 deletions (≈ 13 net) = **~177
  LoC net**, well under the 250-LoC ceiling.
- `tsc --noEmit` still reports 8 pre-existing `TS6133` unused-local
  warnings on `CanvasView.tsx:6-10` (`TYPE_MAC_COMPUTE` et al.),
  `ReportBuilder.tsx:333`, `ReportBuilder.tsx:488`, and
  `Timeline.tsx:381`. Same as T-1's note — orthogonal to T-3, not
  introduced here (verified by stash-reverify).
- Primary T-3 commit (`679e386`) landed the core hook + five panel
  migrations but left the HardwareVisualizer pulse un-gated and
  the `ReportBuilder` `useLiveWindow` import dead (no call-site).
  Follow-up fixes both: HW pulse now honours `playing`, and
  ReportBuilder actually calls the hook and flows `coreUtils`
  through `PreviewSection` props so the utilisation grid renders
  from live `mac_util` samples.
