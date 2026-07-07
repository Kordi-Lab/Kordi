# Cloud Unread Self-Message Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate stale unread badges caused by self-addressed Cloud/self-agent messages and cached derived unread state.

**Architecture:** Treat unread as a derived server/read-cursor fact, not durable UI metadata. Server-side, self-addressed Cloud messages are read by definition; client-side, cached messages are normalized relative to the active account and self-authored group controls can never increment unread. Persisted `cloudUnreadCount` is scrubbed on canonical hydration before fresh Cloud sync recomputes real unread.

**Tech Stack:** Rust/Axum/sqlx/Postgres Cloud server; React/TypeScript desktop; SQLite canonical session store; Node test runner and Rust e2e tests.

---

## Evidence Summary

- Production `acct_7ced…` has `0` peer unread rows but `98` self-addressed rows where `from_account_id = to_account_id` and `read_at IS NULL`.
- Public `/v1/cloud/messages?peerAccountId=<self>` returns these self-addressed rows as `direction: "outgoing"`, so the list endpoint is read-neutral.
- The active canonical SQLite DB temporarily had restored self-agent sessions with persisted `metadata.cloudUnreadCount` (`31/25/16/6/2/1`) and no self read markers, matching the screenshot’s stale unread presentation. Those counts later cleared after Cloud reconciliation, proving this is a startup/cache/persisted-derived-state issue.
- Public IM patterns checked:
  - Matrix uses per-room read receipts/fully-read markers; unread is derived after the marker.
  - XMPP chat markers advance a displayed marker by message id.
  - Slack exposes `last_read` plus `unread_count`; unread is server-derived and own messages are not unread.

---

## File Structure

- Modify `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Normalize cached message direction relative to the active account.
  - Preserve cached `sessionId`.
- Modify `app/desktop/src/features/cloud/cloudGroupMessages.ts`
  - Exclude self-authored/self-addressed group controls from unread counts regardless of cached `direction`.
- Modify `app/desktop/src/app/useKordiAppModelHelpers.ts`
  - Add a small helper to strip persisted `cloudUnreadCount` from fetched canonical session metadata.
- Modify `app/desktop/src/app/useKordiAppModel.ts`
  - Run the helper on canonical refresh before setting React state.
- Modify `bridges/cloud-server/src/auth/routes.rs`
  - Insert self-addressed messages with non-null `read_at`.
  - Defensively coalesce self-addressed list results to read.
- Modify `bridges/cloud-server/src/pg/pool.rs`
  - Embed migration 0030.
- Create `bridges/cloud-server/migrations/0030_mark_self_cloud_messages_read.sql`
  - Backfill old self-addressed rows to read.
- Tests:
  - `app/desktop/tests/cloudBridgeState.test.tsx`
  - `app/desktop/tests/cloudGroupMessages.test.tsx`
  - `app/desktop/tests/chatRouting.test.tsx` or a focused canonical helper test if existing coverage is easier.
  - `bridges/cloud-server/tests/cloud_auth_e2e.rs`

---

### Task 1: Client Regression Tests

**Files:**
- Modify: `app/desktop/tests/cloudBridgeState.test.tsx`
- Modify: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Add cached self-message normalization regression**

Add a test in `app/desktop/tests/cloudBridgeState.test.tsx` near the existing Cloud cache tests:

```ts
test('cloud message cache normalizes self-addressed rows as outgoing and preserves session ids', () => {
  const storage = new MemoryStorage();
  const accountId = 'acct_self';
  storage.setItem(`kordi.cloud.messagesByPeer.v1:${accountId}`, JSON.stringify({
    [accountId]: [{
      messageId: 'msg_self_1',
      fromAccountId: accountId,
      toAccountId: accountId,
      body: 'cached self row',
      createdAt: '2026-07-07T18:00:00Z',
      deliveredAt: '2026-07-07T18:00:00Z',
      readAt: null,
      direction: 'incoming',
      sessionId: 'session:self-agent:test',
    }],
  }));

  const loaded = loadCachedCloudMessagesByPeer(accountId, storage);
  assert.equal(loaded[accountId]?.[0]?.direction, 'outgoing');
  assert.equal(loaded[accountId]?.[0]?.sessionId, 'session:self-agent:test');
});
```

- [ ] **Step 2: Add group unread self-authored stale-cache regression**

Add a test in `app/desktop/tests/cloudGroupMessages.test.tsx`:

```ts
test('cloud group unread helper ignores self-authored cached controls even when direction is stale incoming', () => {
  const accountId = 'acct_self';
  const message = cloudGroupMessageNoticeRequest({
    groupId: 'session:group:self-cache',
    groupTitle: 'Self cache',
    createdByAccountId: accountId,
    actor: { accountId, displayName: 'Me', avatarUrl: null },
    participants: [{ accountId, displayName: 'Me', avatarUrl: null }],
    message: {
      id: 'msg_self_group',
      senderAccountId: accountId,
      text: 'hello',
      createdAtMs: 1783440000000,
      senderKind: 'human',
    },
  });

  const unread = cloudGroupUnreadCountsBySessionId({
    accountId,
    messages: [{
      messageId: 'cloud_msg_self_group',
      fromAccountId: accountId,
      toAccountId: accountId,
      body: message.body,
      createdAt: '2026-07-07T18:00:00Z',
      deliveredAt: '2026-07-07T18:00:00Z',
      readAt: null,
      direction: 'incoming',
      sessionId: 'session:group:self-cache',
    }],
  });

  assert.deepEqual(unread, {});
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
cd app/desktop
pnpm tsx --test tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx
```

Expected before implementation: cache test fails because direction remains `incoming` and/or `sessionId` is missing; group unread test fails because self-authored stale incoming rows count unread.

---

### Task 2: Client Cache and Group Unread Fix

**Files:**
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`

- [ ] **Step 1: Normalize cached direction relative to active account**

Change `normalizeCachedCloudMessage` to accept `accountId` and derive direction:

```ts
function normalizeCachedCloudMessage(accountId: string, value: unknown): CloudMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const messageId = cleanText(typeof record.messageId === 'string' ? record.messageId : null);
  const fromAccountId = cleanText(typeof record.fromAccountId === 'string' ? record.fromAccountId : null);
  const toAccountId = cleanText(typeof record.toAccountId === 'string' ? record.toAccountId : null);
  const createdAt = cleanText(typeof record.createdAt === 'string' ? record.createdAt : null);
  if (!messageId || !fromAccountId || !toAccountId || !createdAt) return null;
  if (fromAccountId !== accountId && toAccountId !== accountId) return null;
  const direction = fromAccountId === accountId ? 'outgoing' : 'incoming';
  const attachments = Array.isArray(record.attachments) ? record.attachments as CloudMessage['attachments'] : undefined;
  const sessionId = cleanText(typeof record.sessionId === 'string' ? record.sessionId : null);
  return {
    messageId,
    fromAccountId,
    toAccountId,
    body: typeof record.body === 'string' ? record.body : '',
    createdAt,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : null,
    readAt: typeof record.readAt === 'string' ? record.readAt : null,
    direction,
    ...(sessionId ? { sessionId } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}
```

Update the caller:

```ts
const normalized = messages
  .map((message) => normalizeCachedCloudMessage(trimmedAccountId, message))
  .filter((item): item is CloudMessage => Boolean(item));
```

- [ ] **Step 2: Ignore self-authored group controls for unread**

In `cloudGroupUnreadCountsBySessionId`, after parsing the envelope and before `shouldCountCloudGroupMessageUnread`, add:

```ts
if (message.fromAccountId === accountId || envelope.message?.senderAccountId === accountId) continue;
```

Apply the same guard in `cloudGroupMessageReadTargets` so stale self-authored rows are not sent to the server as read work:

```ts
if (message.fromAccountId === accountId || envelope.message?.senderAccountId === accountId) continue;
```

- [ ] **Step 3: Run client tests**

Run:

```bash
cd app/desktop
pnpm tsx --test tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx
pnpm typecheck
```

Expected: all tests pass.

---

### Task 3: Scrub Persisted Derived `cloudUnreadCount` on Canonical Hydration

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModelHelpers.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Test: `app/desktop/tests/chatRouting.test.tsx`

- [ ] **Step 1: Add helper test**

Add a focused test that verifies stale `cloudUnreadCount` is removed before initial render can use it:

```ts
test('canonical hydration strips persisted derived cloud unread counts', () => {
  const state = canonicalStateFixture({
    sessions: [{
      id: 'session:self-agent:test',
      kind: 'self-agent',
      title: 'Self chat',
      metadata: { cloudUnreadCount: 82, keep: 'value' },
    }],
  });

  const scrubbed = stripDerivedCloudUnreadCounts(state);
  assert.equal(scrubbed?.sessions[0]?.metadata?.cloudUnreadCount, undefined);
  assert.equal(scrubbed?.sessions[0]?.metadata?.keep, 'value');
});
```

If `canonicalStateFixture` does not exist in `chatRouting.test.tsx`, construct the minimal `CanonicalSessionState` object inline using the same shape as neighboring tests.

- [ ] **Step 2: Add helper**

In `app/desktop/src/app/useKordiAppModelHelpers.ts`:

```ts
export function stripDerivedCloudUnreadCounts(state: CanonicalSessionState | null): CanonicalSessionState | null {
  if (!state) return state;
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const metadata = canonicalMetadataRecord(session.metadata);
    if (!Object.prototype.hasOwnProperty.call(metadata, 'cloudUnreadCount')) return session;
    changed = true;
    delete metadata.cloudUnreadCount;
    return { ...session, metadata };
  });
  return changed ? { ...state, sessions } : state;
}
```

- [ ] **Step 3: Use helper during canonical refresh**

In `app/desktop/src/app/useKordiAppModel.ts`, import `stripDerivedCloudUnreadCounts` and change refresh to:

```ts
const fetchedCanonicalState = stripDerivedCloudUnreadCounts(await fetchCanonicalSessionState());
setCanonicalSessionState((current) => mergeCanonicalStatePreservingBridgeUiMessages(fetchedCanonicalState, current));
```

This makes `cloudUnreadCount` ephemeral: it can be reintroduced only by fresh Cloud unread computation in the current process.

- [ ] **Step 4: Run tests**

Run:

```bash
cd app/desktop
pnpm tsx --test tests/chatRouting.test.tsx tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx
pnpm typecheck
```

Expected: all tests pass.

---

### Task 4: Server Self-Addressed Messages Are Read by Definition

**Files:**
- Create: `bridges/cloud-server/migrations/0030_mark_self_cloud_messages_read.sql`
- Modify: `bridges/cloud-server/src/pg/pool.rs`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Add migration**

Create `bridges/cloud-server/migrations/0030_mark_self_cloud_messages_read.sql`:

```sql
UPDATE cloud_messages
SET read_at = COALESCE(read_at, delivered_at, created_at)
WHERE from_account_id = to_account_id
  AND read_at IS NULL;

INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'peer',
    to_account_id,
    MAX(COALESCE(read_at, delivered_at, created_at)),
    MAX(COALESCE(read_at, delivered_at, created_at))
FROM cloud_messages
WHERE from_account_id = to_account_id
GROUP BY to_account_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = GREATEST(cloud_read_cursors.read_at, EXCLUDED.read_at),
    updated_at = EXCLUDED.updated_at;

INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'session',
    session_id,
    MAX(COALESCE(read_at, delivered_at, created_at)),
    MAX(COALESCE(read_at, delivered_at, created_at))
FROM cloud_messages
WHERE from_account_id = to_account_id
  AND session_id IS NOT NULL
  AND session_id <> ''
GROUP BY to_account_id, session_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = GREATEST(cloud_read_cursors.read_at, EXCLUDED.read_at),
    updated_at = EXCLUDED.updated_at;
```

- [ ] **Step 2: Embed migration**

In `bridges/cloud-server/src/pg/pool.rs`, add:

```rust
EmbeddedMigration {
    version: 30,
    description: "mark self cloud messages read",
    sql: include_str!("../../migrations/0030_mark_self_cloud_messages_read.sql"),
},
```

- [ ] **Step 3: Write server e2e test**

In `bridges/cloud-server/tests/cloud_auth_e2e.rs`, add:

```rust
#[tokio::test]
async fn self_addressed_messages_are_returned_outgoing_and_read() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("self-read"), "correct horse"),
        ))
        .await
        .unwrap();
    let body = read_json(signup).await;
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();

    let send = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": account_id,
                "body": "private self row",
                "sessionId": "session:self-agent:test"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(send.status(), StatusCode::CREATED);
    let sent = read_json(send).await;
    assert_eq!(sent["message"]["direction"], "outgoing");
    assert!(sent["message"]["readAt"].as_str().is_some());

    let list = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let listed = read_json(list).await;
    let message = listed["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(message["direction"], "outgoing");
    assert!(message["readAt"].as_str().is_some());
}
```

- [ ] **Step 4: Implement self-read send/list semantics**

In the message insert path in `bridges/cloud-server/src/auth/routes.rs`, when `peer == session.account_id`, set `read_at` to the delivered timestamp during insert and in the returned `MessageSummary`:

```rust
let read_at = if peer == session.account_id {
    Some(delivered_at.clone())
} else {
    None
};
```

Use `read_at` in the INSERT column list and bind values:

```sql
INSERT INTO cloud_messages
(message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at, session_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
```

Set the summary field:

```rust
read_at,
```

In `list_messages`, defensively coalesce self-addressed rows:

```sql
COALESCE(read_at,
    CASE
        WHEN from_account_id = $1 AND to_account_id = $1
        THEN COALESCE(delivered_at, created_at)
    END,
    ...existing cursor cases...
) AS read_at
```

- [ ] **Step 5: Run server tests**

Run from repo root:

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e
cargo check -p kordi-cloud-server
```

Expected: all tests pass.

---

### Task 5: Full Verification and Deployment Prep

**Files:** no source changes beyond previous tasks.

- [ ] **Step 1: Run desktop verification**

```bash
cd app/desktop
pnpm tsx --test tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx tests/chatRouting.test.tsx tests/canonicalBridgeRuntimeReadModel.test.tsx
pnpm typecheck
```

Expected: all tests pass.

- [ ] **Step 2: Run server verification**

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e
cargo check -p kordi-cloud-server
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Preview before merge**

Launch a preserved-data preview against `https://coordinar.io` and verify:

```bash
cd app/desktop
VITE_KORDI_CLOUD_API_BASE=https://coordinar.io pnpm tauri:dev:instance -- --instance unread-self-reconciliation-preview --port 1524 --title 'Kordi Unread Reconciliation Preview'
```

Expected:
- Startup does not show stale self-agent unread badges.
- Contact unread reflects only genuine peer/group unread after Cloud sync.
- Opening a self-agent/private Cloud session does not create unread on fresh login.

- [ ] **Step 4: Production deploy after approval**

Because this includes a server migration, follow hosted schema deploy Path D:

```bash
bridges/cloud-server/deploy/sync-and-build.sh
bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Then verify:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=60s
curl -fsS https://coordinar.io/health
```

Expected:
- Rollout succeeds.
- Health returns `{"ok":true,"server":"kordi-cloud"}`.
- `cloud_schema_migrations` includes version `30`.
- `SELECT count(*) FROM cloud_messages WHERE from_account_id = to_account_id AND read_at IS NULL;` is `0` or limited to rows created by older pods before rollout completion.

---

## Self-Review

- Spec coverage: addresses screenshot stale unread, compares IM read-marker patterns, fixes client cache, persisted derived unread, server semantics, and production migration.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: uses existing `CloudMessage`, `CanonicalSessionState`, `cloudUnreadCount`, `read_at/readAt`, and migration embedding conventions.
