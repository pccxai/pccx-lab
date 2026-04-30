# Releasing pccx-lab

Phase 1 M1.4 — versioning + changelog discipline for the 9-crate
workspace.

## Workspace inheritance

All crates inherit `version`, `edition`, `authors`, `repository`,
`license`, and `rust-version` from the workspace root's
`[workspace.package]`.  Bumping the root `version` is the single edit
a release needs.

```toml
# /Cargo.toml
[workspace.package]
version = "0.2.0"   # <-- bump here only
```

Each member's `Cargo.toml` already reads
`version.workspace = true`, so every published crate gets the same
semver.

## Per-crate CHANGELOG.md

Every member ships a `CHANGELOG.md` following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + SemVer.
When landing a PR that changes a crate's public surface, add an entry
under `## [Unreleased]` in **that crate's** CHANGELOG — do not touch
unrelated crates.

SEMVER NOTE: pre-1.0 (0.x.y), minor bumps may carry breaking changes.
Downstreams that want a quiet upgrade pin to `=0.x`.

## Release flow (manual, pre-automation)

1. **Gather changes** — walk each crate's `CHANGELOG.md`.  If
   `[Unreleased]` is empty for a crate, its version still bumps (the
   workspace inherits uniformly) but no entry is required.
2. **Bump `[workspace.package].version`** in the root `Cargo.toml`.
3. **Cut each `[Unreleased]` section** to a new `## [X.Y.Z] - YYYY-MM-DD`
   heading.  Insert a fresh empty `[Unreleased]` above it.
4. **Commit** as `chore(release): vX.Y.Z`.
5. **Tag** with `vX.Y.Z` at the repo root (not per-crate tags).
6. **Publish** (if pushing to crates.io): run `cargo publish -p <name>`
   in dependency order — pccx-core first, then pccx-reports /
   pccx-verification / pccx-authoring / pccx-evolve / pccx-uvm-bridge
   / pccx-ai-copilot, then pccx-remote / pccx-ide.  `pccx-ide` depends
   on every runtime crate so it publishes last.

## Planned automation (Phase 1 M1.4 follow-up)

- **`cargo-release`** — `cargo install cargo-release` then
  `cargo release patch --workspace` walks the tree, bumps, tags,
  publishes atomically.  Add `release.toml` at the repo root with
  `shared-version = true` and `consolidate-commits = true` so the
  tree moves in one commit.
- **release-please GitHub Action** (alternative) — parses
  conventional-commit messages on `main`, opens a release PR that
  stages the bump + CHANGELOG cuts, merges atomically.  Needs a
  `.release-please-manifest.json` listing every crate path.

Pick one (not both) during Phase 1 closure.  `cargo-release` is
lower-friction for a single-maintainer repo; `release-please` wins
once external contributors land PRs regularly.

## Do NOT

- Bump a single crate's version in its own `Cargo.toml` — breaks
  workspace inheritance.
- Push tags that name a single crate (`pccx-reports-v0.2.0`).  Tag the
  workspace (`v0.2.0`) and let Cargo resolve per-crate versions from
  the inherited value.
- Edit another crate's CHANGELOG in the same PR that changes your
  crate.  Each CHANGELOG belongs to its crate only.

## Pre-release tags (alpha / beta / rc)

The first public tag is planned as `v0.1.0-alpha` — a tooling
snapshot covering the trace / report infrastructure, the early
profiler crates, and the Tauri GUI scaffold.  It is not a stable
release.

- `-alpha`: early surface; breaking changes expected at any minor.
- `-beta`:  surface frozen but documentation / packaging gaps remain.
- `-rc`:    release candidate; only blocking bugs delay the matching
            stable tag.

Always pass `--prerelease` to `gh release create` for these tags.

## Citation metadata

Each tag must keep `CITATION.cff` consistent with the released
authors and metadata.  The canonical project citation lives in
[`pccx/CITATION.cff`](https://github.com/pccxai/pccx/blob/main/CITATION.cff);
this repo's `CITATION.cff` references that canonical entry under
`references:` so external citations land on the architecture, not
the tooling.

When a `[X.Y.Z]` cut goes in:

- Bump the `version:` field in `CITATION.cff` if you track it
  explicitly.
- Update `date-released:` to the tag date.

## See also

- [`pccx-FPGA-NPU-LLM-kv260` `RELEASING.md`](https://github.com/pccxai/pccx-FPGA-NPU-LLM-kv260/blob/main/RELEASING.md)
  — sibling RTL repo.  Implementation snapshots are versioned
  independently from this tooling repo.
- [`pccx` `RELEASING.md`](https://github.com/pccxai/pccx/blob/main/RELEASING.md)
  — canonical architecture / spec release flow.
