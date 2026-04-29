# Judge Report — Round 5 — 2026-04-20

## Summary

**Overall grade: B** (up from B-). Round 4's three tickets landed
clean, every acceptance-bullet count verifies, `cargo test --lib` runs
**51 passed / 0 failed / 0 ignored** (baseline 39 → +12: 5 live_window,
4 vivado_timing, 3 flat_buffer_v2) at `src/core/src/` and
`src/ui/src-tauri/src/lib.rs:665,678` registers `load_timing_report` +
`fetch_live_window`. `rg "Math.random|Math.sin" src/ui/src` = **9**
(R4 cap ≤ 11, ); `rg "N_LAYERS" src/ui/src/FlameGraph.tsx` = **0**
(); the `(synthetic)` badge appears at `FlameGraph.tsx:549` gated
by `synthetic && !loading && spans.length === 0` (`:629`); v1 flat
buffers still decode via `trace.rs:351 flat_buffer_v2_decodes_v1_payload`
(passing). `npx vite build` succeeds in 17.78 s (3.87 MB bundle,
unchanged from R4). Three distinct fake-fix closures with tests +
fixtures + IPC + UI consumer (T-1) or IPC only (T-2) is real work.

**But five material gaps survive, and two of them are explicit
acceptance-bullet misses from Round 4, not new drift:**

1. **T-2 is half-wired.** `vivado_timing.rs` parses cleanly,
   `load_timing_report` registered (`lib.rs:261,665`), but
   `SynthStatusCard.tsx:72` still invokes `load_synth_report` — the
   R4 roadmap bullet "a minimal UI table panel" is absent. The T-2
   implementer explicitly admits it (`implemented_T2.md:53-55`:
   *"No UI changes. SynthStatusCard already consumes timing data
   via existing channels; the new command … will be adopted in a
   follow-up"*). That follow-up is Round 5 and nobody picked it up.
   Dim-6 lifts to D on parser merit alone; it'd be D+ if the card
   actually rendered `TimingReport`.
2. **Real benchmark untouched — 4 rounds running.** `App.tsx:269
   handleTestIPC` still round-trips the already-cached
   `fetch_trace_payload` and prints MB/ms. The R4 Top-5 #5 ("launch
   `pccx_cli` with gemm 32×32×1024, write temp `.pccx`, reload via
   `load_pccx`") was scoped out and nothing landed.
3. **Monaco editor — 4 rounds deferred, still no `@monaco-editor/react`.**
   `rg monaco src/ui/package.json` → 0; `CodeEditor.tsx:196
   SV_KEYWORDS` + `:205 HighlightedCode` + `:284 setInterval`-driven
   fake simulation untouched. 409 LoC of R3-era placeholder.
4. **`LICENSE_SCOPE.md` — 4 rounds stale.** Repo root has `LICENSE`
   (MIT) but no open-core boundary doc. Dim-10 stays at C+ (R3
   flagged; R4 flagged; still zero action).
5. **`hw_layout.rs` — 2 rounds ghost.** R3 roadmap promised it, R4
   T-2 deferred it, R5 roadmap hasn't proposed it. `DIAGRAM_NODES`
   (`HardwareVisualizer.tsx:189-202`) is still the only hardware-shape
   source of truth. Dim-5 flat at B-.

No **new** fake-fixes — the three R4 tickets are provenance-clean.
No silent regressions either: `cargo test --lib` went 39 → 51,
`cargo check` (src-tauri) is clean, vite bundle unchanged. The B
grade is the weight of real core work (612 LoC across three modules
with 12 new tests) minus the unresolved four-round backlog. B+ was
on the table if T-2 had shipped a UI consumer and `handleTestIPC`
had spawned `pccx_cli`.

## Table

| # | Dimension | R-5 | R-4 | R-3 | Progress vs R-4 | Anchor | Headline gap |
|---|---|---|---|---|---|---|---|
| 1 | RTL / waveform UX         | B-  | B-  | B- | 0       | Verdi / Surfer   | `WaveformViewer.tsx:132,134` still seeds `p_accum` with `Math.floor(Math.random())` |
| 2 | ISA validation & trace    | B-  | B-  | B- | 0       | Spike / Whisper  | No reg-file, no pipe-stage, no `isa_replay` UI panel |
| 3 | API / driver integrity    | B   | C+  | D+ | **+1**  | CUPTI            | `flat_buffer_v2` trailer carries `api_name`; FlameGraph renders `uca_*` qualified (`FlameGraph.tsx` T-3) |
| 4 | UVM coverage & regression | B-  | B-  | B- | 0       | Questa IMC / URG | Untouched; `coverage.rs` still same shape |
| 5 | FPGA verification         | B-  | B-  | C+ | 0       | Vivado ILA       | `HardwareVisualizer.tsx:486` `Math.sin` pulse stays; `DIAGRAM_NODES` TSX literal stays; no `hw_layout.rs` emitter |
| 6 | ASIC signoff readiness    | D   | F   | F  | **+2**  | PrimeTime        | `vivado_timing` parses; `SynthStatusCard.tsx:72` still on `load_synth_report` — parser wired but unconsumed |
| 7 | GPU / accelerator profile | B   | B-  | B- | **+1**  | Nsight Systems   | `N_LAYERS` literal gone; `(synthetic)` badge honest; flame graph is real |
| 8 | UI / UX / docking         | B   | B   | B  | 0       | VS Code          | No Monaco (`package.json` rg-0); `CodeEditor.tsx:205 HighlightedCode` regex tokenizer untouched |
| 9 | Documentation & onboarding| B+  | B+  | B+ | 0       | Nsight Guide     | `docs/_static/screenshots/` no R4/R5 refresh; no new Monaco or SynthStatusCard shot |
|10 | Openness / licensing      | C+  | C+  | B- | 0       | GTKWave / Surfer | `LICENSE_SCOPE.md` absent 4 rounds running |

## Detailed findings

**Dim-3 jumps C+ → B.** The single-largest real lift. `trace.rs:77`
now emits a trailing `name_table` (magic `0x32434350 = "PCC2"`, +
`event_index u32 | len u16 | utf8 bytes` rows) when events carry
`api_name = Some(...)`. Tests at `trace.rs:297 flat_buffer_v2_roundtrip`,
`:331 flat_buffer_v2_omits_trailer_when_no_names` (48-byte empty-trailer
assertion), and `:351 flat_buffer_v2_decodes_v1_payload`
(hand-built v1 bytes round-trip) prove the v1↔v2 migration contract
is preserved. `FlameGraph.tsx:parseFlatBuffer` and
`HardwareVisualizer.tsx:260 FLAT_BUFFER_V2_MAGIC` stop-at-magic
scan confirm parser symmetry. API_CALL spans now read `uca_submit_cmd@core0`
instead of generic `api_call@core0`. Held at B only because the UI
tooltip column doesn't yet surface `api_name` in the detail sheet —
the span label lights up but the hover card still reads event_type.

**Dim-6 jumps F → D.** `vivado_timing.rs` (232 LoC inc. 4 tests)
parses `report_timing_summary -quiet -no_header` per UG906; fixture
`hw/sim/reports/kv260_timing_post_impl.rpt` exercises 2 clock
domains (core_clk @ 250 MHz, axi_clk @ 100 MHz) with negative WNS.
`parse_worst_endpoint` extracts `u_gemm_systolic → u_normalizer`.
`lib.rs:261 load_timing_report(path) -> Result<TimingReport, String>`
is registered at `:665`. **But `SynthStatusCard.tsx:72` still calls
`load_synth_report`, not `load_timing_report`.** `T-2.md:53-55`
notes this is deferred. Grade stays at D because no user-facing
panel consumes the structured result — the parser is shelfware
until the card migrates.

**Dim-7 jumps B- → B.** `FlameGraph.tsx` no longer ships the 170-line
Gemma 3N E4B literal demo tree. The R3 judge's acceptance-0 target
`rg "N_LAYERS" src/ui/src/FlameGraph.tsx` = 0 is verified. The
`(synthetic)` pill in the toolbar uses `theme.error` (warm amber) so
users see provenance at a glance. Honest empty state +
`setSynthetic(true)` on the catch branch (line 257) is Yuan OSDI
2014 "loud fallback" done right. Held below B+ because the flame
graph's AI-recommendation pane still uses baked heuristics
(`FlameGraph.tsx:438 setInterval` animation) that are ornamental
but could be model-backed.

**Dim-8 flat at B.** `CodeEditor.tsx` at 409 LoC still has the same
three R2-era artefacts: the 28-keyword SV regex tokenizer
(`:196 SV_KEYWORDS`), the `<HighlightedCode>` component (`:205`),
and the `setInterval`-driven fake "simulation" (`:284`). No Monaco,
no Monarch grammar, no Ctrl+F find widget, no LSP. Four rounds of
"next round's ticket" is hurting credibility against VS Code /
JetBrains. Grade held up only by docking/palette polish already in
place from R2.

**Dim-10 flat at C+.** `LICENSE_SCOPE.md` still absent from repo
root. Ships MIT via top-level `LICENSE` but the open-core boundary
(which modules will remain MIT vs which flip proprietary?) has
never been drawn. R3 flagged it; R4 flagged it; Round 5 is now the
third consecutive report with the same finding.

## Progress vs Round 4

**What got better.** (1) `Math.random|Math.sin` dragnet cut from
20 → 9 matches (55 % reduction; BottomPanel, PerfChart, Roofline
migrated to `fetch_live_window` IPC). (2) `N_LAYERS` literal deleted
(5 matches → 0); `(synthetic)` badge live. (3) Flat-buffer v2 ships
the `api_name` trailer; v1↔v2 migration contract is test-verified.
(4) Vivado timing parser lands with 2-clock-domain fixture + 4
tests. (5) `cargo test --lib` 39 → 51 (+12 new tests). (6) Three
new core modules under 250 LoC each; all production paths covered.

**What regressed.** Nothing structural. `setInterval` count is
unchanged at 7, but 3 of those (BottomPanel:133, PerfChart:39,
Roofline:214) are now real IPC pollers — composition improved, not
regressed.

**What was not touched.** (1) Monaco migration (4-round backlog).
(2) `LICENSE_SCOPE.md` (4-round backlog). (3) Real `pccx_cli`
benchmark behind "Run benchmark" menu (R4 Top-5 #5). (4) `hw_layout.rs`
core emitter (R3 Top-5 item). (5) SynthStatusCard adoption of
`load_timing_report` (R4 T-2 explicit deferral). (6) Dim-2
(ISA reg-file / pipe-stage UI), Dim-4 (UCIS/URG merge), Dim-9
(screenshot refresh).

## Top-5 must-fix for Round 6 — pay the debt

1. **SynthStatusCard migrates to `load_timing_report`.**
   `SynthStatusCard.tsx:72` currently reads `load_synth_report`.
   Split the card: top half keeps `load_synth_report` for utilisation
   (LUT/FF/BRAM/DSP), bottom half calls `load_timing_report(timingPath)`
   and renders `TimingReport` (WNS, TNS, failing_endpoints, per-clock
   table). **Accept**: `rg "load_timing_report" src/ui/src/` ≥ 1;
   Dim-6 lifts D → C. **(S, ~150 LoC.)**

2. **Monaco editor — ship it this round.**
   Four-round backlog on Dim-8. Add `@monaco-editor/react@^4.7` +
   `monaco-editor@^0.52` to `src/ui/package.json`, replace
   `CodeEditor.tsx:205 HighlightedCode` + `:196 SV_KEYWORDS` with
   `<Editor language="systemverilog">`, register Monarch grammar,
   wire find widget (Ctrl+F). **Accept**: `rg "@monaco-editor/react"
   src/ui/package.json` ≥ 1; `rg "HighlightedCode|SV_KEYWORDS"
   src/ui/src/CodeEditor.tsx` → 0. **(L, ~400 LoC net.)**

3. **Finish the fake-telemetry dragnet (9 → ≤ 2).**
   Remaining offenders, with triage: WaveformViewer.tsx:132,134
   (p_accum RNG — migrate to real VCD read or flag synthetic);
   Timeline.tsx:86,88 (demo fallback; route through an empty-state
   overlay like FlameGraph R4 pattern); ReportBuilder.tsx:105
   (core-utilisation grid; call `fetch_live_window` reducer);
   ExtensionManager.tsx:55 (install progress — replace
   `Math.random() * 6` with a fixed 20 %/tick progression);
   CanvasView.tsx:165,171 + HardwareVisualizer.tsx:486 (3D pulse
   and busy dot — keep only if annotated "ornamental" and wrapped
   in an `animated={isPlaying}` guard). **Accept**:
   `rg "Math.random|Math.sin" src/ui/src` ≤ 2 (ornamental residuals
   only). **(M, ~250 LoC.)**

4. **Real "Run benchmark" — launch `pccx_cli` with workload spec.**
   Still deferred from R4. `App.tsx:269 handleTestIPC` re-reads the
   cached payload. Replace with a `tauri::command run_benchmark`
   that invokes `pccx_cli --workload gemm_32x32x1024 --out /tmp/bench.pccx`,
   awaits `load_pccx(/tmp/bench.pccx)`, then emits a toast "N
   events in T ms". **Accept**: menu → "Run benchmark" produces a
   real trace ≥ 10 k events with workload metadata in the header.
   **(M, ~250 LoC.)**

5. **`LICENSE_SCOPE.md` — draw the open-core boundary.**
   Four rounds stale. Write a ≤ 200-line doc covering: (a) MIT
   scope (core, parsers, UI shell, test fixtures), (b) proprietary-
   candidate scope if any (AI copilot bridge, any cloud-specific
   code), (c) contributor license contract. **Accept**:
   `ls LICENSE_SCOPE.md` exists; doc references root `LICENSE` +
   enumerates at least 5 modules with their licensing disposition.
   **(S, ~200 LoC markdown.)**

(Word count: ~1725.)
