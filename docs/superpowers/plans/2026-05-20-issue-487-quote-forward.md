# Quote and Forward Message Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add right-click Quote and Forward interactions with visible composer previews and Telegram-style forwarded headers.

**Architecture:** Extend the existing `Message` view model with `quote` and `forwardedFrom` metadata, then thread composer interaction state from `ChatsPage` into send actions. Keep message context-menu UI in `transcript.tsx` and keep destination selection in `ChatsPage` so it can navigate sessions and reuse the normal composer/send path.

**Tech Stack:** React, TypeScript, existing desktop canonical session read model, Node `tsx --test`, `pnpm --dir app/desktop typecheck`.

---

### Task 1: Transcript surfaces and message metadata

**Files:**
- Modify: `app/desktop/src/kordi-app/types/message.ts`
- Modify: `app/desktop/src/features/canonical/readModel/messageMapping.ts`
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Test: `app/desktop/tests/transcriptInteractions.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests that render `MessageBubble` and assert:
- eligible messages expose a right-click menu with `Quote` and `Forward`;
- messages with `forwardedFrom` render inline text `Forwarded from Alice` inside the normal bubble;
- messages with `quote` render a quote preview with source sender and excerpt;
- processing turn messages do not expose Quote/Forward.

Run: `pnpm --dir app/desktop exec tsx --test tests/transcriptInteractions.test.tsx`
Expected: FAIL because no menu or metadata surfaces exist.

- [ ] **Step 2: Implement minimal transcript support**

Add `MessageQuoteReference` and `MessageForwardReference` to the message types. Render context menu state in `MessageBubbleView`, add `onQuoteMessage` / `onForwardMessage` props, and render inline quote/forward headers in the bubble.

- [ ] **Step 3: Verify tests pass**

Run: `pnpm --dir app/desktop exec tsx --test tests/transcriptInteractions.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add app/desktop/src/kordi-app/types/message.ts app/desktop/src/features/canonical/readModel/messageMapping.ts app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/transcriptInteractions.test.tsx && git commit -m "Add transcript quote and forward surfaces"`

### Task 2: Composer quote and forward preview state

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/chatsPageQuoteForward.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests that render the composer area with selected quote/forward state and assert removable previews exist with accessible labels.

Run: `pnpm --dir app/desktop exec tsx --test tests/chatsPageQuoteForward.test.tsx`
Expected: FAIL because composer previews do not exist.

- [ ] **Step 2: Implement minimal composer UI**

Store `composerQuote` and `composerForward` state in `ChatsPage`. `Quote` sets quote state for the active composer. `Forward` opens a destination picker, and selecting a session navigates there and sets forward state. Previews render above attachments and include remove buttons.

- [ ] **Step 3: Verify tests pass**

Run: `pnpm --dir app/desktop exec tsx --test tests/chatsPageQuoteForward.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatsPageQuoteForward.test.tsx && git commit -m "Show composer quote and forward previews"`

### Task 3: Send metadata through canonical user messages

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/optimistic.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/composerController.types.ts`
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts`
- Test: `app/desktop/tests/messageInteractionMetadata.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for `prepareCanonicalUserMessage` with quote and forwarded metadata. Assert `parentMessageId` and `content.quote` for quotes, and `content.forwardedFrom` for forwards.

Run: `pnpm --dir app/desktop exec tsx --test tests/messageInteractionMetadata.test.ts`
Expected: FAIL because metadata arguments do not exist.

- [ ] **Step 2: Implement minimal send threading**

Add optional `interactionMetadata` to composer action args. Clear quote/forward state after successful send. `prepareCanonicalUserMessage` writes metadata into canonical content.

- [ ] **Step 3: Verify tests pass**

Run: `pnpm --dir app/desktop exec tsx --test tests/messageInteractionMetadata.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add app/desktop/src/features/chat/messageActions/optimistic.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/composerController.types.ts app/desktop/src/features/chat/useComposerMessageActions.ts app/desktop/tests/messageInteractionMetadata.test.ts && git commit -m "Persist quote and forward message metadata"`

### Task 4: Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run targeted tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/transcriptInteractions.test.tsx tests/chatsPageQuoteForward.test.tsx tests/messageInteractionMetadata.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck and lint**

Run: `pnpm --dir app/desktop typecheck && pnpm --dir app/desktop lint`
Expected: PASS.

- [ ] **Step 3: Commit any polish fixes**

If verification required code fixes, commit them with `git commit -m "Polish quote and forward interactions"`.
