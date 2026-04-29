# WhatsApp-Style Unread Badges and Read Receipts Design

## Issue

Closes #146: **Feature/Bug: WhatsApp-style unread badges and reliable read receipts**.

## Goals

- Show numeric unread badges for chat sessions and Bridge/person conversations.
- Preserve unread counts through canonical session hydration instead of clobbering them to zero.
- Clear unread state only when the user actually views the relevant session.
- Send reliable Bridge `read` receipts when a recipient views unread inbound messages.
- Render outbound Bridge/person message delivery with WhatsApp-style checkmarks:
  - `sent` → single gray checkmark.
  - `delivered` → gray double checkmark.
  - `read` → blue double checkmark.
- Preview the fix in the existing `user1` / `user2` desktop instances before opening the PR.

## Non-goals

- OS notification center or dock badge integration.
- Group-chat per-participant read receipt UI.
- Per-message read timestamps.
- Replacing the delivery-state model wholesale.
- Attempting to show read receipts for messages that have no stable `requestId`.

## Current behavior and root cause

### Unread badges

The sidebar already has numeric badge rendering (`SidebarUnreadBadge`) and local/Bridge view models can compute non-zero unread counts. The regression is in canonical hydration:

- `app/desktop/src/features/canonical/sessionReadModel.ts`
- `createCanonicalSessionReadModel(...).applyConversation(...)`
- Current behavior sets `unread: 0`, overwriting the source conversation's unread count.

That causes the session rail and aggregate document title to receive `0`, so they correctly render no badge.

### Read receipts

Bridge mark-read currently has three reliability problems:

- Frontend auto-mark-read is gated by `unreadCount > 0`, so if any other path clears local unread first, read receipts can be skipped.
- Active Bridge conversations can be represented by canonical session ids; mark-read lookup should resolve both `conversation.id` and `conversation.canonicalSessionId`.
- Backend mark-read sends `read` only through realtime direct chat, ignores send errors, and lacks a relay/mailbox fallback.

## UX design

### Session unread badges

- Session rows continue to render the existing numeric badge component.
- Badge values display as `1`, `2`, `3`, ... and `99+` above 99.
- Badge appears only when `conversation.unread > 0`.
- Badge clears when the session is actually visible/opened.
- Aggregate unread count in document/window title remains the sum of visible chat conversation unread counts.

### Message status checkmarks

Outbound human Bridge messages display a compact status glyph beside the timestamp:

| Delivery state | Visual | Color | Meaning |
| --- | --- | --- | --- |
| `sending`, `pending_send` | clock/spinner | gray | send in progress |
| `sent` | single checkmark | gray | message accepted locally/transport send attempted |
| `delivered` | double checkmark | gray | peer received the message |
| `read` | double checkmark | blue | peer opened/viewed the message |
| `responded` | double checkmark | blue | response implies the message was read |
| `processing`, `handed_off_direct`, `handed_off_mailbox` | spinner | gray | remote agent is processing / handoff active |
| `failed`, `processing_failed` | warning | red | send or processing failed |

For direct person chats, `sent` must no longer render as gray double-check; it must render as a single gray check. `delivered` and `read` are visually distinct.

## Architecture

### Frontend read model

1. Preserve source unread counts in canonical hydration.
   - `applyConversation(...)` should keep `conversation.unread ?? 0` for source-backed conversations.
   - Synthetic canonical-only conversations remain `unread: 0` until canonical storage has authoritative unread state.

2. Keep unread status indicators consistent.
   - `buildSessionStatusIndicator(...)` already returns an `Unread` indicator when unread count is positive.
   - Numeric badge remains the primary WhatsApp-style count.

3. Add focused tests proving canonical hydration preserves unread count and document/sidebar consumers receive non-zero `unread`.

### Frontend mark-read orchestration

1. Resolve the active Bridge conversation by either:
   - `conversation.id === activeConvId`, or
   - `conversation.canonicalSessionId === activeConvId`.

2. Decide mark-read based on active visibility and inbound request ids, not only `unreadCount > 0`.
   - Active page must be `chats`.
   - Document must be visible and focused.
   - `shouldAutoFollowChatRef.current` must be true.
   - Conversation must have at least one inbound message with a `requestId`, or a positive `unreadCount`.

3. Deduplicate frontend calls with a stable signature such as:
   - `${conversation.id}:${unreadCount}:${sortedInboundRequestIds.join(',')}`.

This lets a newly arrived message in the active session trigger a read receipt, while avoiding loops from repeated renders.

### Backend read receipts

1. Backend `desktop_bridge_mark_conversation_read_impl(...)` should collect receipt candidates before clearing local unread:
   - inbound directions only (`inbound`, `inbound-response`),
   - messages with non-empty `requestId`,
   - de-duplicated by `requestId`.

2. Receipt sending is idempotent.
   - Sending a duplicate `read` receipt is acceptable; delivery state ranking on the sender side keeps `read` monotonic.
   - This avoids adding a new persisted receipt ledger in the MVP.

3. Transport behavior:
   - For realtime direct chats, try realtime first.
   - If realtime fails or is unavailable, fall back to relay/mailbox using the existing relay-with-contact-fallback behavior.
   - For non-realtime/project contexts, send via relay/mailbox.

4. Error handling:
   - Local unread clearing should still happen if receipt sending fails.
   - Receipt send failures should be logged with conversation id, target node id, and request id.
   - Logs must not print API keys, tokens, or payload plaintext beyond the delivery state/request id.
   - The UI should not show noisy transient banners for receipt send failures.

### Sender-side delivery update

Existing delivery-event handling updates sender-side messages through `update_message_delivery_state_in_storage(...)`. The fix relies on this existing path. When the recipient sends a `read` event, the sender's outbound message should transition to `read`, and the transcript glyph should become a blue double check.

## Data flow

1. User A sends a Bridge/person message to User B.
2. A stores outbound message with `requestId` and status `sent`.
3. B receives inbound message and increments local conversation `unreadCount`.
4. B's session rail shows a numeric unread badge.
5. B opens/views the session.
6. Frontend resolves the active Bridge conversation and calls `desktop_bridge_mark_conversation_read` even if local unread was already cleared by another path.
7. Backend collects inbound `requestId`s, clears local unread, sends `read` delivery events through realtime or relay fallback, and logs failures.
8. A receives the `read` delivery event through realtime/mailbox polling.
9. A updates the outbound message delivery state to `read`.
10. A's transcript displays a blue double-check glyph.

## Testing strategy

### TypeScript unit tests

- `app/desktop/tests/chatRouting.test.tsx`
  - Add regression coverage that `createCanonicalSessionReadModel(...).buildChatConversations(...)` preserves a source conversation `unread > 0`.
  - Add coverage for active Bridge conversation resolution by `canonicalSessionId` if helper extraction is needed.

- `app/desktop/tests/viewModelHelpers.test.tsx` or a focused transcript test
  - Verify `sent` maps to a single-check glyph state/class or extracted delivery visual model.
  - Verify `delivered` maps to gray double-check.
  - Verify `read`/`responded` maps to blue double-check.

### Rust tests

- Add small pure helper tests near Bridge conversation actions/storage:
  - pending read receipt ids include inbound messages with request ids even when `unread_count == 0`.
  - pending ids are de-duplicated.
  - outbound messages are not included.
  - read receipt payload uses `messageType: delivery_event` and `state: read`.

### Verification commands

Run before preview/PR:

```bash
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
pnpm --dir app/desktop test:unit -- tests/viewModelHelpers.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
cargo test -p kordi-desktop --no-default-features bridge::
git diff --check
```

If the Rust module path cannot be targeted as above, run the relevant `kordi-desktop` test command without the filter.

## Preview / manual QA plan

Before opening the PR, preview in the existing `user1` / `user2` desktop instances.

Important: preserve existing settings/data. When launching from the feature worktree, use a temporary multi-instance config whose `dataRoot`, `logsRoot`, and `runtimeRoot` point to the main repo's existing paths:

```text
/Users/shuyang/kordi/app/desktop/.multi-instance-data
/Users/shuyang/kordi/app/desktop/.multi-instance-logs
/Users/shuyang/kordi/app/desktop/.multi-instance-runtime
```

Manual QA matrix:

1. User A sends a Bridge/person message to User B while B is on another session/page.
2. B sees numeric unread badge `1` on that session.
3. A sees outbound status as single gray check or gray double-check depending on delivery event progress.
4. B opens/views the session.
5. B's unread badge clears.
6. A sees outbound status transition to blue double-check (`read`).
7. Repeat in the opposite direction.
8. Send multiple messages while the recipient is elsewhere and confirm badge count increments (`2`, `3`, etc.).
9. Confirm document/window title aggregate count updates and clears.

## Rollback

- Frontend unread/read-model changes can be reverted without data migration.
- Backend read receipts are idempotent delivery events; duplicate sends are safe.
- If relay fallback causes problems, revert the mark-read receipt transport helper while keeping unread badge preservation.

## Open decisions resolved

- This will be a single PR closing #146.
- The fix must be manually previewed in `user1` / `user2` before PR/merge.
- Message status uses WhatsApp-style checkmarks: single gray for sent, double gray for delivered, double blue for read.
