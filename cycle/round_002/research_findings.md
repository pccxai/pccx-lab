# Research Findings — Round 2 — 2026-04-20

Scope note: Topics 1 and 4 have thin peer-reviewed coverage (developer-tool
UI is largely industry-documented, not academic). For those we cite
primary W3C and Microsoft specs and say so honestly. Topics 2, 3, 5 have
stronger academic / standards backing.

---

## Gap 1: Replace `CodeEditor` regex tokenizer with Monaco + SystemVerilog grammar

### Canonical sources
- https://microsoft.github.io/monaco-editor/ — official Monaco Editor API
  reference (Microsoft, MIT-licensed; VS Code's browser editor core).
- https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
  — LSP 3.17 specification (`textDocument/semanticTokens`, `hover`,
  `definition`, `foldingRange`). Canonical contract for external
  language intelligence.
- https://tree-sitter.github.io/tree-sitter/ — official tree-sitter
  parser docs; grammar definition for incremental parsing
  (Brunsfeld, CMU/GitHub).
- https://github.com/tree-sitter/tree-sitter-verilog — tree-sitter-verilog
  grammar (IEEE 1364-2005 + 1800-2017 subset).
- https://github.com/imc-trading/svlangserver — svlangserver (open-source
  SV LSP; ctags symbol index, Verilator linter).
- https://github.com/vivekmalneedi/veridian — Veridian LSP (Rust,
  `sv-parser` crate, full IEEE 1800-2017 parse).
- https://doi.org/10.1109/DAC18072.2020.9218740 — Snyder, "Verilator
  and SystemVerilog parsing," DAC 2020.

### Key idea applicable to pccx-lab
Monaco drops in via `@monaco-editor/react` and provides tokenizer,
folding, find-in-file, minimap, and a semantic-tokens client for free;
`onMount(editor)` lets the existing CodeEditor file-tree wire in. For
SV-aware highlighting beyond TextMate, a tree-sitter-verilog WASM
build drives Monaco's `SemanticTokensProvider`; for hover/definition,
wire Veridian over LSP through Tauri stdio. This matches pccx-lab v002
because svlangserver and Veridian both parse the same `hw/rtl/**/*.sv`
files the FPGA team already simulates.

### Open questions
- Does Veridian handle the `npu_interfaces.svh` include-path
  conventions (LSP leaves resolution implementation-defined)?
- WASM startup cost for tree-sitter-verilog on a 20k-line corpus
  inside Tauri's WebView.

### Recommendation (concrete)
Replace `src/ui/src/CodeEditor.tsx:195-228` with
`@monaco-editor/react` configured for `language: 'systemverilog'` and
register a `SemanticTokensProvider` that shells out via Tauri to a
Veridian child process over LSP 3.17 `textDocument/semanticTokens`
(Microsoft LSP spec §3.17).

---

## Gap 2: Real ISA cycle-accuracy validation + API-integrity pipeline

### Canonical sources
- https://github.com/riscv-software-src/riscv-isa-sim — Spike reference
  RISC-V ISS (golden commit-log model; RISC-V International).
- https://github.com/chipsalliance/riscv-dv — ETH / Google
  constrained-random generator; diffs Spike vs. RTL per-cycle via
  `iss_sim_compare.py`.
- https://github.com/riscv/sail-riscv — SAIL formal golden model
  (Cambridge / Sail).
- https://github.com/chipsalliance/SweRV-ISS — Whisper ISS (Western
  Digital / CHIPS Alliance) with per-instruction commit-log format.
- https://doi.org/10.1145/3317550.3321424 — Armstrong et al., "ISA
  semantics for ARMv8-A, RISC-V, and CHERI-MIPS," HotOS 2019 (SAIL
  diff methodology).
- https://riscv.org/wp-content/uploads/2019/12/riscv-privileged-20190608-1.pdf
  — Privileged ISA v1.12 (§3.1.14–15: `mcycle` / `minstret` commit-
  trace semantics).
- IEEE 1800-2017 §20.14 — SystemVerilog coverage / `$assertoff` API
  (contract side for UVM `uvm_analysis_port` taps `uca_*` mirrors).

### Key idea applicable to pccx-lab
The standard ISS diff contract: ISS emits a commit log
`<pc, opcode, dest reg, value, mcycle>` per retired instruction, and a
diff tool lines it up against the DUT's self-reported commit
(`riscv-dv`'s `iss_sim_compare.py` or Spike `--log-commits`). For
pccx, the 32-bit `isa_pkg` opcode stream in a `.pccx` trace *is* the
DUT log; a `CycleEstimator::replay` in `src/core/src/isa_replay.rs`
can walk opcodes in issue order and emit `(expected, actual)` pairs
by applying the pipeline latency table from `hw/rtl/pipeline_pkg` —
exactly the Spike pattern parameterized by NPU latencies. The API
ring is the same pattern at driver boundary: record every `uca_*`
entry/exit, flush to `.pccx`, diff against a golden run.

### Open questions
- pccx has no privileged-ISA `mcycle` — does v002's `event_stream`
  carry enough timestamp resolution for cycle-gap reconstruction?
- SAIL's formal semantics assume deterministic architectural state;
  NPU async DMA breaks that assumption.

### Recommendation (concrete)
Build `src/core/src/isa_replay.rs` implementing Spike-style commit-
log diff (Spike `--log-commits` format) to drive `DUMMY_ISA_RESULTS`
in `VerificationSuite.tsx:42-48`, and add `src/uvm_bridge/src/api_ring.rs`
to record `uca_*` boundary crossings into the `.pccx` event stream
for `API_ROWS` (line 383-392).

---

## Gap 3: Auto-layout floorplan for HardwareVisualizer block diagram

### Canonical sources
- https://graphviz.org/Documentation/TSE93.pdf — Gansner, Koutsofios,
  North, Vo, "A technique for drawing directed graphs," IEEE TSE 1993
  (AT&T; the `dot` ranking algorithm paper).
- https://doi.org/10.1145/1055626.1055628 — Sander, "Graph layout
  through the VCG tool," Graph Drawing (hierarchical-layout
  foundation).
- https://www.eclipse.org/elk/documentation.html — Eclipse ELK (ELK.js)
  layered layout; port constraints critical for RTL block I/O
  alignment.
- https://doi.org/10.1145/2629477 — Schulze et al., "Drawing layered
  graphs with port constraints," ACM TOCHI 2014.
- https://docs.amd.com/r/en-US/ug904-vivado-implementation — AMD/Xilinx
  UG904 §"Device view" (fabric-aware placement; DSP48E2 / BRAM / URAM
  site coordinates).
- https://github.com/dagrejs/dagre — Dagre (MIT), JS port of dot-style
  layered layout used in reactflow.

### Key idea applicable to pccx-lab
For a module-level floorplan (`HardwareVisualizer.tsx:261-267`),
hierarchical-layered layout from Gansner et al. 1993 solves rank
assignment, crossing reduction, and x-coordinate assignment in three
linear passes; ELK.js exposes `layered` as a preset. Port-constrained
layering (Schulze et al. 2014) keeps `AXI-HP` / `ACP` interface ports
aligned along consistent edges, matching UG904's device-view
convention. For a fabric-aware secondary mode, snap nodes to Vivado-
reported tile coordinates (UG904 `report_utilization` XML).

### Open questions
- ELK.js at 60+ nodes / 60 fps inside Tauri's WebView2 (Java ELK
  benchmarks are JVM).
- Merging two coordinate systems (logical dagre vs. physical UG904
  tile grid) in one panel.

### Recommendation (concrete)
In `src/ui/src/HardwareVisualizer.tsx`, replace hand-placed rects with
ELK.js `layered` layout (`algorithm=layered`,
`portConstraints=FIXED_SIDE`) fed from `HardwareModel::pccx_reference()`,
per Gansner et al. 1993 (IEEE TSE).

---

## Gap 4: Developer-tool accessibility (WCAG / ARIA) + getting-started UX

### Canonical sources
- https://www.w3.org/TR/WCAG22/ — WCAG 2.2 (W3C Recommendation
  2023-10-05); SC 2.1.1 Keyboard, 2.4.3 Focus Order, 2.4.11 Focus Not
  Obscured, 2.5.8 Target Size Minimum.
- https://www.w3.org/TR/wai-aria-1.2/ — WAI-ARIA 1.2 role / state /
  property reference (`role="tree"`, `aria-expanded`, `aria-label`,
  `aria-live`).
- https://www.w3.org/WAI/ARIA/apg/patterns/ — ARIA Authoring Practices
  Guide; canonical `treegrid`, `tabs`, `menubar` patterns — all
  directly applicable to a VS Code-style IDE shell.
- https://code.visualstudio.com/docs/configure/accessibility/accessibility
  — VS Code Accessibility docs (Microsoft); screen-reader mode, high-
  contrast, keyboard-nav contract. pccx-lab mirrors VS Code's shell,
  so this is the baseline.
- https://doi.org/10.1145/3411764.3445670 — Mack et al., "What do we
  mean by 'accessibility research'?" CHI 2021 (methodological survey).

### Key idea applicable to pccx-lab
WCAG 2.2 SC 2.1.1 and 2.4.3 give a concrete checklist: every icon-
only button needs `aria-label`, every tree view `role="tree"` +
`aria-expanded`, every modal focus trap + `aria-modal="true"`. The
ARIA APG `treegrid` pattern matches pccx-lab's module hierarchy
verbatim. No peer-reviewed paper dominates IDE onboarding; the
pragmatic reference is VS Code's Getting Started walkthrough contract
(Microsoft docs, `vscode.walkthroughs` API) — reusing its three-step
structure (intro → tour → first task) keeps expectations aligned with
the tool pccx-lab most resembles.

### Open questions
- WCAG 2.2 doesn't define webview-specific rules; does Tauri's
  WebView2 / WebKitGTK expose ARIA to AT-SPI / UIAutomation
  consistently cross-platform?
- No peer-reviewed onboarding paper targets RTL / hardware IDEs —
  this is a genuine literature gap.

### Recommendation (concrete)
Add `aria-label` to every icon-only button in `src/ui/src/**`
(WAI-ARIA 1.2 §5.2.8.4), register a WCAG 2.2 SC 2.1.1 keyboard
shortcut map in `src/ui/src/useShortcuts.ts`, and write
`docs/getting-started.md` modelled on VS Code's walkthrough three-
step contract.

---

## Gap 5: FlameGraph data consistency + export formats

### Canonical sources
- IEEE Std 1364-2005 §18 — VCD (Value Change Dump) file format
  (canonical grammar; `$timescale`, `$scope`, `$var`, time-prefixed
  value changes). DOI https://doi.org/10.1109/IEEESTD.2006.99495.
- https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview
  — "Trace Event Format," official Google/Chromium spec (linked from
  https://www.chromium.org/developers/how-tos/trace-event-profiling-tool/).
- https://perfetto.dev/docs/reference/trace-packet-proto — Perfetto
  `TracePacket` proto (Google; superset of Chrome Trace).
- https://opentelemetry.io/docs/specs/otel/trace/api/ — OpenTelemetry
  Trace API spec (CNCF; Microsoft / Google / AWS).
- https://doi.org/10.1109/MS.2018.2141036 — Gregg, "The Flame Graph,"
  ACM Queue / IEEE Software 2018 (canonical paper).
- https://github.com/brendangregg/FlameGraph — reference
  implementation; folded-stack format in README.

### Key idea applicable to pccx-lab
The `spans` array in `FlameGraph.tsx:85-196` and the IPC-driven
`detect_bottlenecks` result must share one source of truth. Chrome
Trace Event Format (Phase B/E duration events with `ts`/`dur`,
Google spec §"Duration Events") is the industry lingua franca and
exports cleanly to Perfetto (JSON legacy path, proto native). For
VCD export, IEEE 1364-2005 §18 is the only authoritative grammar;
a `pccx_core::vcd_writer` emitting `$timescale 1 ps` + `$var wire
N net $end` + `#<t> <value><id>` is ~200 LoC with one spec
citation. For profiling, emit Chrome JSON so users can drop it into
https://ui.perfetto.dev verbatim.

### Open questions
- Does Perfetto's native proto buy anything over Chrome JSON for a
  50k-event NPU trace?
- IEEE 1364-2005 has no first-class enum for NPU transaction
  events — extend via `$comment` metadata or fall through to FST?

### Recommendation (concrete)
Implement `pccx_core::vcd_writer` per IEEE 1364-2005 §18 and
`pccx_core::chrome_trace` per Google Trace Event Format to back the
`export_vcd` / `export_chrome_trace` IPC handlers (currently
unregistered at `src-tauri/src/lib.rs:522-541`), and re-source
`FlameGraph.tsx:86` `spans` from `fetch_trace_payload` output parsed
into Chrome Trace duration events.

---

(Word count: ~1,240.)
