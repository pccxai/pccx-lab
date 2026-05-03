#!/usr/bin/env bash
# scripts/pccx-lab-boundary-smoke.sh — verify key CLI/core boundary artifacts.
# Does not build the project. Does not run xsim. Does not require hardware.
# Exits 0 on success; exits 1 with diagnostics if an artifact is missing
# or malformed.

set -u

DEFAULT_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$DEFAULT_REPO_ROOT"

INFO() { printf '[INFO]  %s\n' "$*"; }
PASS() { printf '[PASS]  %s\n' "$*"; }
FAIL() { printf '[FAIL]  %s\n' "$*" >&2; }

usage() {
    cat <<'USAGE'
Usage: scripts/pccx-lab-boundary-smoke.sh [--root <repo-root>]

Without --root, checks the real pccx-lab repo. The explicit --root option is
for deterministic fixture tests; it does not run providers, hardware, browsers,
launchers, IDE integrations, or networked services.
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --root)
            if [ "$#" -lt 2 ]; then
                FAIL "missing path after --root"
                usage >&2
                exit 2
            fi
            if ! REPO_ROOT="$(cd "$2" 2>/dev/null && pwd)"; then
                FAIL "invalid --root path: $2"
                exit 2
            fi
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            FAIL "unknown argument: $1"
            usage >&2
            exit 2
            ;;
    esac
done

FAILURES=0

check_file() {
    if [ -f "$1" ]; then
        PASS "$1"
    else
        FAIL "missing: $1"
        FAILURES=$((FAILURES + 1))
    fi
}

INFO "pccx-lab CLI/core boundary smoke"
INFO "repo: $REPO_ROOT"

echo
INFO "planned boundary contracts:"
INFO "  diagnostics-envelope  (systemverilog-ide integration target)"
INFO "  lab-status-envelope   (CLI/core and GUI status surface)"
INFO "  theme-token-envelope  (theme-neutral presentation layer)"
INFO "  workflow-descriptors  (descriptor-only workflow catalog)"
INFO "  workflow-proposals    (proposal-only workflow previews)"
INFO "  workflow-results      (summary-only result metadata)"
INFO "  workflow-runner       (disabled-by-default allowlisted pilot)"
INFO "  trace-discovery       (headless CI path)"
INFO "  xsim-log-handoff      (pccx-FPGA verification loop)"

echo
INFO "docs presence"
check_file "$REPO_ROOT/docs/CLI_CORE_BOUNDARY.md"
check_file "$REPO_ROOT/docs/examples/diagnostics-envelope.example.json"
check_file "$REPO_ROOT/docs/examples/run-status.example.json"
check_file "$REPO_ROOT/docs/examples/theme-tokens.example.json"
check_file "$REPO_ROOT/docs/examples/workflow-descriptors.example.json"
check_file "$REPO_ROOT/docs/examples/workflow-proposals.example.json"
check_file "$REPO_ROOT/docs/examples/workflow-results.example.json"
check_file "$REPO_ROOT/docs/examples/workflow-runner-blocked.example.json"

echo
INFO "CLI command source presence"
check_file "$REPO_ROOT/crates/core/src/bin/pccx_lab.rs"
check_file "$REPO_ROOT/crates/core/src/status.rs"
check_file "$REPO_ROOT/crates/core/src/theme.rs"
check_file "$REPO_ROOT/crates/core/src/workflows.rs"
check_file "$REPO_ROOT/crates/core/src/proposals.rs"
check_file "$REPO_ROOT/crates/core/src/results.rs"
check_file "$REPO_ROOT/crates/core/src/runner.rs"

echo
INFO "fixture presence"
check_file "$REPO_ROOT/fixtures/ok_module.sv"
check_file "$REPO_ROOT/fixtures/missing_endmodule.sv"
check_file "$REPO_ROOT/fixtures/empty.sv"

echo
INFO "JSON validity"
for f in "$REPO_ROOT/docs/examples/"*.example.json; do
    [ -f "$f" ] || continue
    if json_error="$(
        python3 - "$f" <<'PY' 2>&1
import json
import sys

path = sys.argv[1]

try:
    with open(path, encoding="utf-8") as handle:
        json.load(handle)
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
    )"; then
        PASS "valid JSON: $f"
    else
        FAIL "invalid JSON: $f: $json_error"
        FAILURES=$((FAILURES + 1))
    fi
done

echo
if [ "$FAILURES" -eq 0 ]; then
    INFO "boundary smoke: all checks passed"
    exit 0
else
    FAIL "boundary smoke: $FAILURES check(s) failed"
    exit 1
fi
