#!/usr/bin/env bash
# pccx-lab environment bootstrap.
#
# Brings a fresh Ubuntu / Debian machine to the point where `npm run tauri dev`
# in src/ui/ launches the profiler.  Idempotent: re-running skips anything
# already installed.  Every step prints what it is doing so an AI agent
# driving this script can see exactly where it stopped.
#
# Usage:
#   bash scripts/setup_env.sh            # run everything
#   bash scripts/setup_env.sh system     # apt deps only
#   bash scripts/setup_env.sh rust       # rustup + cargo only
#   bash scripts/setup_env.sh node       # nvm + node 20 LTS only
#   bash scripts/setup_env.sh install    # npm install + cargo fetch only
#   bash scripts/setup_env.sh verify     # print versions + smoke build
#
# Exit codes: 0 success, non-zero = the first failing step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$REPO_ROOT/src/ui"
TAURI_DIR="$UI_DIR/src-tauri"

log()  { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m  %s\n" "$*"; }
die()  { printf "\033[1;31m[fail]\033[0m  %s\n" "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ─── 1. OS + architecture check ─────────────────────────────────────

check_os() {
    log "Checking OS + architecture"
    [[ "$(uname -s)" == "Linux" ]] || die "Only Linux is supported by this script (detected $(uname -s))."
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        log "  -> $PRETTY_NAME ($(uname -m))"
        case "$ID" in
            ubuntu|debian|linuxmint|pop) : ;;
            *) warn "Untested distro '$ID' — apt commands may need adjustment.";;
        esac
    fi
}

# ─── 2. System packages for Tauri 2 on Linux ────────────────────────

install_system_deps() {
    log "Installing Tauri 2 system dependencies via apt"
    local pkgs=(
        build-essential
        curl
        wget
        file
        pkg-config
        libssl-dev
        libgtk-3-dev
        libwebkit2gtk-4.1-dev
        libayatana-appindicator3-dev
        librsvg2-dev
        libsoup-3.0-dev
        libjavascriptcoregtk-4.1-dev
        xdg-utils
        git
    )
    local missing=()
    for p in "${pkgs[@]}"; do
        dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
        log "  -> all present, nothing to install"
        return 0
    fi
    log "  -> installing: ${missing[*]}"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

# ─── 3. Rust toolchain via rustup ───────────────────────────────────

install_rust() {
    log "Installing Rust toolchain"
    if need_cmd rustc && need_cmd cargo; then
        log "  -> already installed: $(rustc --version)"
    else
        log "  -> fetching rustup bootstrapper"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
        # shellcheck source=/dev/null
        source "$HOME/.cargo/env"
    fi
    rustup component add clippy rustfmt >/dev/null 2>&1 || true
    log "  -> $(rustc --version), $(cargo --version)"
}

# ─── 4. Node 20 LTS via nvm ─────────────────────────────────────────

install_node() {
    log "Installing Node.js (20 LTS)"
    local want_major=20
    if need_cmd node; then
        local cur
        cur=$(node --version | sed 's/^v//' | cut -d. -f1)
        if [[ "$cur" -ge "$want_major" ]]; then
            log "  -> already $(node --version) (satisfies >= $want_major)"
            return 0
        fi
        warn "  -> node $(node --version) is older than v$want_major, installing nvm + $want_major"
    fi
    export NVM_DIR="$HOME/.nvm"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        log "  -> fetching nvm"
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm install "$want_major"
    nvm use "$want_major" >/dev/null
    nvm alias default "$want_major" >/dev/null
    log "  -> $(node --version), npm $(npm --version)"
}

# ─── 5. Workspace dependencies ──────────────────────────────────────

install_workspace() {
    log "Installing workspace dependencies"
    [[ -d "$UI_DIR" ]]    || die "UI dir not found: $UI_DIR"
    [[ -d "$TAURI_DIR" ]] || die "Tauri dir not found: $TAURI_DIR"

    log "  -> npm install in $UI_DIR"
    (cd "$UI_DIR" && npm install --no-audit --no-fund)

    log "  -> cargo fetch in $TAURI_DIR"
    (cd "$TAURI_DIR" && cargo fetch --locked 2>/dev/null || cargo fetch)

    log "  -> cargo fetch for root workspace"
    (cd "$REPO_ROOT" && cargo fetch 2>/dev/null || true)
}

# ─── 6. Verify — smoke build ────────────────────────────────────────

verify() {
    log "Verifying environment"
    need_cmd rustc || die "rustc missing"
    need_cmd cargo || die "cargo missing"
    need_cmd node  || die "node missing"
    need_cmd npm   || die "npm missing"
    log "  rustc    $(rustc --version)"
    log "  cargo    $(cargo --version)"
    log "  node     $(node --version)"
    log "  npm      $(npm --version)"
    pkg-config --modversion webkit2gtk-4.1 >/dev/null 2>&1 \
        && log "  webkit2gtk-4.1  $(pkg-config --modversion webkit2gtk-4.1)" \
        || warn "  webkit2gtk-4.1 dev headers missing — 'bash setup_env.sh system' first"

    log "Type-checking TypeScript (src/ui)"
    (cd "$UI_DIR" && npx --yes tsc --noEmit)

    log "Cargo check (src/ui/src-tauri)"
    (cd "$TAURI_DIR" && cargo check --locked 2>/dev/null || cargo check)

    log "All checks passed."
}

# ─── Dispatcher ─────────────────────────────────────────────────────

cmd="${1:-all}"
case "$cmd" in
    all)     check_os; install_system_deps; install_rust; install_node; install_workspace; verify ;;
    system)  check_os; install_system_deps ;;
    rust)    install_rust ;;
    node)    install_node ;;
    install) install_workspace ;;
    verify)  verify ;;
    *) die "Unknown subcommand '$cmd'. Valid: all | system | rust | node | install | verify" ;;
esac
