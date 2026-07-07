# Issue 633 Transcript Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce session-switch lag by preventing long chat transcripts from rendering every message into the DOM at once.

**Architecture:** Add a small in-repo transcript windowing helper and wire `ChatSessionPane` to render a tail window for large histories. Keep existing scroll container, message grouping, live-turn, queued-message, fork boundary, and jump-to-message contracts intact. Avoid adding a dependency until the second pass proves we need full dynamic-height virtualization.

**Tech Stack:** React 19, TypeScript, existing Tauri desktop app, Node `tsx --test` regression tests.

---

## File Structure

- Modify `app/desktop/src/pages/ChatsPage.tsx`
  - Add transcript window constants and helper functions near `ChatSessionPane`.
  - Render only the selected message window for large transcripts.
  - Preserve original message indexes for grouping and fork boundary placement.
  - Add top/bottom spacer rows to keep scroll height roughly proportional.
- Modify `app/desktop/tests/panelAgentSessionParity.test.ts`
  - Add source-level regression coverage proving `ChatSessionPane` does not use direct `messages.map` for large transcripts and uses window helpers.
- Create `app/desktop/tests/transcriptWindowing.test.ts`
  - Unit-test helper behavior using source-level exported functions if helpers are exported, or source assertions if kept private.

## Task 1: Regression coverage for transcript windowing

**Files:**
- Modify: `app/desktop/tests/panelAgentSessionParity.test.ts`
- Create or modify: `app/desktop/tests/transcriptWindowing.test.ts`

- [ ] **Step 1: Add failing coverage**

Add tests that assert:

```ts
assert.match(source, /TRANSCRIPT_WINDOW_THRESHOLD/, 'ChatSessionPane should define a threshold for long transcript windowing');
assert.match(source, /visibleTranscriptMessages/, 'ChatSessionPane should render a bounded visible message slice');
assert.doesNotMatch(source, /messages\.length > 0 \? messages\.map\(\(msg, idx\)/, 'ChatSessionPane must not render every message directly for long histories');
assert.match(source, /data-transcript-window-spacer="top"/, 'windowed transcripts should preserve approximate scroll height above visible messages');
assert.match(source, /data-transcript-window-spacer="bottom"/, 'windowed transcripts should preserve approximate scroll height below visible messages');
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/panelAgentSessionParity.test.ts
```

Expected: FAIL because `ChatSessionPane` currently renders `messages.map(...)` directly.

## Task 2: Implement bounded transcript rendering

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Add helper constants and helpers**

Add near `ChatSessionPane`:

```ts
const TRANSCRIPT_WINDOW_THRESHOLD = 180;
const TRANSCRIPT_WINDOW_TAIL_COUNT = 140;
const TRANSCRIPT_WINDOW_OVERSCAN = 20;
const TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT = 74;

function transcriptWindowRange(messageCount: number, focusIndex = messageCount - 1) {
  if (messageCount <= TRANSCRIPT_WINDOW_THRESHOLD) {
    return { start: 0, end: messageCount, windowed: false };
  }
  const safeFocusIndex = Math.max(0, Math.min(messageCount - 1, focusIndex));
  const end = Math.min(messageCount, Math.max(safeFocusIndex + 1 + TRANSCRIPT_WINDOW_OVERSCAN, messageCount));
  const start = Math.max(0, end - TRANSCRIPT_WINDOW_TAIL_COUNT);
  return { start, end, windowed: true };
}
```

- [ ] **Step 2: Render visible window with original indexes**

Inside `ChatSessionPane`, derive:

```ts
const transcriptWindow = transcriptWindowRange(messages.length);
const visibleTranscriptMessages = messages.slice(transcriptWindow.start, transcriptWindow.end);
const topSpacerHeight = transcriptWindow.windowed ? transcriptWindow.start * TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT : 0;
const bottomSpacerHeight = transcriptWindow.windowed ? Math.max(0, messages.length - transcriptWindow.end) * TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT : 0;
```

Render `visibleTranscriptMessages.map((msg, visibleIdx) => { const idx = transcriptWindow.start + visibleIdx; ... })`.

- [ ] **Step 3: Preserve special rows**

Keep:
- `forkSnapshotBoundaryIndex` check using original `idx`.
- `isGroupedWithAdjacentHumanMessage(messages, idx, ...)` using the full message array.
- live turn and queued messages after the visible window.

## Task 3: Verification

**Files:**
- Test: `app/desktop/tests/panelAgentSessionParity.test.ts`
- Test: `app/desktop/tests/transcriptDensity.test.tsx`
- Test: `app/desktop/tests/transcriptNavigation.test.tsx`
- Test: `app/desktop/tests/transcriptJumpHighlight.test.tsx`

- [ ] **Step 1: Run focused tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/panelAgentSessionParity.test.ts tests/transcriptDensity.test.tsx tests/transcriptNavigation.test.tsx tests/transcriptJumpHighlight.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Native performance preview**

Launch an issue branch native preview against `https://coordinar.io`, switch the same large group sessions, and compare monitor data with the main baseline.

---

## Follow-up plan if lag remains

- Virtualize `WorkspaceSidebar` participant/session rows.
- Split native session payloads into sidebar summaries and active-session details.
- Optimize bridge/group transforms to avoid repeated full-array and nested message scans.
