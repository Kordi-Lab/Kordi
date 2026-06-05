# In-app Desktop Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal blue in-app Update button that downloads/installs a packaged Kordi Desktop update quietly and then asks the user to restart or cancel.

**Architecture:** Add a small TypeScript updater service around Tauri updater/process plugins, a focused React controller/component for the button states, and pass it into the Chats sidebar header. Initialize updater/process plugins in Tauri and configure updater endpoints for packaged builds.

**Tech Stack:** React, TypeScript, Tauri v2 updater/process plugins, Node test runner/tsx.

---

### Task 1: Updater service and state model

**Files:**
- Create: `app/desktop/src/features/update/desktopUpdater.ts`
- Test: `app/desktop/tests/desktopUpdater.test.ts`

- [ ] Write failing tests for checking no native shell, available update, progress, install ready, failure.
- [ ] Implement `DesktopUpdateState`, `DesktopUpdateController`, and `createDesktopUpdateController(adapter)`.
- [ ] Verify tests pass.

### Task 2: Update button UI

**Files:**
- Create: `app/desktop/src/features/update/DesktopUpdateButton.tsx`
- Test: `app/desktop/tests/desktopUpdateButton.test.tsx`

- [ ] Write failing render tests for available, downloading, ready, failed.
- [ ] Implement compact blue `Update` button and restart notice.
- [ ] Verify tests pass.

### Task 3: Wire into Chats sidebar header

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Test: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx` or new focused sidebar test.

- [ ] Write failing test that the Chats header shows a blue Update button when update is available.
- [ ] Add prop plumbing and render in Chats header only.
- [ ] Verify focused tests pass.

### Task 4: Native Tauri integration

**Files:**
- Modify: `app/desktop/package.json`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify: `app/desktop/src-tauri/src/lib.rs`
- Modify: `app/desktop/src-tauri/tauri.conf.json`
- Modify: `app/desktop/src-tauri/tauri.cloud.conf.json`
- Test: `app/desktop/tests/desktopUpdaterConfig.test.mjs`

- [ ] Add updater/process JS and Rust plugin dependencies.
- [ ] Initialize plugins in Tauri builder.
- [ ] Add updater endpoint config placeholder using the hosted domain.
- [ ] Add config tests so release builds keep updater configured.

### Task 5: Verification

**Files:** all changed files.

- [ ] Run updater and sidebar tests.
- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Run relevant Rust check/build if dependencies changed.
- [ ] Commit and open PR for #539.
