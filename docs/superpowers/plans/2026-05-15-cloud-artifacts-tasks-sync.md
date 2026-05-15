# Cloud Artifacts + Tasks Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #342 so Cloud Edition chat/group/fork sessions show the Tasks panel and sync task/artifact activity across session participants.

**Architecture:** Add Cloud-native task/artifact mutation records on the cloud-server, expose account-scoped sync events through the existing `/v1/cloud/sync` cursor stream, and hydrate those records into desktop Cloud conversations without localhost Bridge DB/runtime writes. The first slice restores the Tasks tab immediately; later slices add server persistence/fanout, client normalization/caching, right-rail hydration, and fork snapshots.

**Tech Stack:** Rust/Axum/sqlx/Postgres for `bridges/cloud-server`; TypeScript/React/Vite for `app/desktop`; existing Cloud sync/event modules, `TaskActivityDashboardPanel`, `ArtifactInspector`, and attachment blob storage.

---

## File Structure

- Modify `app/desktop/src/app/assembleRightDetailSlot.tsx` — remove Cloud-only task tab filtering and keep active tab valid.
- Add/modify `app/desktop/tests/rightDetailRailCloudTasks.test.tsx` — regression for Cloud chat/group/fork Tasks tab visibility.
- Add `bridges/cloud-server/migrations/0013_cloud_session_activity.sql` — task/artifact activity tables and indexes.
- Modify `bridges/cloud-server/src/auth/routes.rs` — add request/response structs and endpoints for session task/artifact activity; write `cloud_sync_events` rows.
- Modify `bridges/cloud-server/src/events/mod.rs` — optional live NATS event for Cloud activity changes.
- Modify `app/desktop/src/features/cloud/authClient.ts` — add Cloud task/artifact types and client methods.
- Add `app/desktop/src/features/cloud/cloudSessionActivity.ts` — normalization, idempotent merge, cache helpers, and conversion to UI shapes.
- Modify `app/desktop/src/features/cloud/cloudDiffSync.ts` — apply `task.upsert`, `artifact.upsert`, and `artifact.archived` sync events.
- Modify `app/desktop/src/features/cloud/useCloudBridgeState.ts` — own synced Cloud activity state; expose records and methods.
- Modify `app/desktop/src/app/useKordiAppModel.ts` and `app/desktop/src/app/useKordiDesktopActivity.ts` — merge Cloud activity into active artifacts/tasks.
- Modify `app/desktop/src/features/cloud/cloudBridgeState.ts` or a focused helper — attach Cloud task activity to generated Cloud conversations.
- Modify `app/desktop/src/features/chat/messageActions/chatMessages.ts` — after local Cloud agent turns complete, publish derived task/artifact activity to Cloud.
- Modify `app/desktop/src/features/chat/taskActivityDashboard.ts` only if needed to accept synced task activities without synthetic tool turns; prefer adapter in `cloudSessionActivity.ts` first.
- Modify fork paths in `app/desktop/src/features/chat/useDesktopSessionController.ts`, `app/desktop/src/features/cloud/useCloudBridgeState.ts`, and server fork endpoint in `routes.rs` — snapshot activity rows to fork sessions.
- Add/modify tests:
  - `app/desktop/tests/cloudSessionActivity.test.ts`
  - `app/desktop/tests/cloudDiffSync.test.tsx`
  - `app/desktop/tests/cloudBridgeState.test.tsx`
  - `app/desktop/tests/chatDetailPanel.test.tsx`
  - `bridges/cloud-server` unit tests in `routes.rs` test module.

---

### Task 1: Restore Cloud Tasks tab in the right rail

**Files:**
- Modify: `app/desktop/src/app/assembleRightDetailSlot.tsx`
- Test: `app/desktop/tests/rightDetailRailCloudTasks.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/desktop/tests/rightDetailRailCloudTasks.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleRightDetailSlot } from '../src/app/assembleRightDetailSlot';
import type { RightDetailShellArgs } from '../src/app/kordiShellSlots.types';

function baseArgs(overrides: Partial<RightDetailShellArgs> = {}): RightDetailShellArgs {
  return {
    isNativeShell: true,
    activeNav: 'chats',
    activeDetailTab: 'info',
    setActiveDetailTab: () => {},
    activeSourcePreview: null,
    setActiveSourcePreview: () => {},
    activeArtifactId: null,
    setActiveArtifactId: () => {},
    activeChatArtifacts: [],
    activeProjectArtifacts: [],
    activeProject: {
      id: 'project:one', name: 'Project', summary: '', bridge: 'Local', scope: '/tmp', status: 'Local',
      people: [], agents: [], pendingInvites: [], artifacts: 0, tasks: 0, root: '/tmp', sessions: [],
    },
    activeProjectSession: {
      id: 'session:project:one', name: 'Project chat', summary: '', lastActive: '--:--', status: 'Active',
      participants: [], artifacts: 0, tasks: 0, messages: [],
    },
    activeProjectLastMessage: undefined,
    activeProjectBridgeHost: null,
    activeProjectBridgeProject: null,
    isProjectBridgeBusy: false,
    bridgeInvite: null,
    handleCreateProjectBridgeInvite: async () => {},
    setActiveNav: () => {},
    setActiveConvId: () => {},
    getStatusBadgeClass: () => 'app-badge-neutral',
    desktopLiveTurn: null,
    activeConv: {
      id: 'session:group:cloud-one',
      canonicalSessionId: 'session:group:cloud-one',
      name: 'Cloud group',
      type: 'person',
      subtitle: 'session:group:cloud-one',
      unread: 0,
      bridges: ['Cloud'],
      trust: 'Cloud',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: undefined,
    activeConversationIsBridge: true,
    activeBridgeConversationHost: null,
    activeBridgeConversation: null,
    activeBridgeAwaitingReply: false,
    isBridgePolling: false,
    lastBridgePollAtLabel: null,
    activeSessionProject: null,
    activeQueuedDesktopMessages: [],
    chatTranscriptScrollRef: { current: null },
    ...overrides,
  };
}

test('Cloud Edition chat right rail includes the Tasks tab', () => {
  globalThis.window = {
    __KORDI_BOOTSTRAP__: { edition: 'cloud', title: 'Kordi Cloud' },
    location: { search: '?edition=cloud' },
  } as unknown as Window & typeof globalThis;
  globalThis.document = { title: 'Kordi Cloud' } as unknown as Document;

  const markup = renderToStaticMarkup(createElement(() => assembleRightDetailSlot(baseArgs())));

  assert.match(markup, /Info/);
  assert.match(markup, /Artifacts/);
  assert.match(markup, /Tasks/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/rightDetailRailCloudTasks.test.tsx
```

Expected: FAIL because `Tasks` is filtered out in Cloud Edition.

- [ ] **Step 3: Write minimal implementation**

In `app/desktop/src/app/assembleRightDetailSlot.tsx`, remove the `currentKordiEdition` import and replace:

```ts
  const isCloudEdition = currentKordiEdition() === 'cloud';
  const allDetailTabs: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = args.activeNav === 'chats'
```

with:

```ts
  const allDetailTabs: Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }> = args.activeNav === 'chats'
```

Then replace:

```ts
  const detailTabs = allDetailTabs.filter((tab) => !(isCloudEdition && tab.id === 'tasks'));
```

with:

```ts
  const detailTabs = allDetailTabs;
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/rightDetailRailCloudTasks.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/app/assembleRightDetailSlot.tsx app/desktop/tests/rightDetailRailCloudTasks.test.tsx
git commit -m "Show Cloud task tab in chat rail"
```

---

### Task 2: Add Cloud session activity schema

**Files:**
- Create: `bridges/cloud-server/migrations/0013_cloud_session_activity.sql`
- Test: `bridges/cloud-server/src/auth/routes.rs` test module, if migration tests already exist use them; otherwise schema is verified by server tests in Task 3.

- [ ] **Step 1: Write migration**

Create `bridges/cloud-server/migrations/0013_cloud_session_activity.sql`:

```sql
-- Cloud-native session activity records for artifacts and task rows.
-- Rows are session-scoped and participant-visible; sync fanout is via
-- account-scoped cloud_sync_events.

CREATE TABLE IF NOT EXISTS cloud_session_tasks (
    task_activity_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    target_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    participants_json JSONB NOT NULL,
    artifact_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    response_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (session_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_tasks_session_updated
    ON cloud_session_tasks (session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_session_tasks_creator_updated
    ON cloud_session_tasks (created_by_account_id, updated_at);

CREATE TABLE IF NOT EXISTS cloud_session_artifacts (
    artifact_activity_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    source_message_id TEXT,
    attachment_id TEXT REFERENCES cloud_attachments(attachment_id) ON DELETE SET NULL,
    content_type TEXT,
    size_bytes BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (session_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_artifacts_session_updated
    ON cloud_session_artifacts (session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_session_artifacts_creator_updated
    ON cloud_session_artifacts (created_by_account_id, updated_at);
```

- [ ] **Step 2: Run server compile to verify migration syntax is discoverable**

Run:

```bash
cargo check -p kordi-cloud-server --lib
```

Expected: PASS. If sqlx compile-time migration embedding is not enabled, this still verifies no Rust breakage; SQL syntax is exercised in Task 3 tests.

- [ ] **Step 3: Commit**

```bash
git add bridges/cloud-server/migrations/0013_cloud_session_activity.sql
git commit -m "Add Cloud session activity schema"
```

---

### Task 3: Add cloud-server activity upsert/list/fork fanout helpers

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `bridges/cloud-server/src/events/mod.rs`
- Test: `bridges/cloud-server/src/auth/routes.rs` test module

- [ ] **Step 1: Write failing helper tests**

In the existing `#[cfg(test)]` module in `bridges/cloud-server/src/auth/routes.rs`, add tests for pure payload/fanout helpers before writing endpoint code:

```rust
#[test]
fn task_activity_sync_payload_keeps_session_and_task_identity() {
    let task = CloudTaskActivitySummary {
        task_activity_id: "taskact_1".to_string(),
        session_id: "session:group:one".to_string(),
        task_id: "task_1".to_string(),
        title: "Review launch plan".to_string(),
        summary: Some("Check risks".to_string()),
        status: "active".to_string(),
        created_by_account_id: "acct_a".to_string(),
        target_account_id: Some("acct_b".to_string()),
        participants: vec![serde_json::json!({"accountId":"acct_a","displayName":"Alice"})],
        artifact_ids: vec!["docs/plan.md".to_string()],
        response_message_id: Some("msg_response".to_string()),
        created_at: "2026-05-15T10:00:00Z".to_string(),
        updated_at: "2026-05-15T10:01:00Z".to_string(),
        archived_at: None,
    };

    let payload = task_activity_sync_payload(&task);

    assert_eq!(payload["task"]["sessionId"], "session:group:one");
    assert_eq!(payload["task"]["taskId"], "task_1");
    assert_eq!(payload["task"]["artifactIds"][0], "docs/plan.md");
}

#[test]
fn artifact_activity_sync_payload_keeps_attachment_reference() {
    let artifact = CloudArtifactActivitySummary {
        artifact_activity_id: "artifactact_1".to_string(),
        session_id: "session:group:one".to_string(),
        artifact_id: "docs/plan.md".to_string(),
        name: "plan.md".to_string(),
        path: "docs/plan.md".to_string(),
        kind: "document".to_string(),
        category: "artifact".to_string(),
        summary: Some("Generated plan".to_string()),
        created_by_account_id: "acct_a".to_string(),
        source_message_id: Some("msg_response".to_string()),
        attachment_id: Some("att_1".to_string()),
        content_type: Some("text/markdown".to_string()),
        size_bytes: Some(42),
        created_at: "2026-05-15T10:00:00Z".to_string(),
        updated_at: "2026-05-15T10:01:00Z".to_string(),
        archived_at: None,
    };

    let payload = artifact_activity_sync_payload(&artifact);

    assert_eq!(payload["artifact"]["sessionId"], "session:group:one");
    assert_eq!(payload["artifact"]["artifactId"], "docs/plan.md");
    assert_eq!(payload["artifact"]["attachmentId"], "att_1");
}

#[test]
fn cloud_activity_recipient_ids_exclude_duplicates_and_empty_values() {
    let recipients = cloud_activity_recipient_ids(
        "acct_owner",
        &["acct_b".to_string(), "acct_owner".to_string(), " ".to_string(), "acct_b".to_string()],
    );

    assert_eq!(recipients, vec!["acct_b".to_string(), "acct_owner".to_string()]);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p kordi-cloud-server task_activity_sync_payload_keeps_session_and_task_identity artifact_activity_sync_payload_keeps_attachment_reference cloud_activity_recipient_ids_exclude_duplicates_and_empty_values --lib
```

Expected: FAIL because the structs/helpers do not exist.

- [ ] **Step 3: Add summary structs and payload helpers**

In `routes.rs`, near `MessageSummary`, add serializable structs:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskActivitySummary {
    task_activity_id: String,
    session_id: String,
    task_id: String,
    title: String,
    summary: Option<String>,
    status: String,
    created_by_account_id: String,
    target_account_id: Option<String>,
    participants: Vec<serde_json::Value>,
    artifact_ids: Vec<String>,
    response_message_id: Option<String>,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudArtifactActivitySummary {
    artifact_activity_id: String,
    session_id: String,
    artifact_id: String,
    name: String,
    path: String,
    kind: String,
    category: String,
    summary: Option<String>,
    created_by_account_id: String,
    source_message_id: Option<String>,
    attachment_id: Option<String>,
    content_type: Option<String>,
    size_bytes: Option<i64>,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

fn task_activity_sync_payload(task: &CloudTaskActivitySummary) -> serde_json::Value {
    serde_json::json!({ "task": task })
}

fn artifact_activity_sync_payload(artifact: &CloudArtifactActivitySummary) -> serde_json::Value {
    serde_json::json!({ "artifact": artifact })
}

fn cloud_activity_recipient_ids(owner_account_id: &str, participant_account_ids: &[String]) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    for value in participant_account_ids {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            ids.insert(trimmed.to_string());
        }
    }
    let owner = owner_account_id.trim();
    if !owner.is_empty() {
        ids.insert(owner.to_string());
    }
    ids.into_iter().collect()
}
```

- [ ] **Step 4: Add request/response structs**

In `routes.rs`, near other request structs, add:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertCloudTaskActivityRequest {
    session_id: String,
    task_id: String,
    title: String,
    summary: Option<String>,
    status: String,
    target_account_id: Option<String>,
    participant_account_ids: Vec<String>,
    participants: Vec<serde_json::Value>,
    artifact_ids: Vec<String>,
    response_message_id: Option<String>,
    client_updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertCloudArtifactActivityRequest {
    session_id: String,
    artifact_id: String,
    name: String,
    path: String,
    kind: String,
    category: String,
    summary: Option<String>,
    participant_account_ids: Vec<String>,
    source_message_id: Option<String>,
    attachment_id: Option<String>,
    content_type: Option<String>,
    size_bytes: Option<i64>,
    client_updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCloudSessionActivityQuery {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskActivityResponse {
    task: CloudTaskActivitySummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudArtifactActivityResponse {
    artifact: CloudArtifactActivitySummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSessionActivityResponse {
    tasks: Vec<CloudTaskActivitySummary>,
    artifacts: Vec<CloudArtifactActivitySummary>,
}
```

- [ ] **Step 5: Add routes**

In `cloud_auth_router`, add:

```rust
.route("/v1/cloud/session-activity", get(list_cloud_session_activity))
.route("/v1/cloud/session-activity/tasks", post(upsert_cloud_task_activity))
.route("/v1/cloud/session-activity/artifacts", post(upsert_cloud_artifact_activity))
```

- [ ] **Step 6: Implement endpoint validation and SQL upserts**

Add endpoint functions that:

1. Trim `session_id`, `task_id`/`artifact_id`, `title`/`name`, `status`.
2. Reject empty required fields with `StatusCode::BAD_REQUEST` and `errorCode = "invalid_session_activity"`.
3. Use `client_updated_at` if valid RFC3339, otherwise `Utc::now().to_rfc3339()`.
4. Upsert by `(session_id, task_id)` or `(session_id, artifact_id)`.
5. Use `WHERE cloud_session_tasks.updated_at <= EXCLUDED.updated_at` and same for artifacts to make stale writes no-ops.
6. Query the resulting row into the summary struct.
7. Append sync events for `cloud_activity_recipient_ids(&session.account_id, &req.participant_account_ids)` with event types `task.upsert` and `artifact.upsert`.
8. Return JSON summary.

Use this SQL shape for tasks:

```rust
query(
    "INSERT INTO cloud_session_tasks \
     (task_activity_id, session_id, task_id, title, summary, status, created_by_account_id, \
      target_account_id, participants_json, artifact_ids_json, response_message_id, created_at, updated_at) \
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) \
     ON CONFLICT (session_id, task_id) DO UPDATE SET \
       title = EXCLUDED.title, summary = EXCLUDED.summary, status = EXCLUDED.status, \
       target_account_id = EXCLUDED.target_account_id, participants_json = EXCLUDED.participants_json, \
       artifact_ids_json = EXCLUDED.artifact_ids_json, response_message_id = EXCLUDED.response_message_id, \
       updated_at = EXCLUDED.updated_at \
     WHERE cloud_session_tasks.updated_at <= EXCLUDED.updated_at",
)
```

Use analogous SQL for artifacts.

- [ ] **Step 7: Add list endpoint**

`list_cloud_session_activity` should query non-archived rows for the requested `session_id`:

```sql
SELECT ... FROM cloud_session_tasks WHERE session_id = $1 AND archived_at IS NULL ORDER BY updated_at ASC, task_id ASC
SELECT ... FROM cloud_session_artifacts WHERE session_id = $1 AND archived_at IS NULL ORDER BY updated_at ASC, artifact_id ASC
```

- [ ] **Step 8: Add fork copy helper**

In `create_session_fork`, after fork row creation, copy rows from source session to fork session:

```sql
INSERT INTO cloud_session_tasks (..., session_id, ..., created_at, updated_at)
SELECT 'taskact_' || replace(gen_random_uuid()::text, '-', ''), $2, task_id, title, summary, status,
       created_by_account_id, target_account_id, participants_json, artifact_ids_json,
       response_message_id, created_at, $3
FROM cloud_session_tasks
WHERE session_id = $1 AND archived_at IS NULL
ON CONFLICT (session_id, task_id) DO NOTHING
```

Use the same pattern for artifacts. If `gen_random_uuid()` is unavailable in the current DB, use Rust-side row loading and `uuid::Uuid::new_v4().simple()` IDs instead.

- [ ] **Step 9: Run server tests**

Run:

```bash
cargo test -p kordi-cloud-server --lib
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/src/events/mod.rs
git commit -m "Add Cloud session activity API"
```

---

### Task 4: Add desktop Cloud activity types, client methods, and merge helpers

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Create: `app/desktop/src/features/cloud/cloudSessionActivity.ts`
- Test: `app/desktop/tests/cloudSessionActivity.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/cloudSessionActivity.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudActivityStorageKey,
  cloudArtifactToSessionArtifact,
  cloudTaskToSessionTaskActivity,
  mergeCloudSessionActivity,
  normalizeCloudSessionActivitySnapshot,
} from '../src/features/cloud/cloudSessionActivity';

test('mergeCloudSessionActivity keeps newer task and artifact rows by session id', () => {
  const current = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'old', sessionId: 'session:group:1', taskId: 'task-1', title: 'Old', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: [], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
    artifacts: [{ artifactActivityId: 'artifact-old', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', createdByAccountId: 'acct_a', createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
  });
  const incoming = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'new', sessionId: 'session:group:1', taskId: 'task-1', title: 'New', status: 'complete', createdByAccountId: 'acct_a', participants: [], artifactIds: ['docs/a.md'], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z' }],
    artifacts: [{ artifactActivityId: 'artifact-new', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', createdByAccountId: 'acct_a', createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z' }],
  });

  const merged = mergeCloudSessionActivity(current, incoming);

  assert.equal(merged.tasksBySessionId['session:group:1']?.[0]?.title, 'New');
  assert.equal(merged.artifactsBySessionId['session:group:1']?.[0]?.artifactActivityId, 'artifact-new');
});

test('cloud task rows adapt to SessionTaskActivity and artifact rows adapt to SessionArtifact', () => {
  const task = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review plan', status: 'active', createdByAccountId: 'acct_a', participants: [{ accountId: 'acct_a', displayName: 'Alice' }], artifactIds: ['docs/plan.md'], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z' }],
    artifacts: [],
  }).tasksBySessionId['session:group:1']![0];
  const artifact = normalizeCloudSessionActivitySnapshot({
    tasks: [],
    artifacts: [{ artifactActivityId: 'artifactact_1', sessionId: 'session:group:1', artifactId: 'docs/plan.md', name: 'plan.md', path: 'docs/plan.md', kind: 'document', category: 'artifact', summary: 'Generated plan', createdByAccountId: 'acct_a', createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z' }],
  }).artifactsBySessionId['session:group:1']![0];

  assert.equal(cloudTaskToSessionTaskActivity(task).target?.name, 'Review plan');
  assert.equal(cloudArtifactToSessionArtifact(artifact).id, 'docs/plan.md');
  assert.equal(cloudActivityStorageKey('acct_a'), 'kordi.cloud.sessionActivity.v1:acct_a');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudSessionActivity.test.ts
```

Expected: FAIL because module/functions do not exist.

- [ ] **Step 3: Add auth client types and methods**

In `authClient.ts`, add exported types mirroring server camelCase fields:

```ts
export type CloudTaskActivity = {
  taskActivityId: string;
  sessionId: string;
  taskId: string;
  title: string;
  summary: string | null;
  status: string;
  createdByAccountId: string;
  targetAccountId: string | null;
  participants: unknown[];
  artifactIds: string[];
  responseMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudArtifactActivity = {
  artifactActivityId: string;
  sessionId: string;
  artifactId: string;
  name: string;
  path: string;
  kind: 'code' | 'document' | 'file' | string;
  category: 'artifact' | 'related' | 'memory' | string;
  summary: string | null;
  createdByAccountId: string;
  sourceMessageId: string | null;
  attachmentId: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudSessionActivity = { tasks: CloudTaskActivity[]; artifacts: CloudArtifactActivity[] };
```

Add methods:

```ts
async listSessionActivity(token: string, sessionId: string): Promise<CloudSessionActivity> { ... }
async upsertTaskActivity(token: string, input: Omit<CloudTaskActivity, 'taskActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & { participantAccountIds: string[]; clientUpdatedAt?: string | null }): Promise<CloudTaskActivity> { ... }
async upsertArtifactActivity(token: string, input: Omit<CloudArtifactActivity, 'artifactActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & { participantAccountIds: string[]; clientUpdatedAt?: string | null }): Promise<CloudArtifactActivity> { ... }
```

- [ ] **Step 4: Implement `cloudSessionActivity.ts`**

Create module with:

```ts
import type { CloudArtifactActivity, CloudSessionActivity, CloudTaskActivity } from './authClient';
import type { SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';

export type CloudSessionActivityStore = {
  tasksBySessionId: Record<string, CloudTaskActivity[]>;
  artifactsBySessionId: Record<string, CloudArtifactActivity[]>;
};

export function cloudActivityStorageKey(accountId: string) {
  return `kordi.cloud.sessionActivity.v1:${accountId.trim()}`;
}
```

Implement normalization helpers that drop rows without `sessionId` or `taskId`/`artifactId`, coerce nullable strings, and sort rows by `updatedAt` descending.

Implement:

```ts
export function normalizeCloudSessionActivitySnapshot(snapshot: CloudSessionActivity): CloudSessionActivityStore
export function mergeCloudSessionActivity(current: CloudSessionActivityStore, incoming: CloudSessionActivityStore): CloudSessionActivityStore
export function cloudTaskToSessionTaskActivity(task: CloudTaskActivity): SessionTaskActivity
export function cloudArtifactToSessionArtifact(artifact: CloudArtifactActivity): SessionArtifact
export function loadCachedCloudSessionActivity(accountId: string | null | undefined, storage?: Storage | null): CloudSessionActivityStore
export function saveCachedCloudSessionActivity(accountId: string | null | undefined, store: CloudSessionActivityStore, storage?: Storage | null): void
```

Adapter rule for `cloudTaskToSessionTaskActivity`: create `target` as an agent-like participant with `id = task:${task.taskId}`, `name = task.title`, `kind = 'agent'`, `role = 'external-agent'`, `avatarKey = task.createdByAccountId`; include normalized participants from `task.participants` as the participant list.

Adapter rule for `cloudArtifactToSessionArtifact`: use `artifact.artifactId` as `id`, `artifact.path` as `path`, `artifact.name` as `name`, pass through `kind`, `category`, `summary`, and set `timeLabel` using `formatDesktopLastActiveLabel(Date.parse(artifact.updatedAt))`.

- [ ] **Step 5: Run tests**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudSessionActivity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/features/cloud/authClient.ts app/desktop/src/features/cloud/cloudSessionActivity.ts app/desktop/tests/cloudSessionActivity.test.ts
git commit -m "Add Cloud session activity client model"
```

---

### Task 5: Apply Cloud activity sync events through diff sync

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudDiffSync.ts`
- Test: `app/desktop/tests/cloudDiffSync.test.tsx`

- [ ] **Step 1: Write failing tests**

Append to `cloudDiffSync.test.tsx`:

```ts
import { applyCloudSyncEventsToSessionActivity } from '../src/features/cloud/cloudDiffSync';

test('cloud diff sync applies task and artifact upsert events', () => {
  const next = applyCloudSyncEventsToSessionActivity({ tasksBySessionId: {}, artifactsBySessionId: {} }, [{
    eventId: '1',
    eventType: 'task.upsert',
    peerAccountId: null,
    messageId: null,
    occurredAt: '2026-05-15T10:00:00Z',
    payload: { task: { taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: [], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' } },
  }, {
    eventId: '2',
    eventType: 'artifact.upsert',
    peerAccountId: null,
    messageId: null,
    occurredAt: '2026-05-15T10:00:00Z',
    payload: { artifact: { artifactActivityId: 'artifactact_1', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', createdByAccountId: 'acct_a', createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' } },
  }]);

  assert.equal(next.tasksBySessionId['session:group:1']?.[0]?.taskId, 'task-1');
  assert.equal(next.artifactsBySessionId['session:group:1']?.[0]?.artifactId, 'docs/a.md');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudDiffSync.test.tsx
```

Expected: FAIL because `applyCloudSyncEventsToSessionActivity` does not exist.

- [ ] **Step 3: Implement event application**

In `cloudDiffSync.ts`, import cloud activity helpers and add:

```ts
export function applyCloudSyncEventsToSessionActivity(
  current: CloudSessionActivityStore,
  events: CloudSyncEvent[],
): CloudSessionActivityStore {
  let next = current;
  for (const event of events) {
    const payload = objectRecord(event.payload);
    if (event.eventType === 'task.upsert') {
      next = mergeCloudSessionActivity(next, normalizeCloudSessionActivitySnapshot({ tasks: [payload?.task].filter(Boolean) as CloudTaskActivity[], artifacts: [] }));
    }
    if (event.eventType === 'artifact.upsert') {
      next = mergeCloudSessionActivity(next, normalizeCloudSessionActivitySnapshot({ tasks: [], artifacts: [payload?.artifact].filter(Boolean) as CloudArtifactActivity[] }));
    }
    if (event.eventType === 'artifact.archived') {
      // Treat archived payload as an artifact with archivedAt set; merge helper should omit archived rows from UI adapters.
      next = mergeCloudSessionActivity(next, normalizeCloudSessionActivitySnapshot({ tasks: [], artifacts: [payload?.artifact].filter(Boolean) as CloudArtifactActivity[] }));
    }
  }
  return next;
}
```

Then extend `syncCloudDiffOnce` input/result to optionally carry `sessionActivity` and return updated `sessionActivity` while preserving existing callers:

```ts
sessionActivity?: CloudSessionActivityStore;
```

If omitted, default to `{ tasksBySessionId: {}, artifactsBySessionId: {} }`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudDiffSync.test.tsx tests/cloudSessionActivity.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/cloud/cloudDiffSync.ts app/desktop/tests/cloudDiffSync.test.tsx
git commit -m "Apply Cloud session activity sync events"
```

---

### Task 6: Own Cloud activity state in `useCloudBridgeState`

**Files:**
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`

- [ ] **Step 1: Write failing test for state merge helper**

If `useCloudBridgeState` has no exported helper for activity state, add one test against a new exported pure helper in `cloudSessionActivity.ts` instead:

```ts
test('Cloud session activity store merges fetched snapshots without dropping other sessions', () => {
  const current = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'one', sessionId: 'session:group:1', taskId: 'task-1', title: 'One', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: [], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
    artifacts: [],
  });
  const incoming = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'two', sessionId: 'session:group:2', taskId: 'task-2', title: 'Two', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: [], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
    artifacts: [],
  });

  const merged = mergeCloudSessionActivity(current, incoming);

  assert.equal(merged.tasksBySessionId['session:group:1']?.length, 1);
  assert.equal(merged.tasksBySessionId['session:group:2']?.length, 1);
});
```

- [ ] **Step 2: Add hook result fields**

In `UseCloudBridgeStateResult`, add:

```ts
cloudSessionActivity: CloudSessionActivityStore;
refreshCloudSessionActivity(sessionId: string): Promise<void>;
publishCloudTaskActivity(input: PublishCloudTaskActivityInput): Promise<void>;
publishCloudArtifactActivity(input: PublishCloudArtifactActivityInput): Promise<void>;
```

Define `PublishCloudTaskActivityInput` and `PublishCloudArtifactActivityInput` in `cloudSessionActivity.ts` or `useCloudBridgeState.ts` using client method input shapes.

- [ ] **Step 3: Add state/cache**

In `useCloudBridgeState`:

```ts
const [cloudSessionActivity, setCloudSessionActivity] = useState<CloudSessionActivityStore>(() => loadCachedCloudSessionActivity(account?.accountId));
const cloudSessionActivityRef = useRef(cloudSessionActivity);
```

Mirror the existing messages cache pattern: save on change, reload/clear on account change.

- [ ] **Step 4: Fetch activity snapshots**

Add `refreshCloudSessionActivity(sessionId)`:

1. Load session token.
2. Call `client.listSessionActivity(token, sessionId)`.
3. Normalize and merge into state.

Call it opportunistically after `refreshCloudBridgeMessages()` for active Cloud session ids and after a fork is recorded.

- [ ] **Step 5: Wire diff sync**

Where `syncCloudDiffOnce` is called, pass `sessionActivity: cloudSessionActivityRef.current`; after result, update both messages and session activity.

- [ ] **Step 6: Add publish methods**

Implement `publishCloudTaskActivity` and `publishCloudArtifactActivity`:

1. Load token.
2. Call client upsert method.
3. Merge returned row into local state immediately.
4. Save cache.

- [ ] **Step 7: Expose through app model**

Destructure new fields in `useKordiAppModel.ts` and pass `cloudSessionActivity` into `useKordiDesktopActivity` and/or view model hydration.

Update `AssembleKordiShellSlotsArgs` if activity-derived artifacts need to flow to the right rail.

- [ ] **Step 8: Run tests/typecheck**

Run:

```bash
cd app/desktop
pnpm typecheck
pnpm exec tsx --test tests/cloudBridgeState.test.tsx tests/cloudSessionActivity.test.ts tests/cloudDiffSync.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/kordiShellSlots.types.ts app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "Track Cloud session activity in bridge state"
```

---

### Task 7: Hydrate Cloud tasks and artifacts into the right rail

**Files:**
- Modify: `app/desktop/src/app/useKordiDesktopActivity.ts`
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts` or add `app/desktop/src/features/cloud/cloudConversationActivity.ts`
- Test: `app/desktop/tests/chatDetailPanel.test.tsx`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`

- [ ] **Step 1: Write failing render test**

Add to `chatDetailPanel.test.tsx`:

```ts
test('chat detail task panel renders Cloud-synced task activity rows', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:cloud', canonicalSessionId: 'session:group:cloud', name: 'Cloud group', type: 'person', subtitle: '', unread: 0,
      bridges: ['Cloud'], trust: 'Cloud', directness: 'Group chat', participants: ['Me'], messages: [],
      taskActivities: [{
        id: 'cloud-task:task-1', sessionId: 'session:group:cloud', status: 'active',
        initiator: { id: 'cloud:acct_a', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_a' },
        target: { id: 'task:task-1', name: 'Review launch plan', kind: 'agent', role: 'external-agent', avatarKey: 'acct_a' },
        participants: [], createdAtMs: 1, updatedAtMs: 2, contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationIsBridge: true,
    activeBridgeConversationHostNodeId: null,
    activeBridgeConversationHostUrl: null,
    activeBridgeConversation: null,
    activeBridgeAwaitingReply: false,
    isBridgePolling: false,
    lastBridgePollAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /Review launch plan/);
});
```

- [ ] **Step 2: Run test**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/chatDetailPanel.test.tsx
```

Expected: It may already pass for direct `taskActivities`; if so, the missing behavior is view-model hydration. Add the next test to `cloudBridgeState.test.tsx` for generated conversation hydration.

- [ ] **Step 3: Write failing view-model hydration test**

Add a pure helper, e.g. `cloudActivityForSession(sessionId, store)`, and test:

```ts
test('Cloud conversation hydration attaches synced task activities by canonical session id', () => {
  const store = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:cloud', taskId: 'task-1', title: 'Review launch plan', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: [], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
    artifacts: [],
  });

  const activities = cloudTaskActivitiesForSession(store, 'session:group:cloud');

  assert.equal(activities[0]?.target?.name, 'Review launch plan');
});
```

- [ ] **Step 4: Implement hydration helpers**

In `cloudSessionActivity.ts`, add:

```ts
export function cloudTaskActivitiesForSession(store: CloudSessionActivityStore, sessionId: string): SessionTaskActivity[]
export function cloudArtifactsForSession(store: CloudSessionActivityStore, sessionId: string): SessionArtifact[]
```

- [ ] **Step 5: Merge Cloud artifacts into active right rail**

In `useKordiDesktopActivity`, accept `cloudSessionActivity` in args. For Cloud conversations, compute:

```ts
const activeCloudSessionId = activeConv.canonicalSessionId ?? activeConv.id;
const cloudArtifacts = cloudArtifactsForSession(cloudSessionActivity, activeCloudSessionId);
const activeChatArtifacts = useMemo(
  () => activeConversationIsBridge
    ? cloudArtifacts
    : [...cloudArtifacts, ...extractSessionArtifacts(...)],
  [...]
);
```

Do not suppress Cloud artifacts just because `activeConversationIsBridge` is true.

- [ ] **Step 6: Merge Cloud tasks into conversations**

In `useWorkspaceViewModels` or `cloudBridgeState` conversion, when building Cloud conversations, set:

```ts
taskActivities: [
  ...(conversation.taskActivities ?? []),
  ...cloudTaskActivitiesForSession(cloudSessionActivity, conversation.canonicalSessionId ?? conversation.id),
]
```

Keep dedupe by `id` in the helper to avoid duplicate rows.

- [ ] **Step 7: Run tests**

Run:

```bash
cd app/desktop
pnpm typecheck
pnpm exec tsx --test tests/chatDetailPanel.test.tsx tests/cloudBridgeState.test.tsx tests/cloudSessionActivity.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/desktop/src/app/useKordiDesktopActivity.ts app/desktop/src/app/useWorkspaceViewModels.ts app/desktop/src/features/cloud/cloudSessionActivity.ts app/desktop/tests/chatDetailPanel.test.tsx app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "Hydrate Cloud activity into chat detail rail"
```

---

### Task 8: Publish local Cloud agent task/artifact activity after completed turns

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/src/features/cloud/cloudSessionActivity.ts`
- Test: `app/desktop/tests/cloudSessionActivity.test.ts`
- Test: `app/desktop/tests/bridgeAttachmentTransport.test.tsx` or new `app/desktop/tests/cloudActivityPublish.test.ts`

- [ ] **Step 1: Write failing derivation tests**

In `cloudSessionActivity.test.ts`, add:

```ts
import { deriveCloudActivityFromTurn } from '../src/features/cloud/cloudSessionActivity';

test('deriveCloudActivityFromTurn extracts task_operator tasks and generated artifacts', () => {
  const derived = deriveCloudActivityFromTurn({
    sessionId: 'session:group:cloud',
    localAccountId: 'acct_me',
    participantAccountIds: ['acct_me', 'acct_peer'],
    turn: {
      id: 'turn_1', sessionId: 'session:group:cloud', prompt: 'make a plan', status: 'complete', message: 'done', assistantText: 'Done', thinkingText: '', completed: true, succeeded: true, error: null, transcriptRefreshRequired: false, startedAtMs: 1, completedAtMs: 2,
      tools: [{ id: 'tool_1', name: 'task_operator', status: 'done', arguments: JSON.stringify({ taskId: 'launch_plan', taskTitle: 'Launch plan', action: 'create' }), liveOutput: '', resultText: 'Task created', detail: null, artifactPath: null, toolLayer: null, isError: false }, { id: 'tool_2', name: 'write', status: 'done', arguments: JSON.stringify({ path: 'docs/launch-plan.md' }), liveOutput: '', resultText: 'ok', detail: null, artifactPath: 'docs/launch-plan.md', toolLayer: null, isError: false }],
    },
  });

  assert.equal(derived.tasks[0]?.taskId, 'launch_plan');
  assert.equal(derived.artifacts[0]?.artifactId, 'docs/launch-plan.md');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudSessionActivity.test.ts
```

Expected: FAIL because `deriveCloudActivityFromTurn` does not exist.

- [ ] **Step 3: Implement derivation helper**

In `cloudSessionActivity.ts`, implement:

```ts
export function deriveCloudActivityFromTurn(input: {
  sessionId: string;
  localAccountId: string;
  participantAccountIds: string[];
  turn: DesktopChatTurnSnapshot;
}): { tasks: PublishCloudTaskActivityInput[]; artifacts: PublishCloudArtifactActivityInput[] }
```

Use existing `generatedArtifactIdsFromTurn` and `changedFileRowsFromTurn` from `features/chat/artifacts.ts`. For tasks, parse `task_operator` tool arguments and result text; use `taskId` from args if present, otherwise slugify `taskTitle`/`title`; map status from tool status and args action (`close` => `closed`, completed tool => `completed` or `active`).

- [ ] **Step 4: Add publish hook into Cloud send flow**

In `messageActions/chatMessages.ts`, after `waitForCompletedDesktopTurn` resolves for Cloud direct/group/fork local agent turns, call injected `publishCloudTaskActivity` / `publishCloudArtifactActivity` from `useCloudBridgeState` result.

If these callbacks are not currently passed into message actions, thread them through `useComposerMessageActions` types with optional no-op defaults:

```ts
publishCloudTaskActivity?: (input: PublishCloudTaskActivityInput) => Promise<void>;
publishCloudArtifactActivity?: (input: PublishCloudArtifactActivityInput) => Promise<void>;
```

- [ ] **Step 5: Keep publishing best-effort**

Wrap publishing in `Promise.allSettled`. If it fails, log:

```ts
console.warn('[cloud-activity] publish failed', error);
```

Do not fail the user’s completed chat turn.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
cd app/desktop
pnpm typecheck
pnpm exec tsx --test tests/cloudSessionActivity.test.ts tests/bridgeAttachmentTransport.test.tsx tests/cloudDirectContactSend.test.ts tests/cloudBridgeState.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/features/cloud/cloudSessionActivity.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/useComposerMessageActions.ts app/desktop/src/features/chat/composerController.types.ts app/desktop/tests/cloudSessionActivity.test.ts
git commit -m "Publish Cloud task and artifact activity"
```

---

### Task 9: Snapshot Cloud tasks/artifacts when creating forks

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Test: `app/desktop/tests/cloudSessionActivity.test.ts`
- Test: `bridges/cloud-server` route helper tests

- [ ] **Step 1: Write failing client snapshot test**

In `cloudSessionActivity.test.ts`, add:

```ts
import { cloneCloudSessionActivityForFork } from '../src/features/cloud/cloudSessionActivity';

test('cloneCloudSessionActivityForFork copies source tasks and artifacts to fork session', () => {
  const source = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:parent', taskId: 'task-1', title: 'Review', status: 'active', createdByAccountId: 'acct_a', participants: [], artifactIds: ['docs/a.md'], createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
    artifacts: [{ artifactActivityId: 'artifactact_1', sessionId: 'session:group:parent', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', createdByAccountId: 'acct_a', createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z' }],
  });

  const cloned = cloneCloudSessionActivityForFork(source, 'session:group:parent', 'session:fork:child', '2026-05-15T10:05:00Z');

  assert.equal(cloned.tasksBySessionId['session:fork:child']?.[0]?.sessionId, 'session:fork:child');
  assert.equal(cloned.artifactsBySessionId['session:fork:child']?.[0]?.sessionId, 'session:fork:child');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudSessionActivity.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement client clone helper**

Implement `cloneCloudSessionActivityForFork` as a local optimistic snapshot. It should copy rows from source session, replace `sessionId`, prefix activity ids with `fork:<forkSessionId>:`, and set `updatedAt` to the provided timestamp.

- [ ] **Step 4: Use helper after `recordCloudSessionFork`**

In `useCloudBridgeState.recordCloudSessionFork`, after server call succeeds, merge cloned activity into local state immediately, then call `refreshCloudSessionActivity(forkSessionId)`.

- [ ] **Step 5: Add server helper test**

In `routes.rs` test module, add a pure test for fork-copy row id generation helper if implemented in Rust. If using SQL-only copy, add an integration-like helper test that verifies generated sync payload for copied fork row has `sessionId = forkSessionId`.

- [ ] **Step 6: Run tests**

Run:

```bash
cd app/desktop && pnpm exec tsx --test tests/cloudSessionActivity.test.ts
cd ../.. && cargo test -p kordi-cloud-server --lib
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/features/cloud/cloudSessionActivity.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudSessionActivity.test.ts bridges/cloud-server/src/auth/routes.rs
git commit -m "Snapshot Cloud activity into forks"
```

---

### Task 10: End-to-end verification and PR

**Files:**
- No source changes unless verification finds bugs.

- [ ] **Step 1: Run desktop verification**

```bash
cd app/desktop
pnpm typecheck
pnpm exec tsx --test \
  tests/rightDetailRailCloudTasks.test.tsx \
  tests/cloudSessionActivity.test.ts \
  tests/cloudDiffSync.test.tsx \
  tests/cloudBridgeState.test.tsx \
  tests/chatDetailPanel.test.tsx \
  tests/bridgeAttachmentTransport.test.tsx \
  tests/cloudDirectContactSend.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run server verification**

```bash
cargo test -p kordi-cloud-server --lib
```

Expected: PASS.

- [ ] **Step 3: Run Rust desktop targeted tests**

```bash
cd app/desktop/src-tauri
cargo test cloud_group_open_keeps_local_profile_as_only_self_even_when_remote_created --lib
```

Expected: PASS.

- [ ] **Step 4: Inspect diff**

```bash
git diff --stat origin/main-cloud...HEAD
git diff --check
```

Expected: no whitespace errors; diff only covers issue #342 work.

- [ ] **Step 5: Manual Cloud retest**

Launch three Cloud instances from the main-cloud style launcher. In a direct chat, a group chat, and a fork:

1. Confirm the right rail shows `Tasks`.
2. Ask an agent to create a task using task language.
3. Confirm the local sender sees task row immediately.
4. Confirm the other participant sees the same task row after Cloud sync.
5. Create or edit a generated artifact.
6. Confirm artifact appears in the right Artifact panel for participants who can access the Cloud artifact reference.
7. Fork the group chat and confirm task/artifact snapshot appears in the fork.
8. Confirm localhost Bridge DB/runtime rows are not created for Cloud contact/group/fork messaging.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin feature/issue-342-cloud-artifacts-tasks-sync
gh pr create --base main-cloud --head feature/issue-342-cloud-artifacts-tasks-sync --title "Implement Cloud session artifacts and tasks sync" --body "$(cat <<'BODY'
## Summary
- Restore the Cloud chat/group/fork Tasks tab.
- Add Cloud-native session task/artifact activity persistence and sync events.
- Hydrate synced activity into the Tasks and Artifacts right rail.
- Snapshot Cloud activity into fork sessions.

Closes #342.

## Test Plan
- [ ] cd app/desktop && pnpm typecheck
- [ ] cd app/desktop && pnpm exec tsx --test tests/rightDetailRailCloudTasks.test.tsx tests/cloudSessionActivity.test.ts tests/cloudDiffSync.test.tsx tests/cloudBridgeState.test.tsx tests/chatDetailPanel.test.tsx tests/bridgeAttachmentTransport.test.tsx tests/cloudDirectContactSend.test.ts
- [ ] cargo test -p kordi-cloud-server --lib
- [ ] cd app/desktop/src-tauri && cargo test cloud_group_open_keeps_local_profile_as_only_self_even_when_remote_created --lib
BODY
)"
```

Expected: PR opened against `main-cloud`.

---

## Self-Review

- Spec coverage: Tasks tab visibility, Cloud-native task/artifact persistence, sync fanout, right-rail hydration, fork snapshots, and no localhost Bridge dependency are each covered by Tasks 1–9.
- Placeholder scan: No TBD/TODO placeholders remain; endpoint SQL and helper shapes are explicit.
- Type consistency: Server uses `CloudTaskActivitySummary` / `CloudArtifactActivitySummary`; client uses `CloudTaskActivity` / `CloudArtifactActivity`; sync event names are consistently `task.upsert`, `artifact.upsert`, and `artifact.archived`.
- Scope: This is large but cohesive around issue #342. If time is constrained, Task 1 can ship separately as a UI unblock, but the full plan keeps it in the same branch as requested.
