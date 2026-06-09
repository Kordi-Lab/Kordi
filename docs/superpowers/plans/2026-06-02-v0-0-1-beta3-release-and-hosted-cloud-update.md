# V0.0.1.beta3 Release and Hosted Cloud Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `V0.0.1.beta3` from current `main`, build a verified Cloud desktop release artifact, and update the hosted Cloud backend/runner on the product GCE host.

**Architecture:** Reuse the beta2 release metadata and DMG verification pattern, update it to beta3, verify desktop/frontend/Rust release checks locally, then deploy the hosted Cloud server and agent runner from the release branch to the product VM using the existing k3s deployment scripts with product-host overrides.

**Tech Stack:** Tauri 2, pnpm, Node `node:test`, Rust/Cargo, gcloud compute ssh, k3s/Kubernetes deployment scripts.

---

### Task 1: Set beta3 release metadata and release guards

**Files:**
- Modify: `app/desktop/package.json`
- Create if absent: `app/desktop/scripts/assert-macos-dmg-release.mjs`
- Create if absent: `app/desktop/tests/releaseVersion.test.mjs`
- Create if absent: `app/desktop/tests/macosDmgRelease.test.mjs`
- Modify: `app/desktop/src-tauri/tauri.conf.json`
- Modify: `app/desktop/src-tauri/tauri.cloud.conf.json`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify generated lockfiles if present/changed: `app/desktop/package-lock.json`, `app/desktop/src-tauri/Cargo.lock`, `Cargo.lock`

- [ ] Write release metadata tests for `V0.0.1.beta3` and `0.0.1-beta.3`.
- [ ] Update desktop package, Tauri config, and Cargo package versions to `0.0.1-beta.3`.
- [ ] Ensure Cloud release bundle remains product-named `Kordi` while Cloud edition is detected by bundle identifier.
- [ ] Add/verify `tauri:build:cloud:dmg` and `release:verify-cloud-dmg` scripts.
- [ ] Run release metadata and DMG verifier tests.
- [ ] Commit as `chore: set beta3 release metadata`.

### Task 2: Verify current-main beta3 release quality

**Files:**
- No code changes expected.

- [ ] Run focused beta3 desktop tests covering recent PRs and release guards.
- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Run `pnpm --dir app/desktop release:secret-guard`.
- [ ] Run Rust checks for Cloud server/runner areas when practical.
- [ ] Build Cloud DMG with hosted Cloud API base and verify installer layout.

### Task 3: Inspect hosted product Cloud state

**Files:**
- No code changes expected.

- [ ] SSH to `kordi-product` in `us-central1-a` under project `hai-gcp-representation`.
- [ ] Check k3s namespace, server deployment image, runner deployment image, rollout status, and health endpoint without printing secrets.
- [ ] Confirm whether server/runner deployment is required based on changed files since the previous Cloud fallback merge.

### Task 4: Deploy hosted Cloud server and 24h agent runner updates

**Files:**
- No code changes expected unless deployment scripts require product-host-safe overrides.

- [ ] Run `sync-and-build.sh` with product host overrides.
- [ ] Deploy Cloud server with a beta3 image tag if backend/server code changed or to align hosted release.
- [ ] Deploy Cloud agent runner with a beta3 image tag so the 24h Cloud reply fix is live.
- [ ] Verify rollout status, deployment images, health endpoint, and recent logs with secrets redacted.

### Task 5: Publish release branch/PR/tag notes

**Files:**
- Possibly update release notes if required by repository convention.

- [ ] Summarize merged PRs included in beta3: #519, #523/#524, #525/#526, #527/#528, #529/#530/#531, #532/#535, #533/#536/#537.
- [ ] Push release branch and open PR if metadata changes are needed.
- [ ] After merge, create/tag `v0.0.1.beta3` if requested.
- [ ] Report artifact path, hosted deployment image tags, and verification evidence.
