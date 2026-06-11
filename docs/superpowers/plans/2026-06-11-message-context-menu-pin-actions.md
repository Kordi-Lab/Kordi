# Message Context Menu Pin Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make #554 context menu actions non-dead by removing Edit, hiding unsupported placeholders, and implementing Telegram-style pin/unpin with confirmation and a pinned-message bar.

**Architecture:** Keep pin state as local UI state keyed by active conversation and message id, avoiding canonical/cloud mutation and the KV cache risk. `MessageContextMenuContent` renders only real actions based on explicit eligibility props; `ChatsPage` owns the active pinned message preview and confirmation dialogs.

**Tech Stack:** React, TypeScript, server-rendered component tests via `tsx --test`, existing Kordi desktop shell styles.

---

### Task 1: Context menu action eligibility and no-dead-controls tests

**Files:**
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`

- [ ] Add failing tests that Edit/Delete/reactions/view-replies are not rendered, Copy Text hides for empty messages, and live turns hide Reply/Forward/Select.
- [ ] Run targeted transcript tests and verify they fail.
- [ ] Implement explicit `canReply`, `canForward`, `canSelect`, `canPin`, `isPinned`, `onRequestPinMessage`, and `onRequestUnpinMessage` props for the context menu.
- [ ] Gate visible menu items from those props; remove Edit/Delete/reactions/view-replies.
- [ ] Run targeted transcript tests and verify they pass.

### Task 2: Pin state and pinned-message bar tests

**Files:**
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/mainContentShellBuilders.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`

- [ ] Add failing tests for pinned-message bar markup and pin/unpin dialog markup.
- [ ] Run targeted tests and verify they fail.
- [ ] Add local UI pin state in `useKordiAppModel`, keyed by conversation id and source message id.
- [ ] Wire pin/unpin request handlers into `ChatsPage` and `MessageBubble`.
- [ ] Render top pinned-message bar with title, preview, and X button.
- [ ] Render confirmation dialogs for pin and unpin.
- [ ] Run targeted tests and typecheck.

### Task 3: Verification

**Files:**
- All touched files

- [ ] Run `pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx tests/messageForwarding.test.tsx tests/messageSelection.test.ts tests/chatsPageQuotePreview.test.tsx`.
- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Run `git diff --check`.
