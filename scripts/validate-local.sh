#!/usr/bin/env bash
# scripts/validate-local.sh - run the review gate used for local PR readiness.
# This is a thin command wrapper only; it does not replace CI and does not
# install system packages.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() {
    printf '\n[validate] %s\n' "$*"
    "$@"
}

run_in_ui() {
    (
        cd "$REPO_ROOT/ui"
        run "$@"
    )
}

printf '[validate] repo: %s\n' "$REPO_ROOT"

run git -C "$REPO_ROOT" diff --check
run cargo fmt --all -- --check
run cargo check --workspace --all-targets
run cargo test --workspace

if [ "${PCCX_SKIP_NPM_CI:-0}" = "1" ]; then
    printf '\n[validate] skipping npm ci because PCCX_SKIP_NPM_CI=1\n'
else
    run_in_ui npm ci
fi
run_in_ui npm run test:static
run_in_ui npx tsc --noEmit
run_in_ui npm run build

run "$REPO_ROOT/scripts/pccx-lab-boundary-smoke.sh"
run "$REPO_ROOT/scripts/test-boundary-smoke-fixtures.sh"
run cargo test -p pccx-core --test public_claim_guards

printf '\n[validate] all local checks passed\n'
