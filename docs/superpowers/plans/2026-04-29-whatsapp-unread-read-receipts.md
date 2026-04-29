# WhatsApp-Style Unread Badges and Read Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #146 by preserving unread badges, making Bridge read receipts reliable, and rendering WhatsApp-style sent/delivered/read checkmarks.

**Architecture:** Keep unread counts in the frontend read model instead of inventing canonical unread state. Extract pure frontend helpers for Bridge read-receipt activation and delivery glyph semantics so behavior is easy to test. On the backend, collect read-receipt request ids before clearing unread, send `read` over realtime with relay fallback, and log failures without surfacing noisy UI errors.

**Tech Stack:** React/TypeScript desktop frontend, Tauri command bridge, Rust `kordi-desktop` Bridge modules, Node test runner, Cargo tests.

---

## File structure

- Modify `app/desktop/src/features/canonical/sessionReadModel.ts`
  - Preserve source conversation unread counts during canonical hydration.
- Modify `app/desktop/tests/chatRouting.test.tsx`
  - Add regression test for canonical unread preservation.
- Create `app/desktop/src/features/bridge/readReceipts.ts`
  - Pure helpers for active Bridge conversation resolution and mark-read eligibility/signatures.
- Create `app/desktop/tests/bridgeReadReceipts.test.tsx`
  - Unit tests for canonical-id resolution and read-receipt eligibility when unread has already been cleared.
- Modify `app/desktop/src/features/bridge/useBridgeState.ts`
  - Use the new helper so active Bridge sessions mark read by canonical id and by inbound request ids, not only `unreadCount > 0`.
- Create `app/desktop/src/features/chat/deliveryStatus.ts`
  - Pure helper mapping delivery states to glyph semantics.
- Create `app/desktop/tests/deliveryStatus.test.tsx`
  - Unit tests for single gray sent, double gray delivered, double blue read/responded.
- Modify `app/desktop/src/kordi-app/components/transcript.tsx`
  - Render delivery glyphs from the pure helper.
- Modify `app/desktop/src-tauri/src/bridge/conversation_actions.rs`
  - Add read receipt request-id collection, payload construction, realtime-then-relay sending, and diagnostic logging.
- Optionally modify `app/desktop/src-tauri/src/bridge/constants.rs`
  - Only if shared delivery helper constants require visibility changes.

---

### Task 1: Preserve canonical unread counts

**Files:**
- Modify: `app/desktop/tests/chatRouting.test.tsx`
- Modify: `app/desktop/src/features/canonical/sessionReadModel.ts`

- [ ] **Step 1: Write the failing test**

Add this test near the existing canonical read model tests in `app/desktop/tests/chatRouting.test.tsx`:

```ts
test('canonical read model preserves unread count from source bridge conversation', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:unread', kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-1', sessionId: 'session:bridge:humans:unread', role: 'person', senderIdentityId: 'human:bob', text: 'Unread hello', status: 'delivered', createdAtMs: 2, updatedAtMs: 2 },
    ],
    contextSnapshots: [],
  });

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:unread',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 3,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'Unread hello', time: '10:00' }],
  };

  const [conversation] = readModel.buildChatConversations([sourceConversation], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.unread, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
```

Expected: FAIL with `0 !== 3` for the new unread preservation test.

- [ ] **Step 3: Write minimal implementation**

In `app/desktop/src/features/canonical/sessionReadModel.ts`, change the hydrated conversation object from:

```ts
unread: 0,
```

to:

```ts
unread: conversation.unread ?? 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/canonical/sessionReadModel.ts app/desktop/tests/chatRouting.test.tsx
git commit -m "Preserve canonical unread counts"
```

---

### Task 2: Add frontend Bridge read-receipt helpers

**Files:**
- Create: `app/desktop/src/features/bridge/readReceipts.ts`
- Create: `app/desktop/tests/bridgeReadReceipts.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/bridgeReadReceipts.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeBridgeConversationForSession,
  bridgeReadReceiptSignature,
  shouldMarkBridgeConversationRead,
} from '../src/features/bridge/readReceipts';
import type { DesktopBridgeConversation } from '../src/kordi-app/types';

function conversation(overrides: Partial<DesktopBridgeConversation> = {}): DesktopBridgeConversation {
  return {
    id: 'bridge:host-1:peer-1:person',
    canonicalSessionId: 'session:bridge:humans:thread-1',
    hostId: 'host-1',
    peerNodeId: 'peer-1',
    peerDisplayName: 'Peer',
    peerOwnerName: 'Peer',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Peer',
    subtitle: 'Direct person chat',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '10:00',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

test('activeBridgeConversationForSession resolves canonical session ids', () => {
  const active = activeBridgeConversationForSession([
    conversation({ id: 'bridge:host-1:peer-1:person', canonicalSessionId: 'session:bridge:humans:thread-1' }),
  ], 'session:bridge:humans:thread-1');

  assert.equal(active?.id, 'bridge:host-1:peer-1:person');
});

test('shouldMarkBridgeConversationRead stays true when unread was cleared but inbound request ids exist', () => {
  const active = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-in', direction: 'inbound', sender: 'Peer', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: null },
    ],
  });

  assert.equal(shouldMarkBridgeConversationRead(active), true);
});

test('bridgeReadReceiptSignature changes when a new inbound request id arrives', () => {
  const first = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-in-1', direction: 'inbound', sender: 'Peer', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: null },
    ],
  });
  const second = conversation({
    unreadCount: 0,
    messages: [
      ...first.messages,
      { id: 'msg-in-2', direction: 'inbound', sender: 'Peer', text: 'again', timeLabel: '10:01', timestampMs: 2, requestId: 'req-2', deliveryState: null },
    ],
  });

  assert.notEqual(bridgeReadReceiptSignature(first), bridgeReadReceiptSignature(second));
});

test('shouldMarkBridgeConversationRead ignores outbound-only conversations', () => {
  const active = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-out', direction: 'outbound', sender: 'Me', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: 'sent' },
    ],
  });

  assert.equal(shouldMarkBridgeConversationRead(active), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/bridgeReadReceipts.test.tsx
```

Expected: FAIL because `../src/features/bridge/readReceipts` does not exist.

- [ ] **Step 3: Implement helper**

Create `app/desktop/src/features/bridge/readReceipts.ts`:

```ts
import { isInboundBridgeMessageDirection } from '@/features/bridge/messages';
import type { DesktopBridgeConversation } from '@/kordi-app/types';

export function activeBridgeConversationForSession(
  conversations: DesktopBridgeConversation[],
  activeSessionId: string,
) {
  return conversations.find((conversation) => (
    conversation.id === activeSessionId || conversation.canonicalSessionId === activeSessionId
  )) ?? null;
}

export function inboundBridgeRequestIds(conversation: DesktopBridgeConversation) {
  return Array.from(new Set(
    conversation.messages
      .filter((message) => isInboundBridgeMessageDirection(message.direction))
      .map((message) => message.requestId?.trim())
      .filter((requestId): requestId is string => Boolean(requestId)),
  )).sort();
}

export function shouldMarkBridgeConversationRead(conversation: DesktopBridgeConversation) {
  return conversation.unreadCount > 0 || inboundBridgeRequestIds(conversation).length > 0;
}

export function bridgeReadReceiptSignature(conversation: DesktopBridgeConversation) {
  return [
    conversation.id,
    Math.max(0, conversation.unreadCount),
    ...inboundBridgeRequestIds(conversation),
  ].join(':');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/bridgeReadReceipts.test.tsx
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/bridge/readReceipts.ts app/desktop/tests/bridgeReadReceipts.test.tsx
git commit -m "Add bridge read receipt helpers"
```

---

### Task 3: Use frontend read-receipt helpers in Bridge state

**Files:**
- Modify: `app/desktop/src/features/bridge/useBridgeState.ts`
- Test: `app/desktop/tests/bridgeReadReceipts.test.tsx`

- [ ] **Step 1: Confirm helper tests are green before integration**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/bridgeReadReceipts.test.tsx
```

Expected: pass.

- [ ] **Step 2: Integrate helper in `useBridgeState.ts`**

Add this import:

```ts
import {
  activeBridgeConversationForSession,
  bridgeReadReceiptSignature,
  shouldMarkBridgeConversationRead,
} from '@/features/bridge/readReceipts';
```

Change `activeBridgeReadRequestRef` to store signatures:

```ts
const activeBridgeReadRequestRef = useRef<string | null>(null);
```

Replace the mark-read effect's active conversation lookup and unread gate with:

```ts
const activeConversation = activeBridgeConversationForSession(desktopBridgeState?.conversations ?? [], activeConvId);
if (!activeConversation) return;
if (!shouldMarkBridgeConversationRead(activeConversation)) {
  activeBridgeReadRequestRef.current = null;
  return;
}
```

Replace the duplicate check with:

```ts
const readSignature = bridgeReadReceiptSignature(activeConversation);
if (activeBridgeReadRequestRef.current === readSignature) return;

activeBridgeReadRequestRef.current = readSignature;
```

Keep the existing `markDesktopBridgeConversationRead(activeConversation.id)` call.

- [ ] **Step 3: Run frontend tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/bridgeReadReceipts.test.tsx
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add app/desktop/src/features/bridge/useBridgeState.ts
git commit -m "Mark bridge reads by request ids"
```

---

### Task 4: Add WhatsApp-style delivery visual model

**Files:**
- Create: `app/desktop/src/features/chat/deliveryStatus.ts`
- Create: `app/desktop/tests/deliveryStatus.test.tsx`
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/deliveryStatus.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { messageDeliveryVisual } from '../src/features/chat/deliveryStatus';

test('messageDeliveryVisual maps sent to a single gray check', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
});

test('messageDeliveryVisual maps delivered to gray double checks', () => {
  assert.deepEqual(messageDeliveryVisual('delivered'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Delivered',
  });
});

test('messageDeliveryVisual maps read and responded to blue double checks', () => {
  assert.deepEqual(messageDeliveryVisual('read'), {
    glyph: 'double-check',
    tone: 'blue',
    label: 'Read',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'blue',
    label: 'Read',
  });
});

test('messageDeliveryVisual keeps transient and failure states distinct', () => {
  assert.equal(messageDeliveryVisual('sending')?.glyph, 'clock');
  assert.equal(messageDeliveryVisual('processing')?.glyph, 'spinner');
  assert.equal(messageDeliveryVisual('processing_failed')?.glyph, 'error');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/deliveryStatus.test.tsx
```

Expected: FAIL because `deliveryStatus.ts` does not exist.

- [ ] **Step 3: Implement helper**

Create `app/desktop/src/features/chat/deliveryStatus.ts`:

```ts
export type MessageDeliveryVisual = {
  glyph: 'single-check' | 'double-check' | 'clock' | 'spinner' | 'error';
  tone: 'gray' | 'blue' | 'red';
  label: string;
};

export function messageDeliveryVisual(status?: string | null): MessageDeliveryVisual | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'read' || normalized === 'responded') {
    return { glyph: 'double-check', tone: 'blue', label: 'Read' };
  }
  if (normalized === 'delivered') {
    return { glyph: 'double-check', tone: 'gray', label: 'Delivered' };
  }
  if (normalized === 'sent') {
    return { glyph: 'single-check', tone: 'gray', label: 'Sent' };
  }
  if (normalized === 'sending' || normalized === 'pending_send') {
    return { glyph: 'clock', tone: 'gray', label: 'Sending' };
  }
  if (normalized === 'processing' || normalized === 'awaiting reply' || normalized === 'handed_off_direct' || normalized === 'handed_off_mailbox') {
    return { glyph: 'spinner', tone: 'gray', label: 'Processing' };
  }
  if (normalized === 'failed' || normalized === 'processing_failed') {
    return { glyph: 'error', tone: 'red', label: 'Failed' };
  }
  return null;
}
```

- [ ] **Step 4: Wire transcript glyph rendering**

In `app/desktop/src/kordi-app/components/transcript.tsx`:

1. Import the helper:

```ts
import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
```

2. Update `MessageDeliveryGlyph` to use the visual model. The final function should be equivalent to:

```tsx
function MessageDeliveryGlyph({ status }: { status: string }) {
  const visual = messageDeliveryVisual(status);
  if (!visual) return null;

  const toneClass = visual.tone === 'blue'
    ? 'text-sky-400'
    : visual.tone === 'red'
      ? 'text-rose-400'
      : 'text-slate-400';

  if (visual.glyph === 'single-check') {
    return <Check className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'double-check') {
    return <CheckCheck className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'clock') {
    return <Clock3 className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'spinner') {
    return <LoaderCircle className={cn('h-3.5 w-3.5 animate-spin', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'error') {
    return <CircleAlert className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  return null;
}
```

3. Ensure `Check` is imported from `lucide-react` next to `CheckCheck`.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/deliveryStatus.test.tsx
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/features/chat/deliveryStatus.ts app/desktop/tests/deliveryStatus.test.tsx app/desktop/src/kordi-app/components/transcript.tsx
git commit -m "Render WhatsApp-style delivery checks"
```

---

### Task 5: Add backend read-receipt collection and payload tests

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs`

- [ ] **Step 1: Write failing Rust tests**

At the bottom of `app/desktop/src-tauri/src/bridge/conversation_actions.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::constants::{
        BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    };

    fn test_conversation(messages: Vec<crate::bridge::DesktopBridgeConversationMessageRecord>) -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host-1:peer-1:person".to_string(),
            host_id: "host-1".to_string(),
            peer_node_id: "peer-1".to_string(),
            peer_display_name: Some("Peer".to_string()),
            peer_owner_name: Some("Peer".to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            unread_count: 0,
            updated_at_ms: 1,
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: None,
            identity: None,
            messages,
        }
    }

    fn test_message(direction: &str, request_id: Option<&str>) -> crate::bridge::DesktopBridgeConversationMessageRecord {
        crate::bridge::DesktopBridgeConversationMessageRecord {
            id: format!("msg-{}", request_id.unwrap_or("none")),
            direction: direction.to_string(),
            sender: Some("Peer".to_string()),
            text: "hello".to_string(),
            timestamp_ms: 1,
            request_id: request_id.map(ToString::to_string),
            delivery_state: None,
            outreach: None,
        }
    }

    #[test]
    fn pending_read_receipt_request_ids_include_inbound_ids_when_unread_is_zero() {
        let conversation = test_conversation(vec![
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, Some("req-1")),
        ]);

        assert_eq!(pending_read_receipt_request_ids(&conversation), vec!["req-1".to_string()]);
    }

    #[test]
    fn pending_read_receipt_request_ids_deduplicate_and_skip_outbound() {
        let conversation = test_conversation(vec![
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, Some("req-1")),
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, Some("req-1")),
            test_message(BRIDGE_MESSAGE_DIRECTION_OUTBOUND, Some("req-out")),
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, None),
        ]);

        assert_eq!(pending_read_receipt_request_ids(&conversation), vec!["req-1".to_string()]);
    }

    #[test]
    fn read_receipt_payload_uses_delivery_event_read_state() {
        let payload = read_receipt_payload("node-me", "req-1");

        assert_eq!(payload["from"], serde_json::json!("node-me"));
        assert_eq!(payload["messageType"], serde_json::json!(BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT));
        assert_eq!(payload["payload"]["requestId"], serde_json::json!("req-1"));
        assert_eq!(payload["payload"]["state"], serde_json::json!(BRIDGE_DELIVERY_STATE_READ));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p kordi-desktop --no-default-features pending_read_receipt_request_ids
```

Expected: FAIL because `pending_read_receipt_request_ids` and `read_receipt_payload` do not exist.

- [ ] **Step 3: Implement helper functions**

In `app/desktop/src-tauri/src/bridge/conversation_actions.rs`, add near `is_realtime_direct_chat(...)`:

```rust
fn pending_read_receipt_request_ids(
    conversation: &DesktopBridgeConversationRecord,
) -> Vec<String> {
    let mut request_ids = conversation
        .messages
        .iter()
        .filter(|message| is_inbound_message_direction(&message.direction))
        .filter_map(|message| message.request_id.as_deref())
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    request_ids.sort();
    request_ids.dedup();
    request_ids
}

fn read_receipt_payload(host_node_id: &str, request_id: &str) -> Value {
    serde_json::json!({
        "from": host_node_id,
        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_READ },
    })
}
```

- [ ] **Step 4: Run Rust tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features pending_read_receipt_request_ids
cargo test -p kordi-desktop --no-default-features read_receipt_payload_uses_delivery_event_read_state
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src-tauri/src/bridge/conversation_actions.rs
git commit -m "Collect bridge read receipt ids"
```

---

### Task 6: Send backend read receipts with relay fallback

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs`

- [ ] **Step 1: Implement send helper**

In `app/desktop/src-tauri/src/bridge/conversation_actions.rs`, add near `relay_with_contact_fallback(...)`:

```rust
async fn send_read_receipt(
    manager: &DesktopBridgeManager,
    context: &ConversationContext,
    request_id: &str,
) -> Result<(), String> {
    let payload = read_receipt_payload(&context.host.node_id, request_id);

    if is_realtime_direct_chat(&context.conversation, &context.host) {
        match send_realtime_payload(
            manager,
            &context.host,
            &context.conversation.peer_node_id,
            &payload,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(realtime_error) => {
                eprintln!(
                    "Bridge read receipt realtime send failed; conversation_id={}, target_node_id={}, request_id={}, error={}",
                    context.conversation.id,
                    context.conversation.peer_node_id,
                    request_id,
                    realtime_error
                );
            }
        }
    }

    relay_with_contact_fallback(context, &payload).await
}
```

- [ ] **Step 2: Update mark-read implementation**

Replace the manual receipt loop in `desktop_bridge_mark_conversation_read_impl(...)` with context resolution:

```rust
let bridge_store = load_bridge_store();
let store = load_conversation_store();
let mut marked_store = None;
if let Ok(context) = resolve_conversation_context(&bridge_store, &store, &conversation_id) {
    let pending_read_receipts = pending_read_receipt_request_ids(&context.conversation);
    for request_id in pending_read_receipts {
        if let Err(error) = send_read_receipt(manager, &context, &request_id).await {
            eprintln!(
                "Bridge read receipt relay send failed; conversation_id={}, target_node_id={}, request_id={}, error={}",
                context.conversation.id,
                context.conversation.peer_node_id,
                request_id,
                error
            );
        }
    }
    marked_store = Some(mark_bridge_conversation_read_in_storage(&conversation_id)?);
}
Ok(build_conversation_only_bridge_state(
    bridge_store,
    marked_store.unwrap_or(store),
    current_local_server_status(manager).await,
))
```

- [ ] **Step 3: Run Rust tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features pending_read_receipt_request_ids
cargo test -p kordi-desktop --no-default-features read_receipt_payload_uses_delivery_event_read_state
```

Expected: pass.

- [ ] **Step 4: Run TypeScript regression tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- tests/bridgeReadReceipts.test.tsx
pnpm --dir app/desktop test:unit -- tests/chatRouting.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src-tauri/src/bridge/conversation_actions.rs
git commit -m "Send bridge read receipts reliably"
```

---

### Task 7: Full verification

**Files:**
- All modified files.

- [ ] **Step 1: Run frontend unit tests**

```bash
pnpm --dir app/desktop test:unit
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck, lint, build**

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
```

Expected: all pass.

- [ ] **Step 3: Run Rust desktop tests**

```bash
cargo test -p kordi-desktop --no-default-features
```

Expected: all tests pass.

- [ ] **Step 4: Check whitespace**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit any verification-only adjustments**

If formatting or small test fixes were needed:

```bash
git add <changed-files>
git commit -m "Stabilize unread read receipt verification"
```

If no changes were needed, do not create an empty commit.

---

### Task 8: Preview in `user1` / `user2` before PR

**Files:**
- Create temporary local-only config under `/tmp` or worktree-local untracked path.
- Do not reset data.

- [ ] **Step 1: Stop existing main preview instances**

From the main repo or feature worktree, stop `user1` and `user2` using the launcher helper without deleting data:

```bash
cd /Users/shuyang/kordi
node --input-type=module <<'NODE'
import { loadMultiInstanceConfig, stopInstance } from './app/desktop/scripts/multi-instance/shared.mjs';
const config = loadMultiInstanceConfig('./app/desktop/scripts/multi-instance/configs/users.yaml', ['user1', 'user2']);
for (const instance of config.users) {
  const result = await stopInstance(instance);
  console.log(`${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : `no running process found (pid ${result.pid ?? 'none'})`}`);
}
NODE
```

Expected: ports 1482 and 1484 are freed.

- [ ] **Step 2: Create feature-worktree preview config pointing at main data**

Create `/tmp/kordi-issue146-users.yaml`:

```yaml
defaults:
  host: 127.0.0.1
  titlePrefix: Kordi Issue 146
  dataRoot: /Users/shuyang/kordi/app/desktop/.multi-instance-data
  logsRoot: /Users/shuyang/kordi/app/desktop/.multi-instance-logs
  runtimeRoot: /Users/shuyang/kordi/app/desktop/.multi-instance-runtime
  bootstrap:
    authSource: shared
    authMode: if-missing

users:
  - id: user1
    port: 1482

  - id: user2
    port: 1484
```

- [ ] **Step 3: Launch previews from feature worktree without reset**

```bash
cd /Users/shuyang/kordi-worktrees/issue-146-unread-read-receipts
pnpm dev:desktop:multi -- --config /tmp/kordi-issue146-users.yaml --users user1,user2
```

Expected: `user1` listens on 1482 and `user2` listens on 1484 with existing data/settings.

- [ ] **Step 4: Manual QA matrix**

Run these checks manually:

```text
1. user1 sends a Bridge/person message to user2 while user2 is on another session/page.
2. user2 sees numeric unread badge 1 on that session.
3. user1 sees sent/delivered checkmark progression.
4. user2 opens the session.
5. user2 unread badge clears.
6. user1 outbound message becomes blue double-check read.
7. Repeat from user2 to user1.
8. Send multiple messages while recipient is elsewhere and confirm badge count increments.
9. Confirm document/window title aggregate count updates and clears.
```

- [ ] **Step 5: Record preview result**

Add a PR-ready note to the final response. Do not commit runtime data/logs.

---

### Task 9: PR preparation

**Files:**
- `.github/pull_request_template.md` as reference only.

- [ ] **Step 1: Ensure issue #146 is linked in PR body**

Use `Closes #146` in the PR body.

- [ ] **Step 2: Push and create PR with template sections**

PR title:

```text
Add unread badges and reliable Bridge read receipts
```

PR body must include:

```md
## Summary
- Preserve unread counts through canonical chat hydration so numeric badges remain visible.
- Send Bridge read receipts from viewed sessions via realtime with relay fallback.
- Render sent/delivered/read message states as WhatsApp-style checkmarks.

## Required issue check
- [x] I found and read the related issue before opening this PR.
- [ ] If no suitable issue existed, I created one first.
- [x] This PR matches the issue acceptance criteria, or I updated/commented on the issue to explain the scope change.

Closes #146

## Type of change
- [x] Bug fix
- [x] Feature
- [x] UX / design polish
- [ ] Infra / CI / tooling
- [ ] Docs
- [ ] Refactor / internal cleanup

## Project board
- Status before merge: Testing
- Tier: T1
- Area: Desktop / Chat / Collaboration

## Implementation notes
- Canonical chat hydration preserves source unread counts.
- Bridge read receipt eligibility no longer depends only on `unreadCount > 0`.
- Backend read receipts try realtime and fall back to relay/mailbox, with diagnostic logs.
- Delivery glyphs use single gray check for sent, gray double check for delivered, blue double check for read/responded.

## Screenshots / recordings
N/A. Manual QA performed in user1/user2 desktop preview instances.

## Validation
- [x] `pnpm --dir app/desktop test:unit`
- [x] `pnpm --dir app/desktop typecheck`
- [x] `pnpm --dir app/desktop lint`
- [x] `pnpm --dir app/desktop build`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -A clippy::never_loop`
- [ ] `cargo test -p kordi-session`
- [ ] `cargo test -p kordi-cli --lib`
- [ ] `cargo test -p kordi-cli desktop_runtime --no-default-features`
- [x] `cargo test -p kordi-desktop --no-default-features`
- [x] `git diff --check`
- [x] Manual QA performed

Manual QA notes:
```text
<fill with user1/user2 preview result from Task 8>
```

## Risk / rollback
Low to medium. Read receipt sends are idempotent and delivery-state ranking is monotonic. Roll back by reverting this PR if unread hydration or Bridge receipt transport regresses.

## Follow-ups
- [x] None
```

- [ ] **Step 3: Request review and merge only after approval**

Run final fresh verification immediately before merge.
