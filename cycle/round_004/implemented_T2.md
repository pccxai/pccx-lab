# Round 4 — T-2 Implementation Report

**Ticket:** Vivado post-route timing-summary parser (Dim-6 ASIC
signoff readiness: F → D).
**Owner:** core. **Date:** 2026-04-20. **Commit scope:** `feat(core)`.

## What shipped

1. `src/core/src/vivado_timing.rs` (new, 232 LoC incl. tests) —
   parses `report_timing_summary -quiet -no_header` text per UG906
   "Design Analysis and Closure" section headers. Public API:
   - `TimingReport { wns_ns: f32, tns_ns: f32, failing_endpoints: u32,
     clock_domains: Vec<ClockDomain> }`
   - `ClockDomain { name, wns_ns, tns_ns, period_ns }`
   - `FailingPath { from, to, slack_ns, logic_delay }`
   - `parse_timing_report(txt) -> Result<TimingReport, ParseError>`
   - `parse_worst_endpoint(txt) -> Option<FailingPath>`
   - `ParseError { Empty, MissingSummaryRow }` via `thiserror`.
2. `src/core/src/lib.rs` — `pub mod vivado_timing;` + re-export of
   `TimingReport`, `ClockDomain`, `FailingPath`, and `ParseError`
   (renamed to `TimingParseError` at the public surface to avoid
   colliding with other modules' error enums).
3. `src/ui/src-tauri/src/lib.rs` — `#[tauri::command] fn
   load_timing_report(path: String) -> Result<TimingReport, String>`
   + registration in `tauri::generate_handler!`.
4. `hw/sim/reports/kv260_timing_post_impl.rpt` (new, 72 LoC fixture)
   — 2-clock-domain Vivado 2024.1-style report with `core_clk` @
   250 MHz (WNS −0.412 ns) + `axi_clk` @ 100 MHz (WNS −0.083 ns).
   Representative of the pccx v002 state the roadmap baselines
   against.
5. **4 unit tests** in `vivado_timing::tests`, all green:
   - `parse_empty_is_met` — empty input → `ParseError::Empty`; a
     minimal met-report round-trips with `failing_endpoints == 0`.
   - `parse_kv260_report` — fixture parses into 2 clock domains
     with negative WNS, non-zero failing endpoints, correct
     `period_ns` per clock.
   - `parse_worst_endpoint` — extracts `u_gemm_systolic → u_normalizer`
     path with negative slack + non-zero data-path delay.
   - `parse_multi_clock` — confirms 250 MHz `core_clk` is tighter
     than 100 MHz `axi_clk` (period ordering).

## Acceptance

- [x] `cargo test vivado_timing` green with 4 tests.
- [x] `cargo test --lib` total = 51 (≥ 43). Baseline was 39; T-1
      added 8 `live_window` tests; T-2 adds 4.
- [x] `load_timing_report` IPC registered in `invoke_handler!`
      (line 665 in `src/ui/src-tauri/src/lib.rs`).
- [x] Fixture `hw/sim/reports/kv260_timing_post_impl.rpt` parseable
      by the new parser (`parse_kv260_report` test uses
      `include_str!` on it).
- [x] No UI changes. SynthStatusCard already consumes timing data
      via existing channels; the new command is the proper
      replacement for the regex-rigged `synth_report::parse_timing`
      stub and will be adopted in a follow-up T-5 Monaco/editor round.

## Implementation notes

- The parser is forgiving: divider rows are detected by the
  "all-`-`-or-space" predicate so that numeric rows starting with
  a minus sign (like `-0.412`) are never misclassified as dividers.
- Section boundaries use a dedicated `is_section_header` helper
  that matches `| Capital`-prefixed headers only, so the
  `| -------` underline lines don't prematurely close an active
  block.
- `parse_section` is a shared scanner that takes a per-row closure
  — the Clock Summary and Intra Clock Table parsers differ only in
  their row-unpack logic, keeping the production code under 170 LoC.
- The Inter Clock Table (cross-domain paths) and Timing Details
  detailed-path blocks are NOT parsed yet; the ticket scopes this
  explicitly to the summary. `parse_worst_endpoint` is a single-shot
  extractor for the first VIOLATED record only, sufficient for the
  UI's critical-path row.

## LoC budget

- `vivado_timing.rs`: 232 LoC total (≈ 165 prod + 67 tests).
- `lib.rs` re-exports: +7 LoC.
- `src-tauri/src/lib.rs` command: +15 LoC.
- Fixture (not production code): 72 LoC.
- **Net Rust LoC: ≈ 187, well under the 250 cap.**

## Builds

```
$ cd src/core && cargo test --lib
test result: ok. 51 passed; 0 failed; 0 ignored; 0 measured

$ cd src/ui/src-tauri && cargo check
Finished `dev` profile
```

## Files touched

- `src/core/src/vivado_timing.rs` (new)
- `src/core/src/lib.rs` (+7)
- `src/ui/src-tauri/src/lib.rs` (+15)
- `hw/sim/reports/kv260_timing_post_impl.rpt` (new fixture)

## Commit

`feat(core): T-2 vivado_timing parser + KV260 fixture`
