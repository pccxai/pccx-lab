#!/usr/bin/env bash
# Quick environment diagnostic for pccx-lab.  Prints every tool version
# the project depends on, flags anything missing, and explains how to
# fix it.  Never modifies the system — read-only.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok()  { printf "  \033[1;32m✓\033[0m %-22s %s\n" "$1" "$2"; }
bad() { printf "  \033[1;31m✗\033[0m %-22s %s\n" "$1" "$2"; }
hint(){ printf "     \033[0;36m→\033[0m %s\n" "$1"; }

check() {
    local name="$1" cmd="$2" fix="$3"
    if command -v "$cmd" >/dev/null 2>&1; then
        local v
        v=$("$cmd" --version 2>&1 | head -n 1)
        ok "$name" "$v"
    else
        bad "$name" "not found"
        hint "$fix"
    fi
}

echo "pccx-lab environment doctor"
echo "---------------------------"
echo "Repo: $REPO_ROOT"
echo

echo "Toolchain:"
check "rustc"    rustc "bash scripts/setup_env.sh rust"
check "cargo"    cargo "bash scripts/setup_env.sh rust"
check "node"     node  "bash scripts/setup_env.sh node"
check "npm"      npm   "bash scripts/setup_env.sh node"
check "git"      git   "sudo apt-get install git"

echo
echo "Tauri 2 system libs (pkg-config):"
for pkg in gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0; do
    if pkg-config --exists "$pkg" 2>/dev/null; then
        ok "$pkg" "$(pkg-config --modversion "$pkg")"
    else
        bad "$pkg" "missing"
        hint "bash scripts/setup_env.sh system"
    fi
done

echo
echo "Workspace:"
[[ -d "$REPO_ROOT/src/ui/node_modules" ]]      && ok "src/ui/node_modules"      "present" || { bad "src/ui/node_modules" "missing"; hint "bash scripts/setup_env.sh install"; }
[[ -f "$REPO_ROOT/src/ui/src-tauri/Cargo.lock" ]] && ok "Cargo.lock (tauri)"    "present" || bad "Cargo.lock (tauri)" "missing"

# Is the dev server already up?
if curl -sf http://localhost:1420/ >/dev/null 2>&1; then
    ok "vite :1420" "running"
else
    ok "vite :1420" "free (ok)"
fi

echo
echo "Next steps:"
echo "  Launch dev window:   bash scripts/run_dev.sh"
echo "  Re-install deps:     bash scripts/setup_env.sh install"
echo "  Full type-check:     (cd src/ui && npx tsc --noEmit)"
echo "  Rust tests:          (cd src/core && cargo test)"
