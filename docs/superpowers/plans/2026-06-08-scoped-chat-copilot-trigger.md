# Scoped Chat Co-pilot Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change PR #534 from automatic side-by-side companion chats into an explicit, private co-pilot rail opened by a header button or `/copilot`/`/ask` slash command.

**Architecture:** Keep the existing split-pane rendering foundation, but gate it behind explicit local UI state. Rename user-facing “companion” copy to “co-pilot,” add helper functions for command parsing and rail open state, and route co-pilot drafts only to the side-session. Main session sends remain unchanged except when a slash trigger is consumed.

**Tech Stack:** React + TypeScript in `app/desktop/src/pages/ChatsPage.tsx`; Node test runner tests in `app/desktop/tests/chatHeaderBadge.test.tsx`.

---

### Task 1: Add pure trigger/open-state behavior tests

**Files:**
- Modify: `app/desktop/tests/chatHeaderBadge.test.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Write failing tests**

Add tests that assert:
- co-pilot does not auto-open when a candidate exists
- `/copilot draft this` and `/ask draft this` parse to prompt text
- non-trigger text is not consumed

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir app/desktop test:unit -- chatHeaderBadge.test.tsx`
Expected: FAIL because new helpers do not exist / behavior still defaults to open.

- [ ] **Step 3: Implement minimal helpers**

Add exported helpers in `ChatsPage.tsx` for explicit open state and slash trigger parsing.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir app/desktop test:unit -- chatHeaderBadge.test.tsx`
Expected: PASS for the targeted file.

### Task 2: Wire header button and slash command into ChatsPage

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/tests/chatHeaderBadge.test.tsx`

- [ ] **Step 1: Write failing source-structure tests**

Assert header contains `Ask co-pilot`, rail contains private scope copy, and the main send handler consumes `/copilot` without calling `onSendChatMessage` directly with the slash text.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir app/desktop test:unit -- chatHeaderBadge.test.tsx`
Expected: FAIL because current UI says Show side / side chat and no slash handler exists.

- [ ] **Step 3: Implement minimal UI wiring**

Add `openCopilotRail`, `closeCopilotRail`, `handleSendChatMessage`, update header button, and update rail copy.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir app/desktop test:unit -- chatHeaderBadge.test.tsx`
Expected: PASS.

### Task 3: Verify integration quality

**Files:**
- Verify all touched files

- [ ] **Step 1: Run targeted tests**

Run: `pnpm --dir app/desktop test:unit -- chatHeaderBadge.test.tsx`

- [ ] **Step 2: Run typecheck**

Run: `pnpm --dir app/desktop typecheck`

- [ ] **Step 3: Run whitespace check**

Run: `git diff --check`

- [ ] **Step 4: Review diff**

Run: `git diff -- app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatHeaderBadge.test.tsx docs/superpowers/plans/2026-06-08-scoped-chat-copilot-trigger.md`
