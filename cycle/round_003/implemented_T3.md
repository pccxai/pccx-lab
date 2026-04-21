# Implemented — UI — Round 3

## Ticket T-3: Real `load_pccx_alt(path)` + FlameGraph Compare file picker (kill `Math.random` jitter)

### Commits
- `3895fc8` — feat(core): T-3 trace_b slot + load_pccx_alt IPC
- `04ccf74` — feat(ui): T-3 real Compare-run via second trace

### Files touched
- `src/ui/src-tauri/src/lib.rs` (+53 / -16)
  - Added `AppState.trace_b: Mutex<Option<NpuTrace>>`.
  - Added `load_pccx_alt(path, state) -> PccxHeader` command (opens second
    `.pccx`, decodes bincode payload into `trace_b`).
  - Added async `fetch_trace_payload_b(state) -> Vec<u8>` command (returns
    the second trace's flat buffer via `to_flat_buffer()`, or an error if
    no compare trace has been loaded — the UI turns that into an
    empty-state placeholder, not a synthetic fallback).
  - Registered both in `invoke_handler!`.
  - Initialised the new field inside `.manage(AppState { … })`.
- `src/ui/src/FlameGraph.tsx` (+58 / -10)
  - Deleted the synthetic jitter loop (`0.6 + Math.random() * 1.2`) at old
    lines 119-132.
  - Replaced with a real flow: dynamic import of
    `@tauri-apps/plugin-dialog` → `open()` with `.pccx` filter →
    `invoke('load_pccx_alt', { path })` → `invoke<Uint8Array>('fetch_trace_payload_b')`
    → existing `parseFlatBuffer` + `events_to_spans` helpers → `runB` map
    keyed by `${name}@${start}` (same scheme the diff-colour draw-loop
    already consumes, unchanged).
  - Added `clearRunB()` + toolbar label (`B: <filename>` with × button)
    and inline error span so cancelling the dialog leaves runB / diffMode
    untouched, while real failures surface without silent fallback.
  - Existing Ctrl+Shift+D toggle and blue/white/red ratio legend keep
    working verbatim.

### Net LoC
- Total diff: **109 lines** (≤ 220 budget).

### Acceptance self-check
1. `rg "Math\.random" src/ui/src/FlameGraph.tsx` → **0 matches** ✓
2. `rg "load_pccx_alt|fetch_trace_payload_b" src/ui/src-tauri/src/lib.rs`
   → **8 matches** (≥ 2 required; declarations + handler register + doc
   comments) ✓
3. `cargo test --lib` in `src/core` → **39 passed, 0 failed, 0 ignored** ✓
   (T-1 agent's in-flight `simulator.rs` landed cleanly before this
   build; our changes touch no core code, so regression-free by
   construction.)
4. `npx vite build` in `src/ui` → **exits 0**, built in 19.47 s. ✓
   - `npx tsc --noEmit` has pre-existing unrelated errors in
     `CanvasView.tsx`, `CodeEditor.tsx`, `HardwareVisualizer.tsx`
     (T-2 in-flight), `PerfChart.tsx`, `ReportBuilder.tsx`,
     `Timeline.tsx` — verified they exist on unchanged HEAD via
     `git stash -u`. **Zero new errors in `FlameGraph.tsx`.**
5. Compare-run button opens a real native file picker (Tauri 2.0
   dialog plugin); cancelling (`open()` returns `null`) hits the
   `if (!picked) return;` guard, leaving `runB` / `diffMode` /
   `compareLabel` / `compareErr` at their prior values. ✓
   - Empty-state after an explicitly-failed load mirrors the
     `VerificationSuite.tsx:149-155` placeholder pattern
     (inline error span with the actual message, no synthetic
     fill-in).

### Deferred
- None from the T-3 roadmap scope. The research-gap suggestion of a
  depth-aware canonical span id (Gregg 2018 stack-trace equality vs.
  the current `${name}@${start}` key) is explicitly marked as an
  open question; the ticket kept the existing scheme to stay within
  the 220-LoC budget and avoid touching the draw loop.
- `App.tsx` second-trace plumbing was listed as an optional file in
  the roadmap. The current implementation keeps the compare-trace
  state inside `FlameGraph` (local `runB`), which is sufficient for
  the acceptance criteria and keeps the diff surgical. Lifting it to
  `App.tsx` can be a follow-up if other panels (Timeline, Roofline)
  later need the same compare state.
