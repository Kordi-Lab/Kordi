# Bridges Public Beta Plan

This repository should support two parallel tracks:

## 1. Private development repo

Purpose:
- core UI and platform development
- hosted-product work
- experimental features
- internal deployment config
- internal notes, ops, and roadmap

Recommended branches:
- `main` — internal source of truth
- `dev/ui` — UI iteration
- `dev/platform` — platform and infra work
- `release/public-beta` — staging branch for the next public export

## 2. Public self-host beta repo

Purpose:
- local/self-host testing by beta groups
- published npm package and GitHub releases
- portable setup docs
- Bridges skill installation for agent runtimes
- reproducible validation and release flow for the core network component

Recommended branches:
- `main` — latest public beta-ready state
- `next` — optional preview branch for upcoming beta cuts

## Why split repos instead of one public/private branch set

A separate public repo is safer because it:
- avoids exposing old internal history by accident
- keeps public messaging focused on self-hosted usage
- allows private hosted/deployment work to continue independently
- makes release review much easier

## Recommended public beta scope

Keep in the public repo:
- `cli/`
- `registry/`
- `skills/bridges/`
- `docs/`
- `docker/`
- `.github/workflows/`
- release/package metadata and root build scripts

Exclude from the first public beta unless explicitly sanitized:
- personal/local editor config
- internal notes
- production-only deployment files with hardcoded hosted domains
- private infrastructure assumptions
- any local state, databases, secrets, or credentials

## Current recommendation for this repo

Use this repo as the private canonical source.

Export a sanitized public snapshot into a separate public repository using:
- `public-beta-allowlist.txt`
- `scripts/export-public-beta.sh`

That public export should be reviewed before every release.

## Public beta release model

Recommended public branding:
- public repo: `bridges`
- npm package: `bridges`
- CLI command: `bridges`
- first beta version: `0.0.1-beta`

### npm
Binary/npm release is intentionally deferred for now. Keep public beta usage source-first until you explicitly decide to publish.

When you are ready later, use beta-tagged releases:

```bash
npm publish --tag beta
```

Install:

```bash
npm install -g bridges@beta
```

### GitHub Releases
Use prerelease tags such as:
- `v0.0.1-beta`
- `v0.0.2-beta`

## Required quality gates before a public beta cut

### Rust
```bash
cargo fmt --manifest-path cli/Cargo.toml --check
cargo clippy --manifest-path cli/Cargo.toml -- -D warnings
cargo test --manifest-path cli/Cargo.toml
```

### Registry
```bash
cd registry
npm ci
npm run build
npm rebuild better-sqlite3
npm test
```

### Root package
```bash
npm pack --dry-run
npm run build
```

### Optional smoke test
```bash
npm run smoke:tmux
```

## Short-term next steps

1. maintain private-first development in this repo
2. prepare public-beta changes on `release/public-beta` or a staging branch
3. export the allowlisted snapshot into a separate public repo
4. review docs, envs, and public URLs
5. publish a prerelease for beta groups
