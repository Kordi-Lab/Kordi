# GitHub Collaboration Readiness

Last reviewed: 2026-04-20

This document tracks the current repository cleanup status before pushing Kordi to a shared GitHub repository.

## What was cleaned

### Sensitive or personal local details removed

The following publish blockers were removed or generalized:

- personal absolute local filesystem paths
- a hard-coded local import path in `agent/scripts/test-pi-token-parity.mjs`
- personal sample identity values in `app/desktop/src/kordi-app/data.tsx`
- desktop package metadata author name in `app/desktop/src-tauri/Cargo.toml`
- desktop bundle identifier changed from a personal namespace to `io.kordi.desktop`

### Temporary local artifacts blocked from Git

Added to `.gitignore`:

- `tmp-chrome-profile.*`

Also removed local temp browser-profile directories from the working tree before collaboration upload.

## Security scan summary

A basic repository scan was run for common secret patterns, including:

- OpenAI-style keys
- GitHub tokens
- Slack tokens
- private key headers
- database connection strings

Result:

- no live secret-like values were found in tracked source files
- remaining hits were test fixtures or generated local temp-browser artifacts that were removed or ignored

## Hard-coded path audit

Current result:

- no personal absolute filesystem paths remain in normal source/docs/scripts
- remaining absolute paths are generic test fixtures in `bridges/cli/src/commands.rs` using `/home/tester`

## Remaining cleanup backlog

The repo is much safer to publish now, but if you want to enforce a strict "no overlong source files" standard, these files still need follow-up refactors.

### Source files still over 1000 lines

- `bridges/cli/src/commands.rs` — 2661
- `bridges/cli/src/local_api.rs` — 1752
- `agent/crates/cli/src/login/store.rs` — 1216
- `agent/crates/cli/src/extensions/tests.rs` — 1052
- `agent/crates/cli/src/turn_runner/tests.rs` — 1027
- `agent/crates/kordi-monitor/src/request_metrics/tracker.rs` — 1001

### Recommended next refactor targets

1. Split backend monoliths
   - `bridges/cli/src/commands.rs`
   - `bridges/cli/src/local_api.rs`
   - `agent/crates/cli/src/login/store.rs`

2. Review long test/support files
   - `agent/crates/cli/src/extensions/tests.rs`
   - `agent/crates/cli/src/turn_runner/tests.rs`
   - `agent/crates/kordi-monitor/src/request_metrics/tracker.rs`

## Metadata still needing final decision before first public push

These are not sensitive, but should be reviewed so the public repo metadata is correct:

- root Rust workspace `repository` / `homepage` values in `Cargo.toml`
- package/repository metadata inside inherited upstream `agent` and `bridges` packages
- whether `.impeccable.md` should be committed for collaborators or kept local

## Pre-push checklist

Before the first collaboration upload:

- [ ] review `git status --short`
- [ ] confirm no local `.env` files are staged
- [ ] run `pnpm lint`
- [ ] run `pnpm check:rust`
- [ ] run desktop build/check paths:
  - [ ] `cd app/desktop && npm run build`
  - [ ] `cd app/desktop/src-tauri && cargo check`
- [ ] verify the final GitHub repository URL and update package metadata accordingly
- [ ] decide whether large refactor backlog is acceptable before opening collaboration

## Recommended collaboration baseline

If you want the repo to feel clean for outside collaborators, the minimum good baseline is:

- no personal paths
- no local temp artifacts
- no real secrets
- neutral app/package metadata
- a short contributor-facing checklist in docs

That baseline is now largely in place.
