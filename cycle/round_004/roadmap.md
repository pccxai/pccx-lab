# Roadmap — Round 4 — 2026-04-20

## Top 3 for THIS round (must land before next judge pass)

### T-1: Kill fake-telemetry dragnet via `fetch_live_window` IPC

- Why: Judge R-4 Top-5 #2 — 20 `Math.random|Math.sin` hits across 9
  UI files; Round-3 Top-5 #5 flagged the same dragnet and nobody
  picked it up. Dim-7 stuck at B- because PerfChart renders fake
  roofline samples; Dim-10 slipping because "live" panels are
  theatre. Closing this hits two dimensions with one IPC command.
- Files:
  - `src/core/src/live_window.rs` (new, ~150 LoC) —
    `LiveSample { mac_util, dram_bw, stall_pct, waveform: [u16; 64] }`
    + `reduce_window(&NpuTrace, from_cy, to_cy) -> LiveSample`.
  - `src/core/src/lib.rs` (~30 LoC) — register
    `#[tauri::command] fetch_live_window(from_cy: u64, to_cy: u64)
    -> LiveSample`.
  - `src/ui/src/BottomPanel.tsx` (~40 LoC) — replace 3
    `Math.random` at lines 104-117 with `invoke("fetch_live_window")`.
  - `src/ui/src/PerfChart.tsx` (~50 LoC) — migrate 6 `Math.random /
    Math.sin` samplers at lines 11-41.
  - `src/ui/src/Roofline.tsx` (~30 LoC) — replace 2 `Math.random`
    at lines 177-192.
- Acceptance:
  - `rg "fetch_live_window" src/core/src/lib.rs` ≥ 1.
  - `cargo test live_window::reduce_window_` ≥ 2 tests green
    (empty + populated).
  - `rg "Math.random|Math.sin" src/ui/src/BottomPanel.tsx
    src/ui/src/PerfChart.tsx src/ui/src/Roofline.tsx` → 0.
  - `rg "Math.random|Math.sin" src/ui/src` ≤ 11.
  - `npx vite build` succeeds.
- Citations: research_findings.md
  **"Kill the 7-file fake-telemetry dragnet — seriously this time"**
  (Linux `perf_event_open(2)` head/tail ring + Perfetto SHM).
- Owner: core + ui.
- Estimated diff size: M (~300 LoC net).

### T-2: Vivado post-route timing-summary parser

- Why: Judge R-4 Top-5 #4 — Dim-6 (ASIC signoff readiness) is F for 3
  consecutive rounds. A line-oriented parser over
  `report_timing_summary -no_detailed_paths` lifts Dim-6 F → D with
  the smallest possible diff, no vendor binary pulled in.
- Files:
  - `src/core/src/vivado_timing.rs` (new, ~180 LoC) —
    `TimingSummary { domains: Vec<TimingDomain{name, wns, whs, tns,
    ths, failing_endpoints}> }` + `parse_timing_report(&str)`
    keyed on UG906 section headers ("Clock Summary", "Intra Clock
    Table", "Inter Clock Table").
  - `src/core/src/lib.rs` (~20 LoC) — `pub mod vivado_timing;` +
    `#[tauri::command] load_timing_report(path: PathBuf) ->
    Result<TimingSummary, String>`.
  - `cycle/round_004/fixtures/report_timing_summary.txt` (new,
    ~50 LoC) — 2-clock-domain Vivado 2024.1 golden sample
    (clk_pl_0 @ 250 MHz WNS +0.412; clk_pl_1 @ 100 MHz WNS -0.083).
- Acceptance:
  - `cargo test vivado_timing::parse_kv260_report` green; parses
    fixture into `domains.len() == 2`, `wns` and `tns` populated.
  - `cargo test vivado_timing::parse_empty_report_errors` green —
    malformed input returns `ParseError`, not panic.
  - `rg "load_timing_report" src/core/src/lib.rs` ≥ 1.
  - `cargo test --lib` total count rises from 39 to ≥ 42.
- Citations: research_findings.md
  **"Post-route ASIC timing summary parser — unblock Dim-6"**
  (UG906 `report_timing_summary` + UG835 `-no_detailed_paths`).
- Owner: core.
- Estimated diff size: M (~250 LoC net).

### T-3: Flat-buffer v2 — carry `api_name` + retire `N_LAYERS = 10`

- Why: Judge R-4 Top-5 #3 and Dim-3 headline — `NpuEvent.api_name`
  exists in Rust but the 24-byte stride silently drops it, so
  API_CALL spans render as generic "api_call" in UI. Simultaneously
  the 5 `N_LAYERS = 10` matches in FlameGraph are the one R-3
  backlog item the judge explicitly called out. Both collapse into
  a single flat-buffer bump, bumping Dim-2.
- Files:
  - `src/core/src/trace.rs` (~60 LoC) — bump `to_flat_buffer` to
    header + fixed array + side-table layout: `u32 magic | u32
    version=2 | u32 n_events | u32 n_names | events[24B each,
    name_idx u16 + pad u16 appended] | names[len-prefixed utf8]`.
  - `src/core/src/lib.rs` (~20 LoC) — `fetch_trace_payload` emits
    v2; v1 magic tolerated on decode path for one round.
  - `src/ui/src/FlameGraph.tsx` (~80 LoC) — `parseFlatBuffer`
    decodes v2 header, builds `names[]`, renders `events[i].name`
    as span label for API_CALL type.
  - `src/ui/src/FlameGraph.tsx` (~40 LoC) — delete 5 `N_LAYERS = 10`
    matches (lines 226, 242, 264, 265, 322); replace with
    `bucketByApiName(events)`; show `(synthetic)` toolbar badge
    when `names.length == 0`.
  - `src/ui/src/HardwareVisualizer.tsx` (~30 LoC) — update shared
    `parseFlatBuffer` at lines 251-260 to v2 decoder.
- Acceptance:
  - `rg "N_LAYERS" src/ui/src/FlameGraph.tsx` → 0.
  - `rg "version\s*=\s*2" src/core/src/trace.rs` ≥ 1.
  - `cargo test trace::flat_buffer_v2_roundtrip` green — 3
    API_CALL events preserve `api_name` across encode/decode.
  - `npx vite build` succeeds; API_CALL spans render `uca_*` label
    in the `dummy_trace.pccx` reload path.
  - `(synthetic)` badge visible when names table empty.
- Citations: research_findings.md
  **"Flat-buffer v2 + N_LAYERS = 10 retirement"** (FlatBuffers
  vtable evolution + `rkyv`).
- Owner: core + ui.
- Estimated diff size: M (~350 LoC net).

## Backlog (do not attempt this round)

- **Monaco editor migration (judge R-4 Top-5 #1)** — ~400 LoC on its
  own. Split into R-5 **T-4 (package.json + `<Editor>` mount, ~200)**
  + **T-5 (Monarch SV grammar + find widget, ~200)** so failures
  bisect cleanly.
- **Real "Run benchmark" end-to-end (judge R-4 Top-5 #5)** — nice UX
  win but low grade impact; revisit after T-2 so the benchmark can
  emit `TimingSummary` + `LiveSample` alongside the trace.
- **`LICENSE_SCOPE.md` / open-core boundary (Dim-10, 3 rounds stale)**
  — docs-only; schedule for R-5 standalone when code churn is low.
- **`src/core/src/hw_layout.rs` emitter (Dim-5 residual)** — ELK
  already dynamic; lifting `DIAGRAM_NODES` is cleanup, not grade.
- **Dim-2 ISA reg-file / pipe-stage trace (Spike/Whisper anchor)** —
  needs a separate research round on Whisper reg-file dump format
  before scoping.
