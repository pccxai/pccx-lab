#!/usr/bin/env bash
# scripts/pccx-lab-boundary-smoke.sh — verify key CLI/core boundary artifacts.
# Does not build the project. Does not run xsim. Does not require hardware.
# Exits 0 on success; exits 1 with diagnostics if an artifact is missing
# or malformed.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INFO() { printf '[INFO]  %s\n' "$*"; }
PASS() { printf '[PASS]  %s\n' "$*"; }
FAIL() { printf '[FAIL]  %s\n' "$*" >&2; }

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
check_file "$REPO_ROOT/docs/examples/workflow-runner-blocked.example.json"

echo
INFO "CLI command source presence"
check_file "$REPO_ROOT/crates/core/src/bin/pccx_lab.rs"
check_file "$REPO_ROOT/crates/core/src/status.rs"
check_file "$REPO_ROOT/crates/core/src/theme.rs"
check_file "$REPO_ROOT/crates/core/src/workflows.rs"
check_file "$REPO_ROOT/crates/core/src/proposals.rs"
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
    if python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
        PASS "valid JSON: $(basename "$f")"
    else
        FAIL "invalid JSON: $(basename "$f")"
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
