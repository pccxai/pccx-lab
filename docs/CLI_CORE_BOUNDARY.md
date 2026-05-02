# pccx-lab CLI/core boundary

This document defines the controlled boundary used by command-line,
desktop, editor-adjacent, CI, and future integration workflows.

## Principle

**CLI/core first. GUI second.**

The desktop shell is a thin surface over reusable core commands and
status contracts. GUI-visible workflow state should be reachable
through the same Rust core or CLI boundary that a headless consumer can
call. The GUI may render richer panels, but it must not become a
separate workflow logic island.

## Current boundary artifacts

| Artifact | Status | Notes |
|---|---|---|
| `pccx-lab status --format json` | available | Deterministic lab-status JSON from `pccx-core`. |
| `pccx-lab theme --format json` | experimental | Minimal semantic theme-token contract. |
| `pccx-lab analyze <file> --format json` | early scaffold | File-shape diagnostics only. |
| `lab_status` Tauri command | available | GUI reads the same core status struct. |
| `theme_contract` Tauri command | experimental | GUI reads the same core theme-token struct. |

No stable plugin ABI is promised. No MCP runtime is implemented. No
IDE or launcher runtime integration is implemented by this foundation.

## status command

```
pccx-lab status [--format json]
```

`status` emits a deterministic JSON object matching
[`docs/examples/run-status.example.json`](examples/run-status.example.json).
It is host-only and static by design: it does not scan the workspace,
load traces, probe hardware, call providers, launch editor bridges, or
run verification scripts.

Top-level fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | Status schema marker, currently `pccx.lab.status.v0`. |
| `labMode` | Current operating mode, currently `cli-first-gui-foundation`. |
| `workspaceState` | Host status with `traceLoaded: false` for this static boundary. |
| `availableWorkflows` | Reusable command or core boundaries visible to the GUI. |
| `pluginState` | Placeholder plugin state with `stableAbi: false`. |
| `guiState` | Minimal native-editor style surface metadata. |
| `diagnosticsState` | Current diagnostics command and scope. |
| `evidenceState` | Conservative evidence markers for hardware, timing, inference, and throughput. |
| `limitations` | Human-readable constraints carried with the status output. |

The GUI status panel renders this data through Tauri IPC. It does not
shell out to arbitrary commands and does not duplicate workflow logic.

## theme command

```
pccx-lab theme [--format json]
```

`theme` emits the early theme-neutral presentation layer contract in
[`docs/examples/theme-tokens.example.json`](examples/theme-tokens.example.json).
The contract is intentionally small:

- `background`
- `foreground`
- `mutedForeground`
- `border`
- `panelBackground`
- `accent`
- `danger`
- `warning`
- `success`

Current preset names are:

- `native-light`
- `native-dark`
- `compact-dark`
- `quiet-light`

These are semantic slots only. They are not a heavy design system and
do not promise a stable UI contract.

## analyze command

```
pccx-lab analyze <path> [--format json]
```

`analyze` emits a diagnostics envelope for a SystemVerilog file. It is
an early scaffold for host-side file-shape checks only.

| Check | Code | Severity |
|---|---|---|
| File missing or unreadable | `PCCX-IO-001` | error |
| File content is empty | `PCCX-SHAPE-001` | error |
| No `module` declaration found | `PCCX-SHAPE-002` | error |
| `module` present but `endmodule` missing | `PCCX-SCAFFOLD-003` | error |

It does not perform full semantic parsing, hardware verification,
provider calls, MCP calls, or GUI-only checks.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | No error-severity diagnostics |
| 1 | At least one error-severity diagnostic |
| 2 | I/O failure or unsupported CLI usage |

Fixtures for integration testing:

- `fixtures/ok_module.sv`
- `fixtures/missing_endmodule.sv`
- `fixtures/empty.sv`

## GUI foundation

The current GUI addition is only a compact verification dashboard panel
for status and theme metadata. It reads:

- `pccx_core::status::lab_status` through the `lab_status` Tauri command.
- `pccx_core::theme::theme_contract` through the `theme_contract` Tauri command.

The panel does not run FPGA flows, provider calls, MCP flows, IDE
bridges, launcher bridges, or arbitrary shell commands.

## Deferred work

| Area | Current position |
|---|---|
| Full GUI workflows | Deferred until reusable CLI/core commands exist. |
| Stable plugin ABI | Not promised. |
| MCP runtime | Not implemented in this foundation. |
| Editor or launcher runtime bridge | Not implemented in this foundation. |
| Hardware inference and throughput status | Not claimed by status output. |
| Timing-closure status | Not claimed by status output. |

The intended direction is a quiet engineering UI over CLI/core data,
not a separate workflow engine or a separate product surface.
