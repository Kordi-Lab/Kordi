# Cloud Account-Scoped Local Data Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Cloud Edition activates a deterministic per-account local data root before Cloud-visible local state is hydrated, so old data from another Cloud account cannot appear.

**Architecture:** Keep the Cloud session/token locator in the existing unscoped keychain/file slot so the app can discover the signed-in account. Add a Rust account-path resolver/activation command that sets an active Cloud account root under `<APP_DATA_DIR>/accounts/<hash>/kordi`, and call it from the Cloud session bootstrap/sign-in/sign-up/OAuth paths before authenticated state is exposed. Browser caches use account-scoped keys or account switch reload boundaries.

**Tech Stack:** Tauri/Rust commands, React/TypeScript Cloud session hook, Node TS tests, Rust unit tests.

---

### Task 1: Rust account path resolver and activation command

**Files:**
- Create: `app/desktop/src-tauri/src/cloud_account_paths.rs`
- Modify: `app/desktop/src-tauri/src/lib.rs`
- Test: Rust unit tests in the new module

- [ ] Write failing tests for same account same path, different accounts different paths, invalid IDs rejected, path under APP_DATA_DIR, and activation setting `KORDI_STORAGE_ROOT`.
- [ ] Add `CloudAccountStorageActivation { account_id, storage_root, requires_reload }`.
- [ ] Add `cloud_account_storage_root`, `cloud_account_storage_activate`, and `cloud_account_storage_current` Tauri commands.
- [ ] Register module and commands in `lib.rs`.
- [ ] Run `cargo test -p kordi-desktop --no-default-features cloud_account_paths`.
- [ ] Commit.

### Task 2: Frontend activation before auth state is published

**Files:**
- Modify: `app/desktop/src/lib/desktop.ts`
- Modify: `app/desktop/src/features/cloud/useCloudSession.ts`
- Test: `app/desktop/tests/cloudSessionPaths.test.tsx`

- [ ] Write failing tests that sign-in/sign-up/bootstrap call account storage activation before setting authenticated state.
- [ ] Add `activateDesktopCloudAccountStorage(accountId)` helper that no-ops in browser preview and invokes Tauri in native.
- [ ] In `useCloudSession`, call activation after every successful auth result and before `setAuthenticated` / device registration.
- [ ] Detect account switch against previous authenticated account; when account differs and native activation reports reload needed, call `window.location.reload()` after saving the session.
- [ ] Run the focused tests.
- [ ] Commit.

### Task 3: Browser key audit for account-scoped caches

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudDiffSync.ts` if tests reveal gaps
- Test: `app/desktop/tests/cloudDiffSync.test.tsx`

- [ ] Add/confirm tests that sync cursor keys for account A and account B differ and restore independently.
- [ ] If needed, add a shared `cloudAccountStorageKey(accountId, suffix)` helper.
- [ ] Run focused tests.
- [ ] Commit.

### Task 4: Verification and PR

**Files:**
- No production changes unless verification reveals a gap.

- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Run focused desktop tests: `cloudSessionPaths`, `cloudDiffSync`, `cloudBridgeState` if touched.
- [ ] Run Rust account-path tests.
- [ ] Open PR against `main-cloud` referencing #448.
