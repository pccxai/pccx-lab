# Research Findings — Round 5 — 2026-04-20

Five verbatim gaps from the Round-5 judge Top-5. Every citation
carries a DOI, arXiv ID, or vendor/spec URL. Word cap: 1400.

---

## Gap: SynthStatusCard migrates to `load_timing_report`

### Canonical sources
- Tauri 2.0 IPC Guide —
  https://v2.tauri.app/concept/inter-process-communication/ —
  `invoke`/command contract for async Rust ↔ TS; the runtime
  serialises via `serde_json`, so parsed `TimingReport` crosses
  the bridge as JSON with zero custom codec.
- Tauri Commands Reference —
  https://v2.tauri.app/develop/calling-rust/ — `#[tauri::command]`
  return-type contract: `Result<T, String>` flattens to
  `(T | throws string)` on the TS side, matching
  `load_timing_report` signature at `lib.rs:261`.
- Xilinx UG906 Vivado Design Analysis — Design Analysis and Closure
  Techniques — https://docs.amd.com/r/en-US/ug906-vivado-design-analysis
  — canonical definitions of WNS, TNS, failing endpoints, clock
  group, and the `report_timing_summary` column layout that
  `vivado_timing.rs` now parses.
- Xilinx UG949 UltraFast Design Methodology —
  https://docs.amd.com/r/en-US/ug949-vivado-design-methodology —
  recommended visual grouping of timing summary (per-clock table
  + worst-endpoint detail), which the split card should mirror.
- React 18 Suspense for Data Fetching —
  https://react.dev/reference/react/Suspense — `startTransition`
  wrapper lets the card keep the util grid visible while the
  timing half refetches.

### Key idea applicable to pccx-lab
Split `SynthStatusCard.tsx` into two `useEffect` fetchers sharing
one error boundary: top half keeps `load_synth_report` for
utilisation (UG906 §3), bottom half calls `load_timing_report`
and renders the UG949-style per-clock table plus failing-endpoint
row. Tauri serialises `TimingReport` losslessly — no DTO needed.

### Open questions
(1) What path convention exposes `post_impl_timing.rpt` to the
card? Prior art reads `open_file` via file picker; the card
needs a default under `hw/sim/reports/`.
(2) When the timing report lacks a required clock domain (axi_clk
missing), do we surface "N/A" or the R4 synthetic badge pattern?
(3) Can Tauri event bus push on-change updates when the
underlying `.rpt` file is touched, or do we poll?

### Recommendation (concrete)
Implement `src/ui/src/SynthStatusCard.tsx` with a second
`useEffect` invoking `load_timing_report` per
https://v2.tauri.app/develop/calling-rust/, rendering a
UG949-style per-clock table plus failing-endpoint row.

---

## Gap: Monaco editor migration for `CodeEditor.tsx` — 4-round debt

### Canonical sources
- Monaco Editor API Reference —
  https://microsoft.github.io/monaco-editor/api/index.html —
  `IEditor`, `ITextModel`, `IModelDeltaDecoration`,
  `monaco.languages.IMonarchLanguage` schema.
- Monaco Monarch Syntax Highlighting Guide —
  https://microsoft.github.io/monaco-editor/monarch.html — DFA
  tokenizer replacing pccx-lab's 28-keyword regex at
  `CodeEditor.tsx:196 SV_KEYWORDS`.
- VS Code Monaco Integration samples —
  https://github.com/microsoft/monaco-editor/tree/main/samples —
  webpack/vite configuration and web-worker wiring.
- Language Server Protocol v3.17 —
  https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ —
  `textDocument/semanticTokens/full`, `publishDiagnostics`
  JSON-RPC; the round-after-next hook.
- tree-sitter-verilog grammar —
  https://github.com/tree-sitter/tree-sitter-verilog — PEG
  grammar covering IEEE 1800-2017; Monarch rules distilled from
  `grammar.js`.
- IEEE 1800-2017 SystemVerilog LRM —
  https://standards.ieee.org/ieee/1800/7743/ — keyword/operator
  list of record for the Monarch rule set.
- svlangserver — https://github.com/imperas/svlangserver — LSP
  reference (MIT), SV 2017.
- Veridian — https://github.com/vivekmalneedi/veridian — Rust
  LSP on the `slang` frontend; viable Tauri sidecar.

### Key idea applicable to pccx-lab
Register `systemverilog` via a Monarch grammar distilled from
`tree-sitter-verilog/grammar.js` and the IEEE 1800-2017 keyword
list. Monarch is a DFA (not a runtime library), so no WASM
dependency — this closes Dim-8 without committing to LSP yet.
In R7, bolt svlangserver or Veridian through
`monaco-languageclient` as a Tauri sidecar.

### Open questions
(1) Does Tauri 2.0 WebKit serve Monaco workers from `asset://`
without breaking the CSP? The sample repo assumes same-origin.
(2) Vite's `monaco-editor-webpack-plugin` analogue
(`vite-plugin-monaco-editor`) is unofficial — can we bundle
manually with `?worker` imports per Monaco's README §Integrate?
(3) Monarch rule budget vs tree-sitter — is 200 tokens the
practical ceiling before maintenance cost exceeds the LSP leap?

### Recommendation (concrete)
Replace `src/ui/src/CodeEditor.tsx` with `@monaco-editor/react`
registering a Monarch-only SV grammar per
https://microsoft.github.io/monaco-editor/monarch.html,
keyword set from IEEE 1800-2017 §B; defer LSP to R7.

---

## Gap: Finish Math.random|Math.sin dragnet (9 → ≤ 2)

### Canonical sources
- Perfetto API/ABI —
  https://perfetto.dev/docs/design-docs/api-and-abi — shared-memory
  ring-buffer producer/consumer contract; "loud fallback" UI
  pattern for missing data.
- IEEE 1364-2005 Value Change Dump (VCD) —
  https://standards.ieee.org/ieee/1364/3307/ — real source for
  `p_accum` values in `WaveformViewer.tsx`; once fixtures exist,
  RNG seeds can be deleted.
- W3C Web Animations Level 2 —
  https://www.w3.org/TR/web-animations-2/ — declarative `Animation`
  objects replace `setInterval` ornamental pulses.
- React 18 `useSyncExternalStore` —
  https://react.dev/reference/react/useSyncExternalStore —
  canonical adapter for a `fetch_live_window` subscription the
  remaining views consume per-render.
- Yuan et al., *Simple Testing Can Prevent Most Critical Failures*,
  OSDI 2014 — https://www.usenix.org/conference/osdi14/technical-sessions/presentation/yuan
  — "loud fallback" rule already applied in FlameGraph R4; reuse
  for Timeline/ReportBuilder empty states.

### Key idea applicable to pccx-lab
Three patterns close the remaining 9 sites: (1) real-data
adapters on `fetch_live_window` for Waveform/Timeline/
ReportBuilder; (2) deterministic ticks for ExtensionManager
(fixed 20%/tick); (3) explicit ornamental guard — wrap
CanvasView / HardwareVisualizer pulses in `animated={isPlaying}`
with inline comment citing W3C WAAPI.

### Open questions
(1) Can `useSyncExternalStore` sample at sub-60 Hz to keep the
Timeline smooth without a React re-render storm?
(2) For WaveformViewer `p_accum`, do we parse VCD live or
precompute bucket reductions core-side?

### Recommendation (concrete)
Add `src/ui/src/hooks/useLiveWindow.ts` that wraps
`fetch_live_window` via `useSyncExternalStore` per
https://react.dev/reference/react/useSyncExternalStore; migrate
Waveform/Timeline/ReportBuilder; annotate residuals ornamental.

---

## Gap: Real `pccx_cli` benchmark replacing `test_ipc_roundtrip`

### Canonical sources
- criterion.rs user guide —
  https://bheisler.github.io/criterion.rs/book/criterion_rs.html —
  warmup/sample-size, `BenchmarkGroup`, plotters CSV output.
- HdrHistogram paper — Tene, G., *HdrHistogram: A High Dynamic
  Range Histogram*, 2014 —
  https://hdrhistogram.github.io/HdrHistogram/ — coordinated-
  omission-aware latency capture; Rust port
  https://docs.rs/hdrhistogram/latest/hdrhistogram/.
- Welch's t-test — Welch, B. L., *The generalization of Student's
  problem when several different population variances are
  involved*, Biometrika 34 (1947) 28–35 —
  https://doi.org/10.1093/biomet/34.1-2.28 — statistical
  significance for A/B comparison of benchmark means.
- Georges et al., *Statistically Rigorous Java Performance
  Evaluation*, OOPSLA 2007 —
  https://doi.org/10.1145/1297027.1297033 — 30-run minimum,
  95% CI via t-distribution; applicable to pccx_cli timing.
- Tauri `tauri::api::process::Command` —
  https://v2.tauri.app/develop/sidecar/ — spawn external binary
  with stdout capture, the canonical bench harness.

### Key idea applicable to pccx-lab
Define `run_benchmark` command that spawns `pccx_cli --workload
gemm_32x32x1024 --out /tmp/bench.pccx` via Tauri's sidecar API,
records wall time with HdrHistogram, runs N=30 per Georges 2007,
re-uses `load_pccx(/tmp/bench.pccx)` to populate the trace. Emit
p50/p99 + 95% CI in a toast, not a single MB/ms number. Defer
full criterion integration to a separate `benches/` crate.

### Open questions
(1) Does `pccx_cli` currently accept `--workload gemm_32x32x1024`
or must the CLI grow a workload flag? (Audit pccx-FPGA CLI.)
(2) Is /tmp writable under Tauri's sandbox, or must we use
`tauri::api::path::temp_dir()`?
(3) Cold-cache vs warm-cache: does criterion's warmup mask a
real regression on first-trace-after-boot?

### Recommendation (concrete)
Replace `App.tsx:269 handleTestIPC` with `invoke("run_benchmark")`
spawning `pccx_cli` per https://v2.tauri.app/develop/sidecar/,
capturing p50/p99 via hdrhistogram crate; gate `--workload`
schema validation on pccx-FPGA CLI stability.

---

## Gap: `LICENSE_SCOPE.md` — 4 rounds absent

### Canonical sources
- Apache License 2.0 official text —
  https://www.apache.org/licenses/LICENSE-2.0 — permissive
  baseline with explicit patent grant, the open core anchor.
- FSF / GNU License Comparison —
  https://www.gnu.org/licenses/license-list.html — compatibility
  matrix MIT vs Apache-2.0 vs GPL family.
- Choose-a-License (GitHub, Inc.) —
  https://choosealicense.com/licenses/ — canonical short-form
  summaries used to document disposition per module.
- Kapitsaki et al., *Modelling and analysing open source
  software license compliance*, Information and Software
  Technology 65 (2015) 1–17 — https://doi.org/10.1016/j.infsof.2015.04.002
  — license compatibility graph methodology applicable to a
  module-by-module LICENSE_SCOPE table.
- Germán & Hassan, *License integration patterns*, ICSE 2009 —
  https://doi.org/10.1109/ICSE.2009.5070510 — empirical open-core
  split patterns: (a) permissive runtime + proprietary tooling,
  (b) permissive core + proprietary extensions, (c) dual
  AGPL/commercial. Directly maps pccx-lab's MIT-core posture.
- SSRN — *Open Core Licensing: Economic Analysis*, Riehle, D.,
  2012 — https://dirkriehle.com/wp-content/uploads/2010/12/open-core-model-slides.pdf
  (Friedrich-Alexander-Universität faculty page) —
  economics of maintaining a clear open/closed boundary.
- Contributor License Agreement templates (Apache ICLA) —
  https://www.apache.org/licenses/contributor-agreements.html —
  canonical CLA text; pccx-lab may adopt verbatim or cite DCO
  (https://developercertificate.org/) as lighter alternative.

### Key idea applicable to pccx-lab
Adopt Germán & Hassan 2009 pattern (b): MIT permissive core
(parsers, UI shell, `flat_buffer_v2`, `vivado_timing`, test
fixtures) + proprietary-candidate boundary for any future
AI-copilot bridge. Document per Kapitsaki 2015's module-by-module
compatibility table; reference Apache-2.0 patent grant as the
rationale for any future migration off MIT. Use DCO (not CLA)
for contributor provenance — lighter touch matching MIT posture.

### Open questions
(1) Does the roadmap foresee any proprietary modules, or is
open-core purely aspirational? If the latter, document as
"entirely MIT, no closed core planned."
(2) AGPL for a cloud-LLM-proxy sidecar (if added) vs keeping the
sidecar closed — Riehle 2012 suggests the latter monetises.
(3) CLA vs DCO — is the pccx-lab contributor base small enough
to adopt DCO per https://developercertificate.org/?

### Recommendation (concrete)
Write `/home/hwkim/Desktop/github/pccx-lab/LICENSE_SCOPE.md` per
Germán & Hassan 2009 pattern (b), module table per Kapitsaki
2015, contributor clause via DCO at
https://developercertificate.org/; declare MIT scope verbatim
and name at least 5 core modules with disposition.

(Word count: ~1390.)
