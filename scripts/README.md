# pccx-lab scripts

Small shell helpers for bootstrapping a fresh machine (human *or* AI agent)
to the point where `npm run tauri dev` works.

## Files

| Script           | Purpose                                                         |
| ---------------- | --------------------------------------------------------------- |
| `setup_env.sh`   | Install apt deps, Rust, Node 20, and fetch workspace deps.      |
| `run_dev.sh`     | Launch the Tauri dev window with cargo+nvm pre-sourced.         |
| `doctor.sh`      | Read-only environment diagnostic.  Prints versions + fixes.     |

## Typical flows

**Fresh machine:**

```bash
bash scripts/setup_env.sh       # installs everything
bash scripts/run_dev.sh         # opens the profiler window
```

**"Did my install actually work?"**

```bash
bash scripts/doctor.sh
```

**Partial re-run** (e.g., apt deps are fine but node_modules got wiped):

```bash
bash scripts/setup_env.sh install
```

## For AI agents

- All scripts exit non-zero on first error (`set -euo pipefail`), so an agent
  can detect failure by exit code alone.
- All steps are **idempotent** — re-running `setup_env.sh` on an already-set
  machine is a no-op.
- `doctor.sh` prints, for each missing dependency, the exact remediation
  command — use it to decide the next action programmatically.
