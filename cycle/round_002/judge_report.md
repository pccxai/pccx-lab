# Judge Report — Round 2 — 2026-04-20

## Summary

**Overall grade: C** (up from C-). Round 1 cashed the three cheques it wrote —
`src/core/src/vcd.rs` is a real VCD parser (285 LoC, 2 tests) wired through
`parse_vcd_file` (`src/ui/src-tauri/src/lib.rs:357-363`); `src/core/src/coverage.rs`
exists (236 LoC, 6 tests) and `COVER_GROUPS` / `REG_HISTORY` are gone
from `VerificationSuite.tsx` (grep 0); `WaveformViewer.tsx:269-301` is a
genuine binary-search pair feeding viewport-culled draw helpers at lines 1044
and 1088-1089; bookmarks persist in `localStorage["pccx-waveform-bookmarks"]`
(line 305, 325-329). `cargo test --lib` runs 19 tests clean (2 new vcd, 6
new coverage); `npx vite build` completes in 11.3 s with no errors. Ingest is
real for waveforms and coverage. **But** two Round-1 critiques were silently
left alive: the ISA matrix (`VerificationSuite.tsx:42-48` `DUMMY_ISA_RESULTS`)
and the API-integrity 8-row table (`VerificationSuite.tsx:383-392` `API_ROWS`)
remain literal arrays — the T-2 implementer's claim that `COVER_GROUPS` and
`REG_HISTORY` were the only literal arrays to kill cherry-picks two of three
Round-1 call-outs. Worse, T-3's "removed fake setTimeout" commit (`0012b09`)
replaced the fakes with `invoke("export_vcd")` / `invoke("export_chrome_trace")`
(`App.tsx:228,237`) that target commands **not registered** in the
`invoke_handler!` block (`src-tauri/src/lib.rs:522-541`) — so the menu entries
now throw deterministically and print "may not be wired yet" to the log. This
is a stealth regression disguised as a fix. Beyond the three Round-1 tickets,
the entire back half of the UI (CodeEditor, HardwareVisualizer placement,
MemoryDump bytes, executeRegression log) is still literal / setInterval /
LCG — Round 2 must stop relitigating Round 1 and open new fronts.

## Table

| # | Dimension | R-2 Grade | R-1 | Progress | Anchor | Headline gap |
|---|---|---|---|---|---|---|
| 1 | RTL / waveform UX         | C+ | D+ | **+2**      | Verdi / Surfer     | Real VCD in; still no FST/virtual/expression/transaction view |
| 2 | ISA validation & trace    | D  | D  | —           | Spike / Whisper    | `DUMMY_ISA_RESULTS` still literal; `executeRegression` still `setInterval` (`VerificationSuite.tsx:61-72`) |
| 3 | API / driver integrity    | D+ | D+ | —           | CUPTI              | `API_ROWS` still 8 literal rows (line 383); `export_vcd` IPC registered nowhere |
| 4 | UVM coverage & regression | B- | C- | **+2**      | Questa IMC / URG   | Merge + cross heatmap genuinely work; still JSONL-only, no UCIS, no trend line |
| 5 | FPGA verification         | C+ | C  | **+0.5**    | Vivado ILA         | `HardwareVisualizer` module tree is real; placement still pixel-coord (line 261-267) |
| 6 | ASIC signoff readiness    | F  | F  | —           | PrimeTime          | No work; no SDF, no LEC, no power |
| 7 | GPU / accelerator profile | B- | C+ | **+1**      | Nsight Systems     | `detect_bottlenecks` IPC wired (line 389); but span array still Gemma literal (line 85-196); "Compare run" is `Math.random` jitter (line 48) |
| 8 | UI / UX / docking         | B- | B- | —           | VS Code            | No Monaco; CodeEditor regex-tokenizer (line 213); ~0 aria-* outside assets |
| 9 | Documentation & onboarding| B  | B  | —           | Nsight Guide       | 13 screenshots present; still no getting-started.md, no tutorial walkthrough |
|10 | Openness / licensing      | B- | B- | —           | GTKWave / Surfer   | Still no `LICENSE_SCOPE.md`; todolist flag persists |

## Detailed findings — what actually changed

**T-1 verified.** `src/core/src/vcd.rs:91-171` implements a real end-to-end
parse via the `vcd` crate; `parse_header_var_and_one_value_change`
(vcd.rs:249-277) has 8 assertions incl. `timescale_ps == Some(1000)`,
scope-joined names, specific clk-rise event at tick 10. The Tauri command
at `src-tauri/src/lib.rs:357-363` forwards unchanged. `WaveformViewer.tsx`
has `eventIdxAtTick` (line 269) and `firstIdxAtOrAfter` (line 291) used in
both `drawWire` (line 1044) and `drawBus` (lines 1088-1089) — this is a
real O(log n + visible) renderer, not a cosmetic comment. Bookmarks
persist at line 325-329 and Ctrl+B is a real `window.keydown` at 815-829.
**Honest caveats:** the 60-fps perf trace was deferred (implemented_T1.md
§Deferred bullet 2); the `.pccx` alt-ingest was deferred (bullet 3);
expression / virtual signals were deferred (bullets 4-5). None of these
are regressions, but a Round-2 ticket should pick up the perf artifact
since "100k × 1M transitions" is a specific, load-bearing Round-1 claim.

**T-2 verified — with scope shrinkage.** `src/core/src/coverage.rs` merge
semantics are correct (hits-sum, goal-max); 6 unit tests green. The UI
heatmap at `VerificationSuite.tsx:219-267` actually calls
`invoke("merge_coverage", { runs })` with three JSONL fixtures under
`hw/sim/coverage/fixtures/`. The **sibling hardcoded arrays the Round-1
judge named in the same breath** — `DUMMY_ISA_RESULTS` (line 42-48) and
`API_ROWS` (line 383-392) — are **untouched**. Round-1 must-fix item 2
explicitly said "Kill **all** hard-coded demo arrays in Verification …
the ISA matrix (`VerificationSuite.tsx:27`), API integrity
(`VerificationSuite.tsx:323`), and coverage" — T-2 shipped ⅓. The
regression-history panel disappeared entirely (not rewired), which is
neutral-to-positive (no regressed fake), but the ticket's acceptance
bullet "`COVER_GROUPS` and `REG_HISTORY` literal arrays grep-return 0"
is a ⅓-coverage claim dressed as a checkmark.

**T-3 verified — with a fake-fix regression.** `FlameGraph.tsx:389-407`
does invoke `detect_bottlenecks` with real window/threshold params and
classifies the result into one of four recommendation strings
(SystolicStall / DmaRead / DmaWrite / BarrierSync) — this is the
headline Round-1 fix and it lands. Ctrl+Shift+D diff mode at line 31-38
is real. **But**: (a) the `spans` array that feeds the flame graph is
still the 196-line Gemma literal at lines 85-196, with the same
`N_LAYERS = 10` constant the Round-1 report flagged — so
`detect_bottlenecks` runs against an IPC-provided trace while the
visualization renders from a memory constant, i.e. they are showing
different data; (b) "Compare run…" at line 41-54 is explicitly a
`Math.random() * 1.2` jitter map — `implemented_T3.md:24` admits this
under Deferred but the button still appears in the toolbar with no
"synthetic" disclaimer; (c) **the worst regression this round**: commit
`0012b09` claims to remove fake `setTimeout` exports; look at
`App.tsx:225-242` — the handlers now call `invoke("export_vcd", {outputPath})`
and `invoke("export_chrome_trace", {outputPath})`; neither command is
registered in `src-tauri/src/lib.rs:522-541`. Production runs will hit
the catch branch every time and print "vcd_writer may not be wired yet —
see judge round-1 report" — a circular reference to this document. This
is a fake-fix and arguably worse than the original setTimeout because
it now blames the judge report for its own brokenness.

**Dimensions untouched since Round 1.** CodeEditor is still a split-on-
regex tokenizer (`CodeEditor.tsx:213`) with no Monaco / tree-sitter;
MemoryDump still synthesises bytes from a per-region LCG seed
(`MemoryDump.tsx:43-53`); HardwareVisualizer has real RTL content
(commit `72082d9`) but the placement is still hand-placed pixel
coordinates (line 261-267) with hand-tuned edge `alive(cycle)` cycle
ranges (line 271-284), not trace-driven; `aria-*` count across
`src/ui/src/**` is 0 (the 1 `grep` hit is `src/ui/src/assets/react.svg`);
accessibility has not moved. `docs/` still has no
`getting-started.md` or tutorial walkthrough, though 13 screenshots
under `docs/_static/screenshots/` meet the Round-1 suggestion
halfway.

## Regressions / silent scope drops

1. **Fake-fix in `App.tsx:225-242`** — `invoke("export_vcd")` /
   `invoke("export_chrome_trace")` target unregistered commands
   (`src-tauri/src/lib.rs:522-541`); guaranteed catch-branch every
   run. This is a *new* kind of fake: fake implementation behind a
   real-looking try/catch. Fix: register both commands or delete the
   menu items.
2. **T-2 acceptance was partial.** ISA + API literal arrays survive.
3. **Performance artifact deferred** (`implemented_T1.md:69-78`)
   without a follow-up ticket entry — the 60 fps × 50k-event
   claim is presently unverified.
4. **FlameGraph data-layer schizophrenia** — Gemma literal renders,
   IPC drives advice → shows correct advice about a chart the user
   is not looking at.

## Top-5 must-fix for Round 3 — NEW fronts

1. **Replace `CodeEditor` regex tokenizer with Monaco editor + SV
   syntax.** Current state: 409 LoC of hand-rolled highlighting
   (`CodeEditor.tsx:195-228`) with 28 hardcoded keywords. Target: swap
   to `@monaco-editor/react` + the open-source `monaco-languages`
   SystemVerilog grammar, add fold regions, minimap, hover-for-
   definition stubs, Ctrl+F find. No editor can compete with VS Code
   / Verdi at textbox-with-colours fidelity. **(L, ~400 LoC net;
   new dep: `@monaco-editor/react@^4`)**

2. **Kill the two remaining Verification literal arrays.**
   `DUMMY_ISA_RESULTS` (`VerificationSuite.tsx:42-48`, 5 rows) →
   drive from a new `CycleEstimator::replay(pccx_trace)` that
   decodes the 32-bit `isa_pkg` opcode stream from the loaded
   `.pccx` and emits `(expected, actual)` pairs. `API_ROWS`
   (line 383-392, 8 rows) → add `uvm_bridge/src/api_ring.rs` that
   records every `uca_*` call, flush to the `.pccx` event stream,
   expose via `list_api_calls` IPC. Also rip the `executeRegression`
   `setInterval` (line 57-72) — it has no backing IPC.
   **(XL, ~600 LoC + ISA replay core)**

3. **Re-derive `HardwareVisualizer` floorplan from
   `HardwareModel::pccx_reference()`.** Current state: hand-placed
   pixel rects at `HardwareVisualizer.tsx:261-267` and hand-tuned
   `alive(cycle)` cycle ranges (line 271-284). Target: generate
   `{x,y,w,h}` from an auto-layout over the RTL `HIERARCHY`
   (depth-based tree layout, ≥ 60 nodes), drive `alive` from
   `state.trace` event kinds, animate packets from real
   timestamps. Also register this panel's "Show in floorplan"
   hover on FlameGraph spans. **(L, ~350 LoC)**

4. **Ship `docs/getting-started.md` + accessibility pass.**
   (a) Write a 5-minute tutorial that runs
   `run_verification.sh` on the sibling pccx-FPGA checkout, opens
   the resulting `.pccx` + `.vcd` in the UI, walks through one
   bookmark + one cross-coverage cell + one bottleneck
   recommendation. Include four screenshots from the existing
   13-file set. (b) Add `aria-label` to every icon-only button
   (grep currently hits 0 outside `assets/`) and register a
   shortcut map in `src/ui/src/useShortcuts.ts`. **(M, ~250 LoC +
   docs)**

5. **Fix the FlameGraph data-layer schizophrenia and delete the fake
   exports.** (a) Drive `spans` from `fetch_trace_payload` +
   `detect_bottlenecks` — no more `N_LAYERS = 10` literal
   (`FlameGraph.tsx:86`). (b) Replace the `loadRunB` `Math.random`
   jitter (line 45-49) with a real `load_pccx_alt(path)` IPC so a
   second `.pccx` can be compared. (c) In `App.tsx:225-242`, either
   implement `export_vcd` / `export_chrome_trace` as real core
   commands (write `pccx_core::vcd_writer` + `pccx_core::chrome_trace`)
   or delete both menu entries. Today's state is a stealth fake.
   **(L, ~400 LoC)**

(Word count: ~1720.)
