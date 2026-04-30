# pccx-lab

Pre-RTL bottleneck detection, UVM co-simulation, and LLM-driven testbench generation — purpose-built for the pccx NPU architecture.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Work_in_Progress-yellow.svg)]()
[![Rust](https://img.shields.io/badge/Rust-Language-orange.svg)]()
[![Tauri](https://img.shields.io/badge/Tauri-Framework-teal.svg)]()

## Full documentation
Documentation is available in both English and Korean:
- **English:** [https://pccxai.github.io/pccx/en/lab/](https://pccxai.github.io/pccx/en/lab/)
- **Korean:** [https://pccxai.github.io/pccx/ko/lab/](https://pccxai.github.io/pccx/ko/lab/)

## Why one repo, not five?
Read our [design rationale](https://pccxai.github.io/pccx/en/lab/design/rationale.html) on why we use a single monorepo to maintain strong module boundaries.

## Module layout
Phase 1 split the original monolithic `core` into nine focused crates under `crates/` plus a top-level `ui/`.  `pccx-core` is the single sink of the dependency graph; no crate depends on `pccx-ide` or `pccx-remote` (both are terminal binaries).

- `crates/core/` (`pccx-core`) — pure Rust core: `.pccx` format, trace parsing, hardware model, roofline, bottleneck, VCD / chrome-trace, Vivado timing.
- `crates/reports/` — Markdown / HTML / PDF rendering.
- `crates/verification/` — golden-diff + robust-reader gates for CI.
- `crates/authoring/` — ISA / API TOML compilers.
- `crates/evolve/` — EAGLE-family speculative-decoding primitives; future home of the Phase 5 DSE loop.
- `crates/lsp/` — Phase 2 IntelliSense façade (sync + async provider traits, multiplexers, subprocess spawner).
- `crates/remote/` — Phase 3 backend-daemon scaffold.
- `crates/uvm_bridge/` — SystemVerilog/UVM DPI-C boundary.
- `crates/ai_copilot/` — LLM invocation wrapper.
- `ui/src-tauri/` (`pccx-ide`) — Tauri shell consuming the core / reports / ai-copilot crates.
- `ui/` — React + Vite frontend; talks to `pccx-ide` via Tauri IPC.

See [docs/design/phase1_crate_split.md](docs/design/phase1_crate_split.md) for the full dependency graph and per-crate rationale.

## .pccx file format
Read the open specification for our [`.pccx` binary session format](https://pccxai.github.io/pccx/en/lab/pccx-format.html).

## Part of the pccx ecosystem
- [pccx (docs)](https://github.com/pccxai/pccx) — NPU architecture reference
- [pccx-FPGA-NPU-LLM-kv260 (RTL)](https://github.com/pccxai/pccx-FPGA-NPU-LLM-kv260) — RTL implementation
- [pccx-lab (this)](https://github.com/pccxai/pccx-lab) — Performance profiler & simulator

## License
Apache 2.0 License.
