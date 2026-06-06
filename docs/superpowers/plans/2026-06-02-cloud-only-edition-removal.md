# Cloud-Only Edition Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the local product edition escape hatch and hidden legacy product pages so the final desktop app is Cloud-only.

**Architecture:** Replace edition branching with Cloud-only constants and Cloud-only UI/data selectors. Keep internal canonical model vocabulary such as `source: 'local'` for self/owned-agent records, because that is not a product edition switch and is still used by Cloud data mapping.

**Tech Stack:** TypeScript/React desktop app, pnpm scripts, Node test runner, Rust/Tauri checks.

---

### Task 1: Add failing Cloud-only guards

**Files:**
- Modify: `scripts/cloud-only-defaults.test.mjs`
- Modify: `app/desktop/tests/cloudEdition.test.tsx`
- Modify: `app/desktop/tests/cloudSurfaceCleanup.test.ts`

- [ ] Assert root and desktop package scripts expose no `:local` commands and no `KORDI_EDITION` / `VITE_KORDI_EDITION` env flags.
- [ ] Assert edition helpers only expose Cloud behavior and ignore local/title/query override attempts.
- [ ] Assert Cloud navigation/settings exclude Projects, Settings, and Bridge legacy pages.
- [ ] Run targeted tests and verify they fail before implementation.

### Task 2: Remove command-level local edition escape hatches

**Files:**
- Modify: `package.json`
- Modify: `app/desktop/package.json`

- [ ] Point default scripts directly at Cloud build/dev commands without edition env flags.
- [ ] Remove root `dev:local`, `dev:desktop:local`, `build:local`.
- [ ] Remove desktop `tauri:dev:local`, `tauri:build:local`.
- [ ] Keep Cloud-specific names only where useful for release/dev ergonomics, but make them edition-env-free.

### Task 3: Simplify Cloud edition runtime code

**Files:**
- Modify: `app/desktop/src/features/cloud/edition.ts`
- Modify: `app/desktop/src/KordiApp.tsx`
- Modify: `app/desktop/src/app/MainContentSwitch.tsx`
- Modify: `app/desktop/src/app/useKordiAppModelHelpers.ts`

- [ ] Change `KordiEdition` to Cloud-only.
- [ ] Make edition resolver functions always return Cloud and ignore local override attempts.
- [ ] Make app root always use Cloud session/login flow.
- [ ] Make Contacts route always use Cloud contacts behavior.
- [ ] Simplify cloud session action selection to Cloud semantics only.

### Task 4: Remove hidden legacy page surfaces

**Files:**
- Modify: `app/desktop/src/kordi-app/data/navigation.tsx`
- Modify: `app/desktop/src/kordi-app/data/settings.tsx`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
- Modify: `app/desktop/src/features/chat/composerController.shared.ts`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`

- [ ] Remove Projects, Settings, and Bridge from Cloud product navigation.
- [ ] Stop exposing legacy sidebar create behavior that was only hidden behind `currentKordiEdition() !== 'cloud'`.
- [ ] Make Cloud slash-command help the only composer command help.
- [ ] Preserve internal self/local canonical semantics.

### Task 5: Update docs and verification

**Files:**
- Modify: `README.md`
- Modify: `app/desktop/README.md`
- Modify: `docs/development.md`
- Modify: `docs/run-cloud-desktop.md`
- Modify: `docs/hosted-cloud-developer-guide.md`
- Modify: `docs/changelogs/*.md` where current text describes local edition toggles.

- [ ] Remove local command references and edition env instructions.
- [ ] Keep product host `https://coordinar.io` and test host placeholder guidance.
- [ ] Run targeted tests, typecheck, lint, Rust checks, and source scans.
