#!/usr/bin/env bash
# Launch pccx-lab in dev mode with proper env sourcing.
#
# Why not just `npm run tauri dev`?  Because cargo / nvm are shell-local:
# an AI agent spawning a fresh `bash -c` does not inherit them.  This
# wrapper explicitly sources both, then hands off.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$REPO_ROOT/src/ui"

# Cargo
[[ -s "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

# nvm (optional — only if user installed it; system node is also fine)
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
fi

command -v cargo >/dev/null || { echo "cargo missing — run: bash scripts/setup_env.sh rust" >&2; exit 1; }
command -v npm   >/dev/null || { echo "npm missing   — run: bash scripts/setup_env.sh node" >&2; exit 1; }

cd "$UI_DIR"
[[ -d node_modules ]] || npm install --no-audit --no-fund

# If the vite dev port is already up (another agent / tab), just open vite,
# otherwise do the full tauri dev (which will boot both vite and the wry
# window).
if curl -sf http://localhost:1420/ >/dev/null 2>&1; then
    echo "[run_dev] vite already on :1420 — leaving it alone."
    exit 0
fi

exec npm run tauri dev
