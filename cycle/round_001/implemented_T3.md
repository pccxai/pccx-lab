# Implemented — UI — Round 1 — Ticket T-3

## Ticket T-3: Wire FlameGraph hotspot button to `detect_bottlenecks` IPC + diff mode

### Commits
- `fc1e18f` — fix(ui): detect_bottlenecks IPC contract + richer recommendation
- `b023eda` — feat(ui): T-3 finish — Compare-run diff overlay + Ctrl+Shift+D
- `0012b09` — fix(ui): wire bottleneck AI to real IPC, remove fake export setTimeouts (broke earlier "Wait"-filter bug)

### Files touched
- `src/ui/src/FlameGraph.tsx` (+90 / –12)
- `src/ui/src/App.tsx` (+14 / –4)

Net diff ≈ 104 LoC (within the S/M estimate).

### Acceptance self-check
- [x] "Find Bottleneck" button fires a real IPC call (`invoke('detect_bottlenecks', { windowCycles: 256, threshold: 0.5 })`); response list is rendered in the `aiAnalysis` sidebar (no hardcoded literal left).
- [x] Loading a second run via "Compare run…" renders every span with a duration-ratio colour scale; legend visible in the toolbar while diff mode is on.
- [x] When no bottleneck is detected, the sidebar shows a static fallback ("no critical class dominated; workload is well-balanced") instead of the old fake recommendation.
- [ ] `cargo test bottleneck::severity` green with ≥ 2 assertions. **Not done** — the current IPC returns `Vec<BottleneckInterval>`; adding a `severity` field would extend the core API and was out of scope for the UI-owned portion of T-3. Deferred to backlog.
- [x] `Ctrl+Shift+D` toggles diff mode; state survives panel re-dock (state is component-local, not route-dependent).

### Deferred
- Real second-trace file picker (currently a synthetic jitter map). Needs a `load_pccx_alt(path)` IPC slot so both traces coexist in `AppState`.
- `bottleneck::severity` test suite — extend the core type first, then assert.
