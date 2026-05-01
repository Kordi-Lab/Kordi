# Chat Space Inline Accordion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Chats participant-space drill-in page with first-page inline expansion, row-level actions, and Contacts/Groups/Latest filters.

**Architecture:** Keep the existing participant-space read model, but render it as a single accordion list in `WorkspaceSidebar`. Reuse existing session row, create-session, and group-management handlers; update filter semantics in the shared `ChatFilter` type and `filterParticipantSpaces` helper. Rename the self space to a clearer messaging-app label: `Notes to self`.

**Tech Stack:** React, TypeScript, server-rendered component tests via `renderToStaticMarkup`, existing CSS in `shell.css`.

---

### Task 1: Update participant-space filter semantics and self naming

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/app/useKordiLocalUiState.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
- Modify: `app/desktop/src/features/chat/participantSpaces.ts`
- Test: `app/desktop/tests/participantSpaces.test.tsx`

- [x] **Step 1: Write failing tests** for `Contacts`, `Groups`, and `Latest` filter values and `Notes to self` title.
- [x] **Step 2: Run** `pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx` and confirm failures mention the old filter/title behavior.
- [x] **Step 3: Implement minimal type/filter/title changes.**
- [x] **Step 4: Re-run targeted tests until green.**

### Task 2: Replace second-page drill-in with inline accordion rows

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Test: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`
- Style: `app/desktop/src/styles/shell.css` if existing classes need inline-expansion adjustments.

- [x] **Step 1: Write failing component tests** asserting no Back-to-chats/page-2 header, expanded sessions render under the first-page row, collapse affordance exists, and row-level `+`/`...` actions are present.
- [x] **Step 2: Run** `pnpm --dir app/desktop test:unit -- workspaceSidebarParticipantSpaces.test.tsx` and confirm failures.
- [x] **Step 3: Remove the slide-page branch and render sessions under expanded rows.**
- [x] **Step 4: Put `+` on every participant-space row and `...` on group rows.**
- [x] **Step 5: Re-run targeted tests until green.**

### Task 3: Verify and commit

- [x] Run `pnpm --dir app/desktop test:unit`.
- [x] Run `pnpm --dir app/desktop typecheck`.
- [x] Run `pnpm --dir app/desktop lint`.
- [x] Run `pnpm --dir app/desktop build`.
- [x] Run `git diff --check`.
- [x] Commit and push the branch.
