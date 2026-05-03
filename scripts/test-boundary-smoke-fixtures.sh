#!/usr/bin/env bash
# Run deterministic fixture checks for the CLI/core boundary smoke script.
# Fixtures are staged under a temporary root so production validation still
# scans the real repository by default.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_SCRIPT="$REPO_ROOT/scripts/pccx-lab-boundary-smoke.sh"
FIXTURE_ROOT="$REPO_ROOT/scripts/fixtures/boundary-smoke"
BASE_FIXTURE="$FIXTURE_ROOT/base"
CASE_ROOT="$FIXTURE_ROOT/cases"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

PASS() { printf '[PASS]  %s\n' "$*"; }
FAIL() { printf '[FAIL]  %s\n' "$*" >&2; }

FAILURES=0

stage_fixture() {
    local slug="$1"
    local root="$WORK_DIR/$slug"
    local case_dir="$CASE_ROOT/$slug"
    local overlay_dir="$case_dir/overlay"
    local remove_file="$case_dir/remove.txt"

    mkdir -p "$root"
    cp -R "$BASE_FIXTURE/." "$root"

    if [ -d "$overlay_dir" ]; then
        cp -R "$overlay_dir/." "$root"
    fi

    if [ -f "$remove_file" ]; then
        while IFS= read -r relative_path || [ -n "$relative_path" ]; do
            case "$relative_path" in
                ''|\#*) continue ;;
                /*|*..*)
                    FAIL "$slug remove.txt contains unsafe path: $relative_path"
                    FAILURES=$((FAILURES + 1))
                    continue
                    ;;
            esac
            rm -rf "$root/$relative_path"
        done < "$remove_file"
    fi

    printf '%s\n' "$root"
}

run_case() {
    local name="$1"
    local fixture_root="$2"
    local expected="$3"
    shift 3
    local output_file="$WORK_DIR/${name//[^a-zA-Z0-9]/_}.out"
    local status=0
    local output

    set +e
    "$SMOKE_SCRIPT" --root "$fixture_root" >"$output_file" 2>&1
    status=$?
    set -e

    output="$(cat "$output_file")"

    case "$expected:$status" in
        pass:0)
            ;;
        pass:*)
            FAIL "$name: expected pass, got exit $status"
            printf '%s\n' "$output" >&2
            FAILURES=$((FAILURES + 1))
            return
            ;;
        fail:0)
            FAIL "$name: expected failure, got pass"
            printf '%s\n' "$output" >&2
            FAILURES=$((FAILURES + 1))
            return
            ;;
        fail:*)
            ;;
        *)
            FAIL "$name: internal test error for expected=$expected status=$status"
            FAILURES=$((FAILURES + 1))
            return
            ;;
    esac

    local snippet
    for snippet in "$@"; do
        if ! grep -Fq "$snippet" "$output_file"; then
            FAIL "$name: missing output snippet: $snippet"
            printf '%s\n' "$output" >&2
            FAILURES=$((FAILURES + 1))
            return
        fi
    done

    PASS "$name"
}

INFO() { printf '[INFO]  %s\n' "$*"; }

INFO "boundary smoke fixture tests"
INFO "fixture base: $BASE_FIXTURE"

positive_root="$(stage_fixture positive)"
malformed_json_root="$(stage_fixture malformed-json)"
missing_required_example_root="$(stage_fixture missing-required-example)"

run_case \
    "positive minimal boundary fixture" \
    "$positive_root" \
    pass \
    "boundary smoke: all checks passed" \
    "docs/examples/workflow-descriptors.example.json"

run_case \
    "malformed JSON boundary fixture" \
    "$malformed_json_root" \
    fail \
    "JSON validity" \
    "invalid JSON:" \
    "docs/examples/workflow-descriptors.example.json" \
    "JSONDecodeError"

run_case \
    "missing required boundary example fixture" \
    "$missing_required_example_root" \
    fail \
    "docs presence" \
    "missing:" \
    "docs/examples/workflow-results.example.json"

if [ "$FAILURES" -eq 0 ]; then
    INFO "boundary smoke fixture tests passed"
    exit 0
else
    FAIL "boundary smoke fixture tests: $FAILURES failure(s)"
    exit 1
fi
