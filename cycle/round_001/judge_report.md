# Judge Report — Round 1 — 2026-04-20

## Summary

**Overall grade: C-** (borderline D for anything claimed to be "sign-off
grade"). pccx-lab is a convincing React shell — the docking rework in
`96673d1`, the ECharts log-log roofline, and the UVM coverage heatmap
are genuinely decent screenshot material. But once you look under the
chrome, almost every panel is a hand-rolled demo array: the waveform is
a `makeDemo()` constant (`WaveformViewer.tsx:37`), the flame graph is
a hard-coded `N_LAYERS = 10` Gemma script (`FlameGraph.tsx:56`), the
"ISA validation matrix" is five literal rows (`VerificationSuite.tsx:27`),
the System Simulator is five `NODES` hard-coded at pixel coords
(`HardwareVisualizer.tsx:24-30`), the Memory Dump synthesises bytes
from an LCG seed (`MemoryDump.tsx:43-53`), and the "VCD exporter"
menu item is a `setTimeout` that prints a fake success string
(`App.tsx:224-227`). None of the eight rival tools this project positions
itself against would lose a single user to the current build, because
none of them ship without ingesting real data.

## Table

| # | Dimension | Grade | Anchor competitor | Headline gap |
|---|---|---|---|---|
| 1 | RTL / waveform UX         | D+ | Verdi / Surfer     | All signals constant, no real VCD/FST ingest, 1024-row O(n·m) linear redraw |
| 2 | ISA validation & trace    | D  | Spike / Whisper    | 5 hard-coded instructions, no cycle-accurate simulator wiring |
| 3 | API / driver integrity    | D+ | CUPTI / ROCprofiler| 8 static rows, no round-trip, no fuzz, no error injection |
| 4 | UVM coverage & regression | C- | Questa IMC / URG   | Static 13 coverpoints, no cross, no merge-across-runs, no UCIS |
| 5 | FPGA verification         | C  | Vivado ILA         | Bridge exists for xsim logs but no live ILA, no bitstream↔sim diff |
| 6 | ASIC signoff readiness    | F  | PrimeTime          | Literally none — no SDF, no LEC, no power, repo scope explicitly excludes it |
| 7 | GPU / accelerator profile | C+ | Nsight Systems     | Roofline renders; no per-layer diff, no NVTX-equivalent range annotation |
| 8 | UI / UX / docking         | B- | VS Code            | Dock works (`App.tsx:333-462`) but resize handles `6px`, no accessibility, no palette action coverage |
| 9 | Documentation & onboarding| B  | Nsight Guide       | EN↔KO symmetric; zero screenshots of the v0.4 UI; no tutorial |
|10 | Openness / licensing      | B- | GTKWave / Surfer   | Apache-2.0 declared but `core/` marked "will go private" per todolist:19 — credibility risk |

## Detailed findings

### 1. RTL simulation & waveform UX — D+

**Current state.** `WaveformViewer.tsx:37-161` generates the entire
signal set synchronously from a `makeDemo()` function — there is no
code path that reads a `.vcd`, `.fst`, or even the project's own
`.pccx` trace into signals. `totalTicks` (line 271) is recomputed
from the in-memory `groups` array, not from the loaded trace header.
Rendering is an O(signals × events) linear scan per frame
(`WaveformViewer.tsx:337-388`); a real 100k-signal Verdi dump will
stall the UI.

**Gap vs SOTA.** Verdi has transaction-aware debug, expression
signals (`sig_a && sig_b[3]`), bookmarks per cursor, and virtual
signals. Surfer (EUPL, open) already beats this panel feature-for-
feature on ingestion alone. GTKWave supports FST which pccx-lab
cannot read. There is no radix inheritance per group, no waveform
search for value transitions, no compare-traces view.

**Impact.** The headline panel of an "enterprise NPU profiler" cannot
open an actual simulation output. This is the single biggest
credibility gap.

**Concrete suggestion (`src/ui/src/WaveformViewer.tsx`).** Wire the
panel to `fetch_trace_payload` (the existing Tauri IPC, see
`Timeline.tsx:66-77`) and emit signals out of `pccx_format.rs`.
Adopt a VCD parser crate in `src/core/` (`vcd` crate, MIT). Add
bookmark list (max 16), store in `localStorage`. Replace the full
linear scan with a per-signal binary-search-on-`events[]` plus
canvas viewport culling.

### 2. ISA validation & trace — D

**Current state.** `VerificationSuite.tsx:27-33` has exactly five
hard-coded rows; the "Run Regression Suite" button walks a 4-step
`setInterval` that prints canned strings. No ISS, no DUT wiring,
no cycle counter comparison. `src/core/src/cycle_estimator.rs` has
only 189 lines — too small to be a real cycle model.

**Gap vs SOTA.** Spike / Whisper execute every instruction and log
retire order; the pccx "ISA matrix" doesn't execute anything.
Confirma/Palladium produce per-instruction commit logs; pccx-lab
produces a string list.

**Impact.** "Cycle-accurate ISA validation" as a sales claim is
indefensible.

**Suggestion (`src/core/src/cycle_estimator.rs`).** Expand to a
minimal in-order ISS that replays `OP_GEMV / OP_GEMM / OP_MEMCPY /
OP_CVO / OP_MEMSET` with the `isa_pkg` 32-bit encoding, emit a
`(expected_cycles, actual_cycles)` pair per instr, and drive the
table from IPC.

### 3. API / driver-surface integrity — D+

**Current state.** `VerificationSuite.tsx:323-331` — eight rows
literal. No counter, no drop detection, no fuzz, no round-trip
capture. `src/ai_copilot/src/lib.rs:119` declares a "vcd-exporter"
plugin whose implementation nowhere exists.

**Gap vs SOTA.** CUPTI auto-logs every CUDA API entry/exit with
correlation IDs; ROCprofiler supports per-thread ring buffers;
Intel VTune ITT API has range instrumentation. pccx-lab has 0 of
these.

**Suggestion (`src/uvm_bridge/`).** Add a DPI-C shim that wraps
every `uca_*` entry point, writes `{api_id, ts_ns, ret_code}`
into a ring, and flushes via the existing `.pccx` event stream.

### 4. UVM coverage & regression — C-

**Current state.** `VerificationSuite.tsx:200-214` — 13 hand-picked
coverpoints, no cross products, no goal tracking, no FSM coverage,
no merge across runs. The regression-history panel
(`VerificationSuite.tsx:216-225`) is an 8-day literal. `REG_HISTORY`
is in the source.

**Gap vs SOTA.** Questa IMC / URG / Xcelium IMC read UCIS `.ucdb`
and produce merged reports across N runs with drill-down. pccx-lab
has no UCIS, no cross, no trend extraction.

**Suggestion (`src/core/src/`).** Add a `coverage.rs` with a
`MergedCoverage` type consuming either UCIS or a simple JSONL
emitted from each run, then expose `merge_coverage` IPC. Render
cross-coverage (e.g. `gemm_k_stride × mem_hp_backpressure` at
8×4 bins) as a second heatmap tab.

### 5. FPGA verification (bitstream ↔ sim) — C

**Current state.** Better here: `run_verification.sh` glob runner,
`from_xsim_log.rs`, and `VerificationRunner.tsx` all exist and wire
the `trace-loaded` event through the 4-card dashboard. This is real
work (see commit `4307706`). But the System Simulator
(`HardwareVisualizer.tsx:24-30`) is pixel-coordinate nodes — a
cartoon, not a floorplan.

**Gap vs SOTA.** Vivado ILA captures live trigger states post-
bitstream with SignalTap-style rings; pccx-lab cannot.

**Suggestion (`src/ui/src/HardwareVisualizer.tsx`).** Rip the five
static rectangles; drive the floorplan from the real `pccx_format`
header (systolic 32×32, 4-lane GEMV, SFU, URAM 64). Or replace with
a live Vivado `hw_ila.tcl` bridge through `src/uvm_bridge/`.

### 6. ASIC signoff readiness — F

**Current state.** Nothing. No SDF parser, no LEC hook, no
PrimeTime/Tempus output ingest, no power view, no SAIF. Repo scope
per `AGENTS.md:16-25` excludes it, but the marketing header on
`todolist.md:1` says "궁극의 NPU 아키텍처 프로파일러" and the
"Verification" tab uses the word "signoff" implicitly via "synth
status". Mismatch.

**Suggestion.** Either drop the claim from the top-matter, or add a
trivial SDF path-delay parser + power-estimate column to
`SynthStatusCard.tsx`.

### 7. GPU / accelerator profiling — C+

**Current state.** `Roofline.tsx` is the best panel in the repo: real
ECharts log-log axes, ridge lines, filter-by-kind, per-kernel util
colouring. Flame graph is well-coloured and supports click-isolate
(`FlameGraph.tsx:438-440`) but has no differential mode (no "run A
vs run B" overlay), no per-layer aggregation toggle, and the
`aiAnalysis` string recommendation (line 332-335) is a hardcoded
literal — the span `"Wait"` it searches for does not exist in the
`demo` data set (scan line 55-165).

**Impact.** The "Find Bottleneck Spot" button will never fire a
meaningful analysis because the demo spans never contain "Wait".

**Suggestion.** Wire `spans` from `detect_bottlenecks` IPC (exists,
see commit `640fb0e`). Add flame-graph diff mode (two `Span[]`
arrays, colour by duration ratio).

### 8. General UI / UX / docking — B-

**Current state.** `App.tsx:333-462` is a clean three-way dock that
does work; commit `96673d1` fixed the previous left/bottom bug.
Resize handles are real (`App.tsx:62-80`). Command palette exists
(`CommandPalette.tsx`). But: zero `role=` / `aria-` attributes
across 28 tsx files (Grep count: 7 total across the repo), no
keyboard shortcut registry beyond Ctrl+K, and the "X" close button
at `App.tsx:122` uses a literal "X" glyph instead of a Lucide icon
(inconsistency with neighbours on line 35).

**Suggestion.** Add a2y pass — every icon-only button needs
`aria-label`. Register a shortcut map in a new
`src/ui/src/useShortcuts.ts` and wire the palette off it.

### 9. Documentation & onboarding — B

**Current state.** `docs/` and `docs/ko/` mirror each other
(`conf.py`, `design`, `index.rst`, `modules`, `pccx-format.md`,
`verification-workflow.md` — both sides). KO-first policy is
enforced in AGENTS.md. But only a few `docs/_static/screenshots/`
exist; no per-feature tutorial; no "getting started in 5 min"
page.

**Suggestion.** Capture three full-UI screenshots (Waveform,
Roofline, Verification) and add a `docs/getting-started.md` with
one `run_verification.sh` walkthrough.

### 10. Openness / licensing — B-

**Current state.** `todolist.md:9-24` explicitly says "Open Core
Strategy", i.e. the fast simulator engine and cycle predictor will
live in a private repo. This is a legitimate business model, but
the Apache-2.0 label on the public repo plus a private `core/` is
easy to misread as bait-and-switch. Surfer's EUPL and GTKWave's
GPL do not have this credibility overhang.

**Suggestion.** Publish a `LICENSE_SCOPE.md` that names exactly
which crates/files are Apache-2.0 forever and which may go closed.

## Top-5 must-fix for next round

1. **Wire `WaveformViewer` to real data.** Replace `makeDemo()`
   with a VCD / `.pccx` ingest path. Add per-signal binary search
   and canvas viewport culling. Add bookmark + expression signal
   support. Target: 100k signals × 1M transitions at 60 fps on
   the KV260 host.
   *(files: `src/ui/src/WaveformViewer.tsx`, new
   `src/core/src/vcd.rs`)*

2. **Kill all hard-coded demo arrays in Verification.** Drive the
   ISA matrix (`VerificationSuite.tsx:27`), API integrity
   (`VerificationSuite.tsx:323`), and coverage
   (`VerificationSuite.tsx:200`) from the actual IPC. Add UCIS or
   JSONL-based **merge-across-runs** for coverage. Add a
   cross-coverage tab (`gemm_k_stride × mem_hp_backpressure`,
   `sfu_op_kind × mem_uram_bank_hit`).
   *(files: `src/core/src/coverage.rs` (new),
   `src/ui/src/VerificationSuite.tsx`)*

3. **Make the System Simulator a real floorplan.** Delete the 5
   hand-placed NODES in `HardwareVisualizer.tsx:24-30`. Generate
   the diagram from the v002 spec (MAT_CORE 32×32, GEMV 4-lane,
   SFU single, URAM 64 / L2 1.75 MB). Animate bus transactions
   from `fetch_trace_payload` rather than `Math.random()` (line
   39-46).

4. **Replace the SV editor with Monaco + Tree-sitter-verilog.**
   The current regex tokenizer (`CodeEditor.tsx:196-228`) is a toy;
   add virtual scroll, fold regions, minimap, and hover-for-
   definition. A VS Code level editor is the only credible
   comparator at this point.

5. **Flame graph diff + real bottleneck wiring.** The
   `handleAIHotspot` function (`FlameGraph.tsx:308-337`) greps
   for span names containing `"Wait"` that do not exist in the
   demo data — the button is broken on arrival. Hook it to the
   already-shipped `detect_bottlenecks` IPC (see commit
   `640fb0e`), add a second-run overlay with per-span duration
   delta colouring, and add a "collapse layer_N" aggregation
   toggle.

(Word count: ~1770.)
