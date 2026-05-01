# pccx-lab CLI/core boundary

This document defines the controlled boundary through which external
consumers — editors, launchers, CI pipelines, and future integration
layers — interact with pccx-lab.

## Principle

**CLI/core first. GUI second.**

The Tauri shell and any future editor extensions are built on top of
the CLI/core boundary, not alongside it. There is no private back
channel from any integration layer into pccx-lab internals.

This means:

- The same `analyze`, `status`, and `traces` paths that the GUI uses
  are exactly the paths that `systemverilog-ide` and `pccx-llm-launcher`
  will consume.
- AI workers can interact with pccx-lab through a controlled MCP
  interface (planned). They do not get a separate internal surface.
- The GUI may expose richer visualisation, but any state it reads must
  be reachable through the documented CLI boundary.

## Consumers

| Consumer | Integration path | Status |
|---|---|---|
| `systemverilog-ide` | `pccx-lab analyze <file>` → diagnostics envelope | planned |
| `pccx-llm-launcher` | `pccx-lab status` → run-status envelope | planned |
| VS Code extension | same CLI boundary; no separate IPC | planned |
| JetBrains / other IDE bridge | same CLI boundary | planned |
| MCP interface | controlled MCP tool server wrapping CLI boundary | planned |
| Plugin workflows | extension registry via `pccx-ai-copilot` | planned |
| CI / headless verification | `pccx-lab` subcommands, non-interactive | planned |

## In-tree boundary artifacts

Two in-tree artifacts already anchor the future boundary shape:

- **`crates/lsp/src/sv_diagnostics.rs`** — internal SV diagnostics
  provider. When the `pccx-lab analyze` CLI path is wired up, its
  output will be serialised to the diagnostics envelope defined by
  [`pccxai/systemverilog-ide`'s `schema/diagnostics-v0.json`][sv-schema].
  The envelope fields (`envelope`, `tool`, `source`, `diagnostics[]`)
  are the controlled surface; internal `SvDiagnosticsProvider`
  mechanics are not exposed.

- **`crates/remote/openapi.yaml`** — Phase 3 daemon scaffold. The
  `/v1/traces`, `/v1/sessions`, and `/v1/reports/{id}` paths sketch
  the run-status and trace-discovery contracts. No endpoint is wired
  yet; the file documents the intended surface.

[sv-schema]: https://github.com/pccxai/systemverilog-ide/blob/main/schema/diagnostics-v0.json

## Near-term contracts (planned)

The following contracts are expected to solidify before `v0.2.0`:

### Diagnostics envelope (systemverilog-ide integration target)

Path: `pccx-lab analyze <file.sv>` → stdout JSON  
Shape: `pccxai/systemverilog-ide schema/diagnostics-v0.json`  
See: [`docs/examples/diagnostics-envelope.example.json`](examples/diagnostics-envelope.example.json)

Resolution precedence (mirrors systemverilog-ide's `PCCX_LAB_BIN`
convention):

1. `PCCX_LAB_BIN` environment variable (absolute path).
2. `pccx-lab` on `$PATH`.
3. Hard error — no silent fallback to a stub when the binary is expected.

### Run-status envelope (pccx-llm-launcher integration target)

Path: `pccx-lab status` → stdout JSON  
Shape: matches `pccx-schema::HealthStatus` plus launcher state fields  
See: [`docs/examples/run-status.example.json`](examples/run-status.example.json)

### Trace-report discovery (CI / headless path)

Path: `pccx-lab traces [--format json]` → trace list  
Consumed by CI to surface `.pccx` artefacts after xsim runs.

### xsim log handoff (pccx-FPGA verification loop)

Path: `pccx-from-xsim-log --log <xsim.log> --output <out.pccx>`  
Already wired. Converts xsim stdout to a `.pccx` trace the lab can load.  
Next: surface the resulting diagnostics through `pccx-lab analyze`.

## Deferred contracts

The following are intentionally out of scope until core contracts mature:

| Contract | Notes |
|---|---|
| Stable plugin ABI | No stable plugin ABI is claimed today. Extensions use `pccx-ai-copilot` which is explicitly pre-v0.3 unstable. |
| MCP tool server | Planned. AI-assisted SystemVerilog development workflow gated on CLI boundary stability. |
| GUI visualisation layer | Tauri shell consumes the same CLI boundary. No separate internal surface. |
| AI-assisted generate / simulate / evaluate / refine loop | Planned evolutionary loop. Gated on xsim + timing evidence from `pccx-FPGA-NPU-LLM-kv260`. |

## Non-goals

- No stable plugin ABI claim today.
- No production-ready tooling claim.
- No autonomous hardware design claim.
- No vendor-specific AI worker control wording.

Public wording to use:

> "AI workers can interact with pccx-lab through a controlled MCP interface."

> "AI-assisted SystemVerilog development workflow."

> "Evolutionary generate / simulate / evaluate / refine loop."

Avoid these phrases — they are not accurate for this project at this stage:

- "Claude can directly control pccx-lab" — not accurate; AI workers interact through a controlled interface.
- "production-ready" is not accurate; use "pre-alpha" or "development preview" instead.
- "stable plugin ABI" is not stable today; use "unstable, pre-v0.3" instead.
- "timing-closed" is not yet achieved; use "timing closure pending verified bring-up".
- "KV260 inference works" is not yet verified; use "KV260 path pending verified bring-up".
