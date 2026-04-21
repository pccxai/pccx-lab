# Roadmap — Round 3 — 2026-04-20

## Top 3 for THIS round (must land before next judge pass)

### T-1: Fix `App.tsx:191` resource path + emit real `API_CALL` events (kill `synthetic_fallback`)

- **Why**: Judge flags two coupled integrity failures. `App.tsx:191`
  `"../../dummy_trace.pccx"` resolves three levels up from the tauri
  dev binary's CWD, so `fetch_trace_payload` returns empty and the
  Gemma literal fallback renders universally. That empty trace is
  why `list_api_calls` at `lib.rs:411-422` falls back to the 8-row
  `uca_*` literal at `api_ring.rs:117-130` — "address-line
  relocation, not behavioural change." Fixing the load path first
  exposes the real event stream for `ApiRing::record`. Closes
  judge dim-3 D+ ceiling and the Gap-5 silent-fallback in one.

- **Files**:
  - `src/ui/src/App.tsx` (line 191 path + line 233 error string)
  - `src/ui/src-tauri/tauri.conf.json` (bundle.resources array)
  - `src/ui/src-tauri/src/lib.rs` (line 410-422 rewrite of `list_api_calls`)
  - `src/core/src/trace.rs` (lines 7-14 add `API_CALL = 6` to `event_type_id`)
  - `src/core/src/api_ring.rs` (gate `synthetic_fallback` behind `#[cfg(test)]`)
  - `src/core/tests/api_ring_from_trace.rs` (new integration test)

- **Acceptance** (judge-gradable):
  1. `rg "\.\./\.\./dummy_trace\.pccx" src/ui/src/App.tsx` → 0 matches;
     replacement uses `resolveResource('dummy_trace.pccx')` from
     `@tauri-apps/api/path`.
  2. `rg "judge round-1 report" src/ui/src/App.tsx` → 0 matches
     (stale self-reference at line 233 gone).
  3. `rg "synthetic_fallback" src/core/src/api_ring.rs` returns only
     lines inside a `#[cfg(test)]` block (verified with `-B 3`).
  4. `cargo test -p pccx_core api_ring` → new
     `records_from_trace_with_api_call_events` test passes, asserting
     ≥ 1 row whose timestamp matches the source `NpuEvent.start_cycle`
     within ±1 ms at `CYCLES_PER_US = 200`.
  5. `npx vite build` exits 0; launching the binary auto-loads the
     bundled trace (no toolbar "(synthetic fallback)" badge on success).

- **Citations**: research_findings.md Gap 5 (Tauri 2.0 `resolveResource`,
  Yuan OSDI 2014 loud-fallback) and Gap 4 (CUPTI `CUpti_ActivityAPI`
  record schema, Canopy SOSP 2017 correlation-id pattern).

- **Owner**: core + ui

- **Estimated diff size**: M (~300 LoC across 6 files)

---

### T-2: ELK.js auto-layout for `HardwareVisualizer` (kill hand-placed pixel coords)

- **Why**: Judge dim-5 has been stuck at C+ for three rounds specifically
  because `HardwareVisualizer.tsx:255-267` hard-codes 13 `{x, y, w, h}`
  rectangles plus 13 `alive(cycle)` lambdas at lines 270-284. Every RTL
  hierarchy change requires manual px retuning; the judge flags this as
  the primary blocker to a B- grade on FPGA verification. ELK's `layered`
  algorithm (Schulze et al. 2014) is the canonical fix — four-pass
  layered DAG drawing with `portConstraints: FIXED_SIDE` keeps
  AXI-HP / ACP ports pinned, mirroring AMD UG904 device-view convention.

- **Files**:
  - `src/core/src/hw_layout.rs` (new; emit `{nodes, edges}` from
    `HardwareModel::pccx_reference()`)
  - `src/core/src/lib.rs` (re-export `hw_layout`)
  - `src/ui/package.json` (add `elkjs@^0.9`)
  - `src/ui/src/HardwareVisualizer.tsx` (lines 255-284 replaced with ELK
    worker call + trace-driven `alive(cycle)` keyed by `event_type`)
  - `src/ui/src-tauri/src/lib.rs` (new `fetch_hw_graph` command)

- **Acceptance**:
  1. `rg "x: \d+, y: \d+" src/ui/src/HardwareVisualizer.tsx` → 0 matches.
  2. `rg "algorithm.*layered" src/ui/src/HardwareVisualizer.tsx` ≥ 1
     match (ELK config present).
  3. `cargo test -p pccx_core hw_layout::emits_pccx_reference_graph`
     passes: asserts ≥ 13 nodes and ≥ 12 edges matching
     `HardwareModel::pccx_reference()` hierarchy.
  4. `npx vite build` exits 0; manual check: node positions differ
     between `MAC_ARRAY = 16` and `MAC_ARRAY = 32` configs without
     source edits.
  5. `alive(cycle)` now reads from `state.trace.events` filtered by
     `event_type` (grep: no hardcoded cycle thresholds remain).

- **Citations**: research_findings.md Gap 2 — Schulze/Spönemann/von
  Hanxleden ACM TOCHI 2014 (doi:10.1145/2629477) for layered port
  constraints; Gansner et al. IEEE TSE 1993 for the four-phase
  algorithm foundation.

- **Owner**: core + ui

- **Estimated diff size**: M (~350 LoC; under the 400 budget)

---

### T-3: Real `load_pccx_alt(path)` + FlameGraph Compare file picker (kill `Math.random` jitter)

- **Why**: Judge dim-7 at `FlameGraph.tsx:126`:
  `const jitter = 0.6 + Math.random() * 1.2`. Three rounds of deferral;
  the compare-run toolbar advertises a feature that is 100% synthetic.
  Gregg IEEE Software 2018 §III-D defines the canonical differential
  flame-graph contract — two folded-stack files, per-frame colour-delta.
  Duplicating the existing honest path (`fetch_trace_payload` →
  `parseFlatBuffer` → `events_to_spans`) into a `_b` variant is a
  mechanical, well-bounded change that eliminates the last `Math.random`
  in the profiling stack.

- **Files**:
  - `src/ui/src-tauri/src/lib.rs` (add `AppState::trace_b:
    Mutex<Option<NpuTrace>>`; add `load_pccx_alt` and
    `fetch_trace_payload_b` commands; register via `.invoke_handler`)
  - `src/ui/src/FlameGraph.tsx` (remove lines 119-132 synthetic
    `loadRunB`; wire Tauri 2.0 dialog plugin → `load_pccx_alt` →
    `fetch_trace_payload_b`; colour-diff per Gregg 2018)
  - `src/ui/src/App.tsx` (plumb second-trace state)

- **Acceptance**:
  1. `rg "Math.random" src/ui/src/FlameGraph.tsx` → 0 matches.
  2. `rg "load_pccx_alt|fetch_trace_payload_b"
     src/ui/src-tauri/src/lib.rs` ≥ 2 matches (both commands
     registered).
  3. `cargo test -p pccx_core` all green (no regressions).
  4. `npx vite build` exits 0; manual check: "Load Compare
     Trace" button in FlameGraph toolbar opens Tauri dialog,
     a second `.pccx` loads, diff colours are deterministic
     across refresh.
  5. Empty-state when no second trace loaded shows the
     `VerificationSuite.tsx:149-155` placeholder pattern
     (no silent synthetic fallback).

- **Citations**: research_findings.md Gap 3 — Gregg IEEE Software
  2018 (doi:10.1109/MS.2018.2141036) differential flame-graph
  contract; Perfetto `trace_compare` SQL as validating second-store
  architecture at scale.

- **Owner**: ui + core

- **Estimated diff size**: S-M (~220 LoC)

---

## Backlog (do not attempt this round)

- Monaco editor + tree-sitter-verilog (Gap 1) — ~400 LoC + WASM
  worker config; splits attention from ELK which unblocks dim-5
  faster. Defer to Round 4.
- `BottomPanel` / `PerfChart` / `Roofline` `setInterval` fakes
  (judge item 5 tail) — same `fetch_live_window` IPC pattern as
  T-1 but three files; bundle into Round 4 once T-1 proves the
  windowed-reduction Tauri command shape.
- `MemoryDump.tsx:43-53` per-region LCG — cosmetic; wait for
  the real `state.trace.memory_snapshots` generator upstream.
- `CanvasView.tsx:164` `phase += 0.018` heartbeat — blocked on
  T-2 landing `alive(cycle)` data flow first.
- ASIC signoff / licensing scope (dims 6, 10) — no Round-3
  research movement; park until pccx-FPGA ships its SDF path.
