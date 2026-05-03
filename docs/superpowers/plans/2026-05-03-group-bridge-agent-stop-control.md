# Group Bridge Agent Stop Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transcript-level stop button for local pending Bridge agent requests in group chats.

**Architecture:** Reuse the existing transcript live-turn DOM by adding optional Bridge request metadata to `DesktopChatTurnSnapshot`. The read model marks pending own Bridge agent turns as cancellable; the backend makes cancellation terminal and canonical-syncable.

**Tech Stack:** React/TypeScript desktop UI, Tauri Rust backend, SQLite Bridge/canonical stores, Node test runner, Cargo tests.

---

### Task 1: Read-model stop metadata

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/features/canonical/readModel/messageMapping.ts`
- Modify: `app/desktop/tests/chatRouting.test.tsx`

- [x] Add `BridgeAgentRequestControl` and optional `pendingBridgeAgentRequest` to `DesktopChatTurnSnapshot`.
- [x] Write failing tests proving local pending Bridge delegated exchange has stop metadata and non-local one does not.
- [x] Map `bridgeConversationId` + `bridgeRequestId` from pending own delegated exchanges into the turn snapshot.
- [x] Map pending synthetic Bridge agent-turns from `desktop-bridge-parent` content into the turn snapshot.
- [x] Run `pnpm --dir app/desktop exec tsx --test tests/chatRouting.test.tsx`.

### Task 2: Transcript stop icon

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`

- [x] Write failing render test for a pending turn with `pendingBridgeAgentRequest`, asserting an accessible stop button is present near the live status row.
- [x] Add an optional `onStopBridgeAgentRequest` prop through `MessageBubble`, `LiveChatTurnCard`, and `LiveChatTurnMessage` where needed.
- [x] Render a compact stop-square button beside the existing `Processing...` live status text.
- [x] Keep the button hidden for completed turns or turns without request metadata.
- [x] Run `pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx`.

### Task 3: Wire UI handler

**Files:**
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts`
- Modify: `app/desktop/src/features/chat/useComposerController.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/useKordiShellViewModel.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/mainContentShellBuilders.ts`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [x] Add `handleStopBridgeAgentRequest(request)` that calls `cancelDesktopBridgeOutreach(conversationId, requestId)` and merges returned Bridge state.
- [x] Thread the handler through existing shell args and chat page props.
- [x] Track in-flight stop state in the stop button so the icon disables while stopping.
- [x] Run `pnpm --dir app/desktop typecheck`.

### Task 4: Backend terminal cancellation sync

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [x] Write failing Rust test for cancelling an outbound group Bridge agent `session-message`: canonical agent-response row becomes terminal stopped/cancelled.
- [x] Ensure `desktop_bridge_cancel_outreach_impl` rebuilds with canonical sync after updating delivery state.
- [x] Update session-message wait-state reconciliation so `cancelled` requests produce a stable terminal `Request stopped` agent-turn instead of leaving or reviving processing.
- [x] Run targeted Rust tests for Bridge agent session messages.

### Task 5: Final validation

- [x] Run `pnpm --dir app/desktop test:unit`.
- [x] Run `pnpm --dir app/desktop typecheck`.
- [x] Run `pnpm --dir app/desktop lint`.
- [x] Run `pnpm --dir app/desktop build`.
- [x] Run `cargo fmt --manifest-path app/desktop/src-tauri/Cargo.toml -- --check`.
- [x] Run `cd app/desktop/src-tauri && cargo test --lib`.
- [x] Run `git diff --check origin/fix/issue-228-bridge-agent-timeout...HEAD` and `git diff --check`.
- [x] Commit with message `Add group Bridge agent stop control`.
