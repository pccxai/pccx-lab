# pccx-lab

Pre-RTL bottleneck detection, UVM co-simulation, and LLM-driven testbench generation — purpose-built for the pccx NPU architecture.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Work_in_Progress-yellow.svg)]()
[![Rust](https://img.shields.io/badge/Rust-Language-orange.svg)]()
[![Tauri](https://img.shields.io/badge/Tauri-Framework-teal.svg)]()

## Project status

**Public alpha** — `v0.1.0-alpha` is published as a prerelease. Core
crates and the Tauri shell are in active development; APIs and `.pccx`
schema may shift before `v0.2.0`. Feedback and issues are welcome.

| Entry point | Link |
| --- | --- |
| Documentation | <https://pccxai.github.io/pccx/en/lab/> |
| Releases | <https://github.com/pccxai/pccx-lab/releases> |
| `v0.1.0-alpha` notes | [docs/releases/v0.1.0-alpha.md](docs/releases/v0.1.0-alpha.md) |
| Roadmap (project board) | <https://github.com/orgs/pccxai/projects/1> |
| Contributing | <https://github.com/pccxai/.github/blob/main/CONTRIBUTING.md> |
| How to cite | [CITATION.cff](CITATION.cff) |
| Tooling status | `rust-check` + `frontend-check` required on `main`; `cargo fmt --check` enforced |
| Discussions | <https://github.com/pccxai/pccx-lab/discussions> |
| Good first issues | <https://github.com/pccxai/pccx-lab/labels/good%20first%20issue> |

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

## How others consume pccx-lab

pccx-lab is CLI-first. GUI, editor-adjacent, launcher-adjacent, and
future plugin-facing workflows sit on top of the same controlled
boundary. There is no private back channel into lab internals. See
[docs/CLI_CORE_BOUNDARY.md](docs/CLI_CORE_BOUNDARY.md).

- `pccx-lab status --format json` returns deterministic lab status for
  headless tools and the GUI status panel.
- `pccx-lab theme --format json` returns the early theme-token contract
  for a theme-neutral presentation layer.
- `pccx-lab workflows --format json` returns descriptor-only workflow
  metadata for GUI, CI/headless, and future tool consumers.
- `pccx-lab analyze <file> --format json` returns file-shape diagnostics
  through the reusable CLI/core boundary.

The GUI is a CLI-backed GUI surface, not a separate logic island. Theme
work is experimental. Workflow descriptors do not execute anything. No
stable plugin ABI is promised. No MCP runtime, provider runtime,
launcher runtime, or editor runtime integration is implemented by this
foundation.

## Part of the pccx ecosystem
- [pccx (docs)](https://github.com/pccxai/pccx) — NPU architecture reference
- [pccx-FPGA-NPU-LLM-kv260 (RTL)](https://github.com/pccxai/pccx-FPGA-NPU-LLM-kv260) — RTL implementation
- [pccx-lab (this)](https://github.com/pccxai/pccx-lab) — Performance profiler & simulator

## License
Apache 2.0 License.
