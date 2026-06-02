# Clean Session Header Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove outdated visible session metadata tags from chat headers while preserving useful title, Cloud sync, fork-source, and accessibility context.

**Architecture:** Keep metadata values in the view model for routing, composer behavior, detail panels, and tests, but stop rendering transport/trust/directness/type chips in the main chat header. Add a small exported header helper in `ChatsPage.tsx` so tests can lock the cleaned header behavior without depending on the full Tauri app shell.

**Tech Stack:** React, TypeScript, `node:test`, `react-dom/server`, existing Kordi desktop test runner via `pnpm --dir app/desktop exec tsx --test`.

---

## Project review findings

- Issue: https://github.com/Kordi-AI/Kordi/issues/532
- Branch/worktree: `fix/issue-532-clean-session-tags` at `/Users/shuyang/kordi/.worktrees/issue-532-clean-session-tags`
- Base: `origin/main` at `e84be1f1`
- Screenshot source matches `app/desktop/src/pages/ChatsPage.tsx` chat header:
  - `formatSessionIdSubtitle(activeConv.subtitle)` can show generic labels like `Group`.
  - `<TypeBadge type={activeConv.type} compact />` adds a visible type chip in the title row.
  - The second header row renders `activeConv.trust`, every `activeConv.bridges[]`, and `activeConv.directness` with `Shield`, `Globe`, and `ArrowRightLeft` icons.
- Right detail panel already has tests that hide outreach/trust/mode metadata in normal info view. Do not broaden this issue to rewrite detail panels.
- View-model fields such as `bridges`, `trust`, and `directness` are still used for routing, composer mention scope, and contact/session construction. Do not remove them from data models.
- Baseline targeted check:
  - `pnpm --dir app/desktop exec tsx --test tests/chatDetailPanel.test.tsx tests/composerCopy.test.tsx tests/chatStartRouting.test.tsx`
  - Result: `chatDetailPanel` and `composerCopy` pass, while `chatStartRouting` currently has unrelated baseline failures in `buildChatsPageProps` when some test shells omit new props. Do not treat those as regressions from this issue.

## File structure

- Modify: `app/desktop/src/pages/ChatsPage.tsx`
  - Remove unused metadata icon imports after header cleanup.
  - Add exported helpers:
    - `isGenericChatHeaderSubtitle(value: string): boolean`
    - `chatHeaderSubtitle(conversation: Pick<Conversation, 'subtitle'>): string | null`
  - Replace the existing second metadata row with a subtitle-only row that renders only non-generic, user-facing subtitle text.
  - Remove the chat-header `TypeBadge` chip; keep the Cloud sync icon and fork source pill.
- Test: `app/desktop/tests/chatHeaderMetadata.test.tsx`
  - New focused tests for helper behavior and rendered header markup.
- Optional review only: `app/desktop/src/pages/ChatDetailPanel.tsx`
  - Confirm no main chat header metadata lives here. Do not change unless a test reveals this issue is also visible in the right detail rail.

---

### Task 1: Add failing tests for cleaned chat header metadata

**Files:**
- Create: `app/desktop/tests/chatHeaderMetadata.test.tsx`
- Modify: none

- [ ] **Step 1: Create helper-focused regression tests**

Create `app/desktop/tests/chatHeaderMetadata.test.tsx` with this content:

```tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatHeaderSubtitle, isGenericChatHeaderSubtitle } from '../src/pages/ChatsPage';

test('chat header subtitle hides generic session-kind labels derived from internal ids', () => {
  assert.equal(isGenericChatHeaderSubtitle('Group'), true);
  assert.equal(isGenericChatHeaderSubtitle('Group chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Direct chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Direct person chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Agent chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Bridge'), true);
  assert.equal(isGenericChatHeaderSubtitle('Cloud'), true);
});

test('chat header subtitle keeps useful user-facing temporary status copy', () => {
  assert.equal(isGenericChatHeaderSubtitle('Cloud direct chat is opening…'), false);
  assert.equal(isGenericChatHeaderSubtitle('Waiting for first message'), false);
});

test('chat header subtitle removes internal group/direct session labels but keeps useful text', () => {
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:group:437f306a-6278-4b64-a635-79a71d2cb3e0' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:direct-person:acct_a:acct_b' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:direct-agent:next-id' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'Cloud direct chat is opening…' }), 'Cloud direct chat is opening…');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx
```

Expected: FAIL because `chatHeaderSubtitle` and `isGenericChatHeaderSubtitle` are not exported from `ChatsPage.tsx` yet.

---

### Task 2: Add chat header subtitle helpers

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/chatHeaderMetadata.test.tsx`

- [ ] **Step 1: Add the helper functions near `shouldShowConversationTypeBadge`**

In `app/desktop/src/pages/ChatsPage.tsx`, add this code after `shouldShowConversationTypeBadge`:

```tsx
const GENERIC_CHAT_HEADER_SUBTITLES = new Set([
  'agent chat',
  'bridge',
  'cloud',
  'direct chat',
  'direct person chat',
  'draft session',
  'external agent',
  'group',
  'group chat',
  'human',
  'local',
  'my agent',
  'owned',
  'person',
]);

export function isGenericChatHeaderSubtitle(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized.length === 0 || GENERIC_CHAT_HEADER_SUBTITLES.has(normalized);
}

export function chatHeaderSubtitle(conversation: Pick<Conversation, 'subtitle'>): string | null {
  const formatted = formatSessionIdSubtitle(conversation.subtitle).trim();
  if (!formatted || isGenericChatHeaderSubtitle(formatted)) return null;
  return formatted;
}
```

- [ ] **Step 2: Run the helper tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Commit the helper and tests**

Run:

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatHeaderMetadata.test.tsx
git commit -m "test: cover clean chat header metadata"
```

---

### Task 3: Clean the visible chat header rendering

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/chatHeaderMetadata.test.tsx`

- [ ] **Step 1: Replace the formatted subtitle variable**

Find:

```tsx
const activeSessionSubtitle = formatSessionIdSubtitle(activeConv.subtitle);
```

Replace with:

```tsx
const activeSessionSubtitle = chatHeaderSubtitle(activeConv);
```

- [ ] **Step 2: Remove the visible type badge from the chat title row**

Find this render expression in the title row:

```tsx
{shouldShowConversationTypeBadge(activeConv) ? <TypeBadge type={activeConv.type} compact /> : null}
```

Remove it from the chat header. Do not remove `TypeBadge` from `ChatDetailPanel.tsx` or transcript components.

- [ ] **Step 3: Replace the metadata row with subtitle-only rendering**

Find the current metadata row:

```tsx
<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-400">
  {activeSessionSubtitle ? (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono" title={activeSessionSubtitle}>
      <span className="truncate">{activeSessionSubtitle}</span>
    </span>
  ) : null}
  <span className="inline-flex items-center gap-1"><Shield className="h-3 w-3" /> {activeConv.trust}</span>
  {activeConv.bridges.map((bridge) => (
    <span key={bridge} className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> {bridge}</span>
  ))}
  <span className="inline-flex items-center gap-1"><ArrowRightLeft className="h-3 w-3" /> {activeConv.directness}</span>
</div>
```

Replace with:

```tsx
{activeSessionSubtitle ? (
  <div className="mt-0.5 flex min-w-0 items-center text-[11px] leading-5 text-slate-400">
    <span className="truncate" title={activeSessionSubtitle}>{activeSessionSubtitle}</span>
  </div>
) : null}
```

- [ ] **Step 4: Remove unused imports**

In `app/desktop/src/pages/ChatsPage.tsx`, remove unused imports for metadata icons and type badge support if the compiler reports them unused:

```tsx
ArrowRightLeft,
Globe,
Shield,
```

Keep `Cloud`, `PanelLeftClose`, `PanelLeftOpen`, `Paperclip`, `Send`, `Split`, and other still-used icons.

If `shouldShowConversationTypeBadge` becomes unused, leave it exported only if existing tests import it. If no tests/imports use it after the change, remove it and its tests in a separate small cleanup commit.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx tests/chatDetailPanel.test.tsx tests/composerCopy.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the rendering cleanup**

Run:

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatHeaderMetadata.test.tsx
git commit -m "fix: remove outdated chat header metadata tags"
```

---

### Task 4: Add a rendered-header guard test

**Files:**
- Modify: `app/desktop/tests/chatHeaderMetadata.test.tsx`
- Test: `app/desktop/tests/chatHeaderMetadata.test.tsx`

- [ ] **Step 1: Add a source-level guard for the exact regression**

Append this test to `app/desktop/tests/chatHeaderMetadata.test.tsx`:

```tsx
import { readFileSync } from 'node:fs';

test('ChatsPage header does not render trust, bridge, or directness metadata chips', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Shield[\s\S]*activeConv\.trust/);
  assert.doesNotMatch(source, /activeConv\.bridges\.map/);
  assert.doesNotMatch(source, /<Globe[\s\S]*bridge/);
  assert.doesNotMatch(source, /<ArrowRightLeft[\s\S]*activeConv\.directness/);
  assert.doesNotMatch(source, /shouldShowConversationTypeBadge\(activeConv\)/);
});
```

If TypeScript import ordering needs cleanup, keep Node built-in imports together at the top:

```tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
```

- [ ] **Step 2: Run the guard test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Commit the guard**

Run:

```bash
git add app/desktop/tests/chatHeaderMetadata.test.tsx
git commit -m "test: guard against chat header metadata regressions"
```

---

### Task 5: Final verification and PR prep

**Files:**
- Verify all changed files

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx tests/chatDetailPanel.test.tsx tests/composerCopy.test.tsx tests/transcriptDensity.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run diff whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Review final diff against issue #532**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatHeaderMetadata.test.tsx
```

Confirm:

- Chat header no longer renders `Group`, `Bridge`, duplicated `Bridge`, or `Group chat` metadata from subtitle/trust/transport/directness.
- Header still renders the conversation title.
- Header still renders Cloud self-agent sync icon when applicable.
- Header still renders fork-source pill when applicable.
- View-model metadata remains available for routing and composer logic.

- [ ] **Step 5: Push and open PR**

Run:

```bash
git push -u origin fix/issue-532-clean-session-tags
gh pr create --fill --body-file /tmp/issue-532-clean-session-tags-pr.md
```

Use this PR body:

```markdown
## Summary

- Removes outdated trust/transport/directness/type metadata chips from the main chat header.
- Filters generic session-kind subtitles such as `Group`, `Direct chat`, and `Agent chat` so internal session labels do not appear as visible header tags.
- Keeps useful header context such as title, Cloud sync icon, fork-source pill, and non-generic temporary status text.

Closes #532

## Validation

- `pnpm --dir app/desktop exec tsx --test tests/chatHeaderMetadata.test.tsx tests/chatDetailPanel.test.tsx tests/composerCopy.test.tsx tests/transcriptDensity.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx`
- `pnpm --dir app/desktop typecheck`
- `git diff --check`
```

---

## Notes for implementer

- Do not delete or rename `bridges`, `trust`, or `directness` fields in `Conversation`; they are not just visual tags.
- Do not change message routing, composer mention logic, Cloud fallback logic, or canonical session sync.
- Do not remove the fork-source pill; the user explicitly wanted fork behavior preserved in prior sidebar/header cleanup.
- Do not remove the Cloud self-agent sync icon; it is compact, icon-only, and useful status context.
- If a full `chatStartRouting` run still fails with `Cannot read properties of undefined`, record it as a pre-existing baseline failure unless the implementation touched `mainContentShellBuilders.ts` or shell arg defaults.
