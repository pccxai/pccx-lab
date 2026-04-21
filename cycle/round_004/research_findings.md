# Research Findings — Round 4 — 2026-04-20

5 verbatim gaps from the Round-4 judge Top-5. Every citation
carries a DOI, arXiv ID, or vendor/spec URL.

---

## Gap: Monaco editor migration — still not done

### Canonical sources
- Monaco Editor API Reference —
  https://microsoft.github.io/monaco-editor/api/index.html —
  IEditor/ITextModel/IModelDeltaDecoration and the
  `monaco.languages.IMonarchLanguage` schema.
- Monaco Monarch Syntax Highlighting Guide —
  https://microsoft.github.io/monaco-editor/monarch.html — DFA
  tokenizer that replaces pccx-lab's 28-keyword regex.
- Language Server Protocol v3.17 —
  https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ —
  `textDocument/semanticTokens/full`, `publishDiagnostics` JSON-RPC.
- tree-sitter-verilog grammar —
  https://github.com/tree-sitter/tree-sitter-verilog — PEG grammar
  covering IEEE 1800-2017; usable as a WASM import.
- svlangserver — https://github.com/imperas/svlangserver — IEEE
  1800-2017 LSP reference implementation (MIT).
- Veridian SV LSP — https://github.com/vivekmalneedi/veridian —
  Rust-native LSP on the `slang` frontend.

### Key idea applicable to pccx-lab
Monarch is a deterministic state machine Microsoft designed to
replace ad-hoc regex highlighters like `CodeEditor.tsx:213`. For
the SV viewer we register a `systemverilog` language, attach a
Monarch grammar distilled from `tree-sitter-verilog/grammar.js`,
and in a later round bolt svlangserver/Veridian through
`MonacoLanguageClient`. This closes Dim-8 and reuses the Tauri IPC
layer already wrapping the trace loader.

### Open questions
(1) Does Tauri 2.0 WebKit accept Monaco's web-worker requirement
(cross-origin isolation headers)?
(2) Minimum Monarch subset to avoid a Tree-sitter WASM runtime?
Monaco ships no Tree-sitter adapter.
(3) Package svlangserver as a Tauri sidecar, or require local
install?

### Recommendation (concrete)
Implement `src/ui/src/CodeEditor.tsx` as `@monaco-editor/react`
registering a Monarch-only SV language per
https://microsoft.github.io/monaco-editor/monarch.html; defer LSP.

---

## Gap: Kill the 7-file fake-telemetry dragnet — seriously this time

### Canonical sources
- Intel VTune Profiler User Guide (2024.2) —
  https://www.intel.com/content/www/us/en/docs/vtune-profiler/user-guide/2024-2/overview.html —
  `hw-events` via `perf_event_open` PMU counters.
- Intel PCM — https://github.com/intel/pcm — reference MSR/PMU
  sampling loops with ring-buffer aggregation.
- AMD uProf User Guide v4.2 —
  https://www.amd.com/content/dam/amd/en/documents/developer/version-4-2-documents/uprof/uprof-user-guide-v4.2.pdf —
  IBS + PMC online sampling API.
- Xilinx PG157 AXI Performance Monitor —
  https://docs.amd.com/v/u/en-US/pg157-axi-perf-mon — hardware
  counter IP for KV260 latency/throughput windows.
- UG1145 PetaLinux —
  https://docs.amd.com/r/en-US/ug1145-petalinux-tools-ref-guide —
  `perf stat`/`perf record` on Zynq.
- Linux `perf_event_open(2)` —
  https://man7.org/linux/man-pages/man2/perf_event_open.2.html —
  `mmap` ring-buffer head/tail contract that maps onto a Rust IPC
  window.
- Perfetto API/ABI — https://perfetto.dev/docs/design-docs/api-and-abi —
  Google's shared-memory ring-buffer producer/consumer protocol.

### Key idea applicable to pccx-lab
Replace every `setInterval(() => Math.random())` with one Tauri
command `fetch_live_window(from_cy,to_cy) -> LiveSample` that
reduces `state.trace.events` over a cycle window — the same
head/tail ring semantics `perf_event_open` uses. `LiveSample`
carries MAC util %, DRAM BW, stall %, and per-cycle waveforms that
BottomPanel/PerfChart/Roofline/Timeline/WaveformViewer each need.
Empty windows emit an empty-sample enum; UI renders the
VerificationSuite placeholder.

### Open questions
(1) Pre-simulation (no trace) — zeroed window or degraded panel?
(2) 60 Hz snapshot vs on-demand poll? Perfetto's 1-tick trades
latency for CPU.
(3) PMU-style stall-reason sampling vs plain event-count
reduction — today we only have the latter in `NpuTrace`.

### Recommendation (concrete)
Implement `fetch_live_window` in `src/core/src/lib.rs` as a
reducer over `NpuTrace.events`, shaped after the
`perf_event_open(2)` head/tail ring contract at
https://man7.org/linux/man-pages/man2/perf_event_open.2.html.

---

## Gap: Flat-buffer v2 + N_LAYERS = 10 retirement

### Canonical sources
- FlatBuffers internals (Google) —
  https://flatbuffers.dev/flatbuffers_internals.html — vtable
  zero-copy schema evolution; `table` adds `api_name` without
  breaking 24-byte readers.
- FlatBuffers schema —
  https://flatbuffers.dev/flatbuffers_guide_writing_schema.html —
  optional-default + `deprecated` keywords preserving layout.
- Cap'n Proto encoding —
  https://capnproto.org/encoding.html — alternative pointer-based
  zero-copy wire format.
- Apache Arrow Columnar —
  https://arrow.apache.org/docs/format/Columnar.html — zero-copy
  variable-length strings (offsets + data buffers).
- Arrow Flight RPC —
  https://arrow.apache.org/docs/format/Flight.html — framing
  usable for the Tauri channel.
- `rkyv` — https://rkyv.org/ and https://github.com/rkyv/rkyv —
  Rust-native zero-copy, eliminates the packed-struct cast.

### Key idea applicable to pccx-lab
The 24-byte stride (`u32,u64,u64,u32`) is a FlatBuffers `struct`
(fixed); upgrading to a `table` adds `api_name: string` as an
optional vtable slot without re-packing existing events.
Equivalently Arrow IPC models `api_name` as a variable-length
column next to the fixed struct array. Either retires `N_LAYERS`
because FlameGraph can then bucket by `api_name` hash.

### Open questions
(1) FlatBuffers tables add ~6 bytes vtable per event; for 10 k
events that's 60 KB overhead — acceptable?
(2) Regenerate Rust/JS bindings from `.fbs` or hand-roll decoder?
(3) Name-string interning: hash32 + side-car table, or inline?

### Recommendation (concrete)
Re-wire `fetch_trace_payload` in `src/core/src/lib.rs` as a
FlatBuffers table per
https://flatbuffers.dev/flatbuffers_guide_writing_schema.html.

---

## Gap: Post-route ASIC timing summary parser — unblock Dim-6

### Canonical sources
- Xilinx UG906 "Vivado Design Analysis and Closure" (2024.1) —
  https://docs.amd.com/r/en-US/ug906-vivado-design-analysis/Timing-Reports —
  `report_timing_summary` sections (WNS/WHS/TNS/THS/TPWS) per
  clock group.
- Xilinx UG835 Tcl Command Reference —
  https://docs.amd.com/r/en-US/ug835-vivado-tcl-commands/report_timing_summary —
  `-no_detailed_paths`, `-file`, `-delay_type` flag semantics.
- Xilinx UG949 UltraFast Methodology —
  https://docs.amd.com/r/en-US/ug949-vivado-design-methodology —
  sign-off criteria (WNS ≥ 0, TNS = 0, no unconstrained).
- OpenTimer, Huang & Wong, ICCAD 2015 —
  DOI 10.1145/2966986.2980084 — OSS STA engine; slack-semantics
  ground truth.
- OpenSTA (Parallax) — https://github.com/parallaxsw/OpenSTA —
  OSS STA with documented report format.

### Key idea applicable to pccx-lab
Vivado emits `report_timing_summary` as deterministic text with
fixed section headers ("Clock Summary", "Intra Clock Table",
"Inter Clock Table", "Timing Details"). A line-oriented parser
keyed on those headers yields
`TimingSummary { domains: Vec<{name,wns,whs,tns,ths}> }`
without needing the XML variant. That matches the Round-4
acceptance: parse a 2-clock fixture, expose via
`load_timing_report`.

### Open questions
(1) Also parse `report_timing -of_objects` detailed paths, or
strict summary-only?
(2) `.rpt` vs `-format xml` (UG835 option) — XML parses more
deterministically.
(3) UltraScale+ Hold vs Recovery/Removal distinction on KV260?

### Recommendation (concrete)
Implement `src/core/src/vivado_timing.rs` as a section-header
parser per UG906 at
https://docs.amd.com/r/en-US/ug906-vivado-design-analysis/Timing-Reports
with a fixture under `cycle/round_004/fixtures/`.

---

## Gap: Real "Run benchmark" end-to-end

### Canonical sources
- `criterion.rs` user guide (B. Heisler) —
  https://bheisler.github.io/criterion.rs/book/ — statistical
  harness, bootstrap CI, outlier detection; de-facto Rust
  microbenchmark standard.
- HdrHistogram (G. Tene) —
  https://github.com/HdrHistogram/HdrHistogram — constant-resolution
  latency histogram with fixed error bounds.
- Curtsinger & Berger, "Stabilizer: Statistically Sound
  Performance Evaluation", ASPLOS 2013 —
  DOI 10.1145/2451116.2451141 — layout randomisation for
  significance.
- Curtsinger & Berger (extended) — arXiv:1211.5364.
- Georges et al., "Statistically Rigorous Java Performance
  Evaluation", OOPSLA 2007 — DOI 10.1145/1297105.1297033 —
  canonical warmup + CI methodology.
- Kalibera & Jones, "Rigorous Benchmarking in Reasonable Time",
  ISMM 2013 — DOI 10.1145/2464157.2464160 — cost-aware replicate
  planning.

### Key idea applicable to pccx-lab
Replace `test_ipc_roundtrip` with a criterion-style harness:
launch `pccx_cli --workload=gemm_32x32x1024 --out=/tmp/bench.pccx`,
record wall-time over N warmup + M measurement iterations, push
samples into HdrHistogram, emit mean/p50/p99 in the toast.
Stabilizer (ASPLOS-2013) warns a single-run number is unreliable;
30 iterations with bootstrap-CI (criterion default) is the
minimum respectable floor.

### Open questions
(1) In-process (link `pccx_cli` as lib) vs subprocess per iter?
Subprocess adds ~5 ms fork that criterion normally subtracts.
(2) Persist HdrHistogram to disk so round-over-round regressions
surface?
(3) Warmup budget — Georges-2007 recommends steady-state only;
pure-Rust has no JIT, so 3 warmup iters should suffice.

### Recommendation (concrete)
Replace `handleTestIPC` in `src/ui/src/App.tsx` with
`run_benchmark` driving `pccx_cli` under a criterion-style
3-warmup/30-measure loop per
https://bheisler.github.io/criterion.rs/book/analysis.html,
reporting mean ± 99 % CI in the toast.
