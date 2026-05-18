# Cloud UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide raw session IDs, remove Cloud/Bridge jargon from Cloud-facing user surfaces, and convert detail section headers to sentence case.

**Architecture:** Make small, targeted copy and formatting changes at existing render boundaries. Keep local-edition Bridge behavior intact by changing Cloud-leaking copy that appears in Cloud or generic shared surfaces. Add regression tests that inspect helper behavior and key source surfaces.

**Tech Stack:** React/TypeScript desktop app, Node `tsx --test` tests, existing CSS in `theme-overrides.css`.

---

### Task 1: Hide raw session IDs from visible subtitles

**Files:**
- Modify: `app/desktop/src/app/viewModels/helpers.ts`
- Modify: `app/desktop/tests/viewModelHelpers.test.tsx`

- [ ] **Step 1: Write the failing tests**

Update `formatSessionIdSubtitle labels raw ids for display` in `app/desktop/tests/viewModelHelpers.test.tsx` so raw IDs no longer render with `Session ID:`. Expected assertions:

```ts
assert.equal(formatSessionIdSubtitle('63138d66-0f5b-40dd-90ea-605f7cdb9ba0'), 'Direct chat');
assert.equal(formatSessionIdSubtitle('  '), '');
assert.equal(formatSessionIdSubtitle('Direct human chat'), 'Direct human chat');
assert.equal(formatSessionIdSubtitle('session:direct-person:acct_a:acct_b'), 'Direct chat');
assert.equal(formatSessionIdSubtitle('session:group:437f306a-6278-4b64-a635-79a71d2cb3e0'), 'Group');
assert.equal(formatSessionIdSubtitle('session:direct-agent:next-id'), 'Agent chat');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir app/desktop exec tsx --test tests/viewModelHelpers.test.tsx`

Expected: FAIL because raw IDs still render as `Session ID: ...`.

- [ ] **Step 3: Implement friendly subtitles**

Change `formatSessionIdSubtitle` in `helpers.ts` so canonical group/direct-agent/direct-person IDs return `Group`, `Agent chat`, or `Direct chat`, and any other raw UUID/session-looking value returns `Direct chat` instead of the ID.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --dir app/desktop exec tsx --test tests/viewModelHelpers.test.tsx`

Expected: PASS.

### Task 2: Remove Cloud/Bridge jargon from Cloud-visible copy

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/tests/cloudSurfaceCleanup.test.ts`

- [ ] **Step 1: Write the failing tests**

Add assertions to `cloudSurfaceCleanup.test.ts` that source copy does not include `Cloud chat is still loading`, `Cloud` profile pill copy, or user-facing `Bridge` card text in Cloud shell surfaces.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts`

Expected: FAIL on existing jargon strings.

- [ ] **Step 3: Implement copy changes**

Use concise user terms:
- Profile pill: `Account` or remove the edition label if redundant.
- Loading toast: `Chat is still loading. Try again in a moment.`
- Bridge card title in Cloud-visible navigation: `Connections`.
- Cloud restored-context comments in message metadata: user-safe terms such as `Conversation history`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts`

Expected: PASS.

### Task 3: Use sentence case for detail section labels

**Files:**
- Modify: `app/desktop/src/styles/shell.css`
- Modify: `app/desktop/src/pages/ChatDetailPanel.tsx`
- Modify: `app/desktop/src/pages/ProjectDetailPanel.tsx`
- Modify: `app/desktop/src/pages/GroupDetailsDialog.tsx`
- Modify: relevant tests under `app/desktop/tests/`

- [ ] **Step 1: Write or update failing tests**

Add source/markup assertions that `.app-detail-kicker` no longer applies `text-transform: uppercase`, and visible labels are sentence case (`Activity`, `Members`, `Details`) rather than aggressive all-caps styling.

- [ ] **Step 2: Run focused tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts tests/workspaceSidebarParticipantSpaces.test.tsx tests/chatDetailPanel.test.tsx`

Expected: FAIL if tests still expect uppercase style or old labels.

- [ ] **Step 3: Implement style and label changes**

Remove uppercase text transform and excessive letter spacing from `.app-detail-kicker`; update hard-coded all-caps labels to sentence case where they render to users.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts tests/workspaceSidebarParticipantSpaces.test.tsx tests/chatDetailPanel.test.tsx`

Expected: PASS.

### Task 4: Final verification and commit

**Files:**
- All modified files.

- [ ] **Step 1: Run all focused issue tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/viewModelHelpers.test.tsx tests/cloudSurfaceCleanup.test.ts tests/workspaceSidebarParticipantSpaces.test.tsx tests/chatDetailPanel.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --dir app/desktop typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-05-18-cloud-ui-polish.md app/desktop/src app/desktop/tests
git commit -m "Polish Cloud-facing UI copy"
```

Expected: commit created on `feature/issue-471-cloud-ui-polish`.
