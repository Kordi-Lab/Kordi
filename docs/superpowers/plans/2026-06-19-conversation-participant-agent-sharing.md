# Conversation-Participant Agent Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners opt Cloud Agents into `Shared in conversations with me` so other participants can @mention those agents only in sessions containing the owner.

**Architecture:** Extend Cloud Agent access scope from `private` to `private | participant_conversations`, add a mention-safe shared-agent lookup, and validate shared execution against server-side session membership. Desktop keeps owned Cloud Agents editable, adds a separate remote shared-agent mention catalog, and preserves owner-attributed response labels.

**Tech Stack:** Rust/Axum/sqlx/Postgres Cloud server; TypeScript/React/Tauri desktop; Node test runner; existing canonical chat/session model and Cloud group runtime.

---

## Baseline

New worktree: `/Users/shuyang/kordi/.worktrees/issue-587-agent-participant-sharing`
Branch: `feature/issue-587-agent-participant-sharing-impl`
Issue: #587
Spec: `docs/superpowers/specs/2026-06-19-conversation-participant-agent-sharing-design.md`

Baseline commands already run:

```bash
pnpm install --frozen-lockfile
pnpm --dir app/desktop exec tsc --noEmit --pretty false
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e
```

Baseline note: root `cargo check -q` is blocked by the Tauri desktop build script requiring `app/desktop/src-tauri/binaries/kordi-aarch64-apple-darwin`. Use targeted Cloud server tests and desktop TypeScript/tests for this task.

---

## File Map

### Backend

- Modify: `bridges/cloud-server/migrations/0026_cloud_agent_participant_sharing.sql`
  - Extend the `cloud_agent_definitions_access_scope_check` constraint to allow `participant_conversations`.
- Modify: `bridges/cloud-server/src/pg/pool.rs`
  - Register migration `0026`.
- Modify: `bridges/cloud-server/src/cloud_agents/models.rs`
  - Add access constant, safe shared summary response type, update request access field, tests.
- Modify: `bridges/cloud-server/src/cloud_agents/store.rs`
  - Persist access updates and add shared summary lookup.
- Modify: `bridges/cloud-server/src/cloud_agents/routes.rs`
  - Add shared lookup endpoint and route query parsing.
- Modify: `bridges/cloud-server/src/auth/routes.rs`
  - Expose `cloud_session_participants` as a crate-visible helper so runtime can reuse server-side membership validation.
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
  - Carry optional target Cloud Agent metadata in group envelopes, validate participant sharing, and label shared-agent replies as `Agent · Owner's Agent`.
- Test: `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`
  - Extend existing route/source tests and e2e coverage.
- Test: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
  - Add unit tests for envelope metadata and validation helpers.

### Desktop

- Modify: `app/desktop/src/features/cloud/cloudAgentsClient.ts`
  - Add `participant_conversations`, update input types, add `listSharedCloudAgents`.
- Modify: `app/desktop/src/features/cloud/cloudAgents.ts`
  - Normalize both owned full definitions and remote mention-safe shared summaries.
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Preserve owned-agent sync behavior and add a shared-agent refresh effect keyed by active session participant owner IDs.
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Store shared-agent catalog, refresh by participant owner IDs, detect shared-agent mentions, enqueue target owner/account/agent metadata, and update placeholders.
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
  - Add optional shared Cloud Agent target metadata to group message envelope.
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`
  - Add shared Cloud Agent mention candidate helpers and duplicate-handle disambiguation.
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
  - Pass shared-agent mention targets into composer target list and group send metadata.
- Modify: `app/desktop/src/kordi-app/agents/AgentDetailPane.tsx`
  - Make Access menu editable for owned Cloud Agents.
- Modify: `app/desktop/src/kordi-app/agents/AgentsPage.tsx`
  - Wire `onUpdateCloudAgent` to Access menu.
- Modify: `app/desktop/src/kordi-app/agents/model.ts`
  - Add `cloudAgentAccessLabel(scope)` and `cloudAgentAccessDescription(scope)` helpers used by the Access UI.
- Modify: `app/desktop/src/features/chat/useDesktopTranscriptAdapter.ts`
  - Render shared-agent response sender labels with owner attribution.
- Test: `app/desktop/tests/cloudAgents.test.tsx`
- Test: `app/desktop/tests/cloudAgentMessages.test.tsx`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`
- Test: `app/desktop/tests/cloudGroupMessages.test.tsx`
- Test: `app/desktop/tests/desktopTranscriptAdapter.test.tsx`

---

## Task 1: Backend access scope and owner update

**Files:**
- Create: `bridges/cloud-server/migrations/0026_cloud_agent_participant_sharing.sql`
- Modify: `bridges/cloud-server/src/pg/pool.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/models.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/store.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`

- [ ] **Step 1: Write failing model tests**

Add to `bridges/cloud-server/src/cloud_agents/models.rs` test module:

```rust
#[test]
fn access_scope_accepts_participant_conversations() {
    assert_eq!(
        clean_access_scope(Some(" participant_conversations ")).unwrap(),
        "participant_conversations"
    );
}

#[test]
fn update_request_accepts_access_scope_field() {
    let input: UpdateCloudAgentRequest = serde_json::from_value(serde_json::json!({
        "accessScope": "participant_conversations"
    }))
    .expect("deserialize update request");
    assert_eq!(input.access_scope.as_deref(), Some("participant_conversations"));
}
```

- [ ] **Step 2: Run failing model tests**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agents::models::tests::access_scope_accepts_participant_conversations cloud_agents::models::tests::update_request_accepts_access_scope_field
```

Expected before implementation: first test fails because `participant_conversations` is rejected; second fails to compile until `access_scope` exists on `UpdateCloudAgentRequest`.

- [ ] **Step 3: Implement access scope model changes**

In `bridges/cloud-server/src/cloud_agents/models.rs` add:

```rust
pub const CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS: &str = "participant_conversations";
```

Add to `UpdateCloudAgentRequest`:

```rust
pub access_scope: Option<String>,
```

Replace `clean_access_scope` with:

```rust
pub fn clean_access_scope(value: Option<&str>) -> Result<String, String> {
    match value.unwrap_or(CLOUD_AGENT_ACCESS_PRIVATE).trim() {
        "" | CLOUD_AGENT_ACCESS_PRIVATE => Ok(CLOUD_AGENT_ACCESS_PRIVATE.to_string()),
        CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS => {
            Ok(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS.to_string())
        }
        _ => Err("Unsupported Cloud Agent access scope".to_string()),
    }
}
```

- [ ] **Step 4: Add migration and register it**

Create `bridges/cloud-server/migrations/0026_cloud_agent_participant_sharing.sql`:

```sql
ALTER TABLE cloud_agent_definitions
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_access_scope_check;

ALTER TABLE cloud_agent_definitions
    ADD CONSTRAINT cloud_agent_definitions_access_scope_check
        CHECK (access_scope IN ('private', 'participant_conversations'));
```

In `bridges/cloud-server/src/pg/pool.rs`, add after migration `0025`:

```rust
Migration {
    version: 26,
    name: "cloud_agent_participant_sharing",
    sql: include_str!("../../migrations/0026_cloud_agent_participant_sharing.sql"),
},
```

- [ ] **Step 5: Persist access updates**

In `bridges/cloud-server/src/cloud_agents/store.rs`, import the new constant and add this before model routing update:

```rust
if let Some(value) = input.access_scope {
    current.access_scope = clean_access_scope(Some(&value)).map_err(CloudAgentStoreError::Invalid)?;
}
```

Update the SQL `SET` clause to write access scope:

```sql
SET access_scope = $4, name = $5, role = $6, description = $7, system_prompt = $8, source_summary = $9,
    boundaries_json = $10, resources_json = $11, skills_json = $12, model_routing_json = $13,
    updated_at = $14
```

Shift binds so `$4` is `&current.access_scope`, then name/role/etc. follow.

- [ ] **Step 6: Extend e2e tests**

In `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`, update the test currently named `cloud_agent_create_rejects_non_private_access` to reject `public` but accept `participant_conversations` on update. Add assertions equivalent to:

```rust
assert!(source.contains("participant_conversations"));
assert!(source.contains("access_scope = $4"));
```

If the e2e harness creates agents through HTTP, add a request:

```json
{ "accessScope": "participant_conversations" }
```

against `PUT /v1/cloud/agents/:agent_id` and assert response body `agent.accessScope == "participant_conversations"`.

- [ ] **Step 7: Verify and commit Task 1**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agents::models::tests
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e
```

Expected: all selected tests pass.

Commit:

```bash
git add bridges/cloud-server/migrations/0026_cloud_agent_participant_sharing.sql \
  bridges/cloud-server/src/pg/pool.rs \
  bridges/cloud-server/src/cloud_agents/models.rs \
  bridges/cloud-server/src/cloud_agents/store.rs \
  bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs
git commit -m "feat: allow participant-scoped cloud agents"
```

---

## Task 2: Backend mention-safe shared-agent lookup

**Files:**
- Modify: `bridges/cloud-server/src/cloud_agents/models.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/store.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/routes.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`

- [ ] **Step 1: Add failing tests for shared lookup source and privacy**

In `cloud_agent_definitions_e2e.rs`, add a test asserting the route exists and does not return full prompt fields in the safe type:

```rust
#[test]
fn shared_cloud_agent_lookup_is_mention_safe_in_source() {
    let routes = include_str!("../src/cloud_agents/routes.rs");
    let models = include_str!("../src/cloud_agents/models.rs");
    let store = include_str!("../src/cloud_agents/store.rs");

    assert!(routes.contains("/v1/cloud/agents/shared"));
    assert!(models.contains("SharedCloudAgentSummary"));
    assert!(store.contains("list_shared_agent_summaries"));
    assert!(!models.contains("pub system_prompt: String,\n}\n\n#[derive(Debug, Clone, Serialize)]\npub struct SharedCloudAgentSummary"));
}
```

- [ ] **Step 2: Run failing shared lookup test**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e shared_cloud_agent_lookup_is_mention_safe_in_source
```

Expected before implementation: fails because route/type/store function are absent.

- [ ] **Step 3: Add safe summary model**

In `models.rs` add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedCloudAgentSummary {
    pub agent_id: String,
    pub owner_account_id: String,
    pub owner_display_name: Option<String>,
    pub access_scope: String,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub updated_at: String,
}
```

This type intentionally omits `system_prompt`, `model_routing`, `resources`, and full `skills`.

- [ ] **Step 4: Add shared summary store query**

In `store.rs`, add:

```rust
use crate::cloud_agents::models::{
    /* existing imports */ SharedCloudAgentSummary, CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
};
```

Add function:

```rust
pub async fn list_shared_agent_summaries(
    pool: &PgPool,
    owner_account_ids: &[String],
) -> Result<Vec<SharedCloudAgentSummary>, CloudAgentStoreError> {
    let owners: Vec<String> = owner_account_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(50)
        .collect();
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    let rows = query_as::<_, (String, String, Option<String>, String, String, String, Option<String>, String)>(
        "SELECT a.agent_id, a.owner_account_id, c.display_name, a.access_scope, a.name, a.role, a.description, a.updated_at
         FROM cloud_agent_definitions a
         LEFT JOIN cloud_accounts c ON c.account_id = a.owner_account_id
         WHERE a.owner_account_id = ANY($1)
           AND a.status = $2
           AND a.access_scope = $3
         ORDER BY a.updated_at DESC, a.agent_id ASC",
    )
    .bind(&owners)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .bind(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| SharedCloudAgentSummary {
            agent_id: row.0,
            owner_account_id: row.1,
            owner_display_name: row.2,
            access_scope: row.3,
            name: row.4,
            role: row.5,
            description: row.6,
            updated_at: row.7,
        })
        .collect())
}
```

- [ ] **Step 5: Add route**

In `routes.rs`, import `Query`, `Deserialize`, `SharedCloudAgentSummary`, and `list_shared_agent_summaries`. Add:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAgentsQuery {
    owner_account_ids: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedCloudAgentListResponse {
    agents: Vec<SharedCloudAgentSummary>,
}
```

Add route before `/:agent_id`:

```rust
.route("/v1/cloud/agents/shared", get(list_shared_agents))
```

Add handler:

```rust
async fn list_shared_agents(
    State(state): State<Arc<ServerState>>,
    Extension(_session): Extension<CloudSession>,
    Query(query): Query<SharedAgentsQuery>,
) -> Response {
    let owner_ids = query
        .owner_account_ids
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    match list_shared_agent_summaries(state.db_pool(), &owner_ids).await {
        Ok(agents) => Json(SharedCloudAgentListResponse { agents }).into_response(),
        Err(err) => store_error_response("list_shared", err),
    }
}
```

- [ ] **Step 6: Verify and commit Task 2**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e
```

Expected: all selected tests pass.

Commit:

```bash
git add bridges/cloud-server/src/cloud_agents/models.rs \
  bridges/cloud-server/src/cloud_agents/store.rs \
  bridges/cloud-server/src/cloud_agents/routes.rs \
  bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs
git commit -m "feat: add shared cloud agent lookup"
```

---

## Task 3: Desktop Cloud Agent client/types and owned Access UI

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudAgentsClient.ts`
- Modify: `app/desktop/src/features/cloud/cloudAgents.ts`
- Modify: `app/desktop/src/kordi-app/agents/AgentDetailPane.tsx`
- Modify: `app/desktop/src/kordi-app/agents/AgentsPage.tsx`
- Test: `app/desktop/tests/cloudAgents.test.tsx`
- Test: `app/desktop/tests/cloudAgents.test.tsx` for Access type/client behavior.

- [ ] **Step 1: Write failing desktop type/client tests**

In `cloudAgents.test.tsx`, add:

```ts
const sharedRawAgent = {
  agentId: 'cloud_agent_shared',
  ownerAccountId: 'acct_owner',
  ownerDisplayName: 'Shuyang',
  accessScope: 'participant_conversations',
  name: 'Project Driver',
  role: 'Planning agent',
  description: 'Keeps projects moving',
  updatedAt: '2026-06-19T00:00:00Z',
};

test('normalizeCloudAgentDefinition accepts participant conversation owned agents', () => {
  const agent = normalizeCloudAgentDefinition({
    ...rawAgent,
    accessScope: 'participant_conversations',
  });

  assert.equal(agent?.accessScope, 'participant_conversations');
  assert.equal(cloudAgentDefinitionToAgent(agent!).status, 'Shared');
});

test('shared cloud agent summaries are mention safe', () => {
  const agent = normalizeSharedCloudAgentSummary({
    ...sharedRawAgent,
    systemPrompt: 'must not be read',
    modelRouting: { defaultModel: 'openai/private' },
  });

  assert.equal(agent?.agentId, 'cloud_agent_shared');
  assert.equal(agent?.ownerDisplayName, 'Shuyang');
  assert.equal('systemPrompt' in (agent as object), false);
  assert.equal('modelRouting' in (agent as object), false);
});
```

Also extend `CloudAgentsClient` mock test to cover:

```ts
if (String(url).includes('/v1/cloud/agents/shared') && init.method === 'GET') {
  return new Response(JSON.stringify({ agents: [sharedRawAgent] }), { status: 200 });
}
```

and assert:

```ts
assert.equal((await client.listSharedCloudAgents('token', ['acct_owner']))[0]?.agentId, 'cloud_agent_shared');
```

- [ ] **Step 2: Run failing desktop tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAgents.test.tsx
```

Expected before implementation: missing `participant_conversations`, `normalizeSharedCloudAgentSummary`, and `listSharedCloudAgents`.

- [ ] **Step 3: Implement client/types**

In `cloudAgentsClient.ts` change:

```ts
export type CloudAgentAccessScope = 'private';
export type UpdateCloudAgentInput = Partial<Omit<CreateCloudAgentInput, 'accessScope'>>;
```

to:

```ts
export type CloudAgentAccessScope = 'private' | 'participant_conversations';
export type UpdateCloudAgentInput = Partial<CreateCloudAgentInput>;
```

Add:

```ts
import { normalizeCloudAgentDefinition, normalizeSharedCloudAgentSummary, type CloudAgentDefinition, type SharedCloudAgentSummary } from './cloudAgents';
```

Add method:

```ts
async listSharedCloudAgents(token: string, ownerAccountIds: string[]): Promise<SharedCloudAgentSummary[]> {
  const owners = [...new Set(ownerAccountIds.map((value) => value.trim()).filter(Boolean))];
  if (owners.length === 0) return [];
  const path = `/v1/cloud/agents/shared?ownerAccountIds=${encodeURIComponent(owners.join(','))}`;
  const body = await this.send<CloudAgentListResponse>(path, {
    method: 'GET',
    headers: this.authHeaders(token),
  }, 'Could not list shared Cloud Agents.');
  return (Array.isArray(body.agents) ? body.agents : [])
    .map(normalizeSharedCloudAgentSummary)
    .filter((agent): agent is SharedCloudAgentSummary => Boolean(agent));
}
```

- [ ] **Step 4: Implement shared summary normalization**

In `cloudAgents.ts`, update access validation:

```ts
if (!agentId || !ownerAccountId || !['private', 'participant_conversations'].includes(accessScope) || !['active', 'archived'].includes(status) || !name || !role || !systemPrompt || !createdAt || !updatedAt) {
  return null;
}
```

Set `accessScope: accessScope as CloudAgentAccessScope`.

Update `cloudAgentDefinitionToAgent` status:

```ts
status: definition.accessScope === 'private' ? 'Private' : 'Shared',
```

Add type and normalizer:

```ts
export type SharedCloudAgentSummary = {
  agentId: string;
  ownerAccountId: string;
  ownerDisplayName: string | null;
  accessScope: 'participant_conversations';
  name: string;
  role: string;
  description: string | null;
  updatedAt: string;
};

export function normalizeSharedCloudAgentSummary(value: unknown): SharedCloudAgentSummary | null {
  const record = objectRecord(value);
  if (!record) return null;
  const agentId = cleanText(record.agentId);
  const ownerAccountId = cleanText(record.ownerAccountId);
  const accessScope = cleanText(record.accessScope);
  const name = cleanText(record.name);
  const role = cleanText(record.role);
  const updatedAt = cleanText(record.updatedAt);
  if (!agentId || !ownerAccountId || accessScope !== 'participant_conversations' || !name || !role || !updatedAt) return null;
  return {
    agentId,
    ownerAccountId,
    ownerDisplayName: cleanNullableText(record.ownerDisplayName),
    accessScope: 'participant_conversations',
    name,
    role,
    description: cleanNullableText(record.description),
    updatedAt,
  };
}
```

- [ ] **Step 5: Make Access menu editable**

In `AgentDetailPane.tsx`, change `AgentAccessMenu` props to include:

```ts
function AgentAccessMenu({ agent, onUpdateAccess, isSaving }: {
  agent: Agent;
  onUpdateAccess?: (agent: Agent, accessScope: 'private' | 'participant_conversations') => Promise<void> | void;
  isSaving?: boolean;
})
```

Replace the fixed select with:

```tsx
<select
  className="mt-2 w-full rounded-[12px] border border-[color:var(--app-divider)] bg-transparent px-3 py-2 text-[12px]"
  value={agent.cloudAgentAccessScope === 'participant_conversations' ? 'participant_conversations' : 'private'}
  onChange={(event) => {
    const next = event.currentTarget.value === 'participant_conversations' ? 'participant_conversations' : 'private';
    void onUpdateAccess?.(agent, next);
  }}
  disabled={!onUpdateAccess || isSaving}
  aria-label="Agent access"
>
  <option value="private">Private — only me</option>
  <option value="participant_conversations">Shared in conversations with me</option>
</select>
```

Update copy:

```tsx
<div className="app-agent-row-meta mt-2">
  {agent.cloudAgentAccessScope === 'participant_conversations'
    ? 'People in contact and group sessions that include you can mention this agent.'
    : 'Synced privately to your Cloud account.'}
</div>
```

Thread `onUpdateAccess` from `AgentsPage.tsx` to `AgentDetailPane` and call existing Cloud update path with `{ accessScope }`.

- [ ] **Step 6: Verify and commit Task 3**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAgents.test.tsx
pnpm --dir app/desktop exec tsc --noEmit --pretty false
```

Expected: tests and TypeScript pass.

Commit:

```bash
git add app/desktop/src/features/cloud/cloudAgentsClient.ts \
  app/desktop/src/features/cloud/cloudAgents.ts \
  app/desktop/src/kordi-app/agents/AgentDetailPane.tsx \
  app/desktop/src/kordi-app/agents/AgentsPage.tsx \
  app/desktop/tests/cloudAgents.test.tsx
git commit -m "feat: edit cloud agent sharing access"
```

---

## Task 4: Shared-agent mention candidates in desktop

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`
- Test: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Write failing mention eligibility tests**

In `cloudBridgeState.test.tsx`, add a focused pure helper test after existing `cloudAgentMentionCandidates` tests. The helper to introduce is `sharedCloudAgentMentionCandidatesForConversation` in `mentions.ts`.

Test shape:

```ts
import { sharedCloudAgentMentionCandidatesForConversation } from '../src/features/chat/messageActions/mentions';

const sharedAgent = {
  agentId: 'cloud_agent_project',
  ownerAccountId: 'acct_owner',
  ownerDisplayName: 'Shuyang',
  accessScope: 'participant_conversations' as const,
  name: 'Project Driver',
  role: 'Planning agent',
  description: null,
  updatedAt: '2026-06-19T00:00:00Z',
};

test('shared cloud agent mention candidates require owner participant', () => {
  const withOwner = sharedCloudAgentMentionCandidatesForConversation([sharedAgent], {
    canonicalParticipants: [
      { id: 'human:acct_owner', kind: 'human', name: 'Shuyang', humanId: 'acct_owner' },
      { id: 'human:acct_requester', kind: 'human', name: 'Alice', humanId: 'acct_requester' },
    ],
    directness: 'group',
  });
  assert.equal(withOwner[0]?.handle, 'ProjectDriver');
  assert.equal(withOwner[0]?.targetAgentId, 'cloud_agent_project');
  assert.equal(withOwner[0]?.targetOwnerAccountId, 'acct_owner');

  const withoutOwner = sharedCloudAgentMentionCandidatesForConversation([sharedAgent], {
    canonicalParticipants: [
      { id: 'human:acct_requester', kind: 'human', name: 'Alice', humanId: 'acct_requester' },
    ],
    directness: 'group',
  });
  assert.deepEqual(withoutOwner, []);
});
```

- [ ] **Step 2: Run failing mention test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudBridgeState.test.tsx
```

Expected before implementation: missing helper export.

- [ ] **Step 3: Add shared mention candidate helper**

In `mentions.ts`, import `SharedCloudAgentSummary`. Add type:

```ts
export type SharedCloudAgentMentionCandidate = {
  agent: SharedCloudAgentSummary;
  handle: string;
  normalizedHandle: string;
  displayLabel: string;
  detailLabel: string;
  targetKind: 'cloud-shared-agent';
  targetAgentId: string;
  targetOwnerAccountId: string;
};
```

Add owner key helper:

```ts
function conversationContainsAccountId(conversation: MentionScopeConversation | null | undefined, accountId: string) {
  const key = normalizedOwnerKey(accountId);
  if (!key) return false;
  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    if (participantHumanIdentityKeys(participant).includes(key)) return true;
  }
  return false;
}
```

Add function:

```ts
export function sharedCloudAgentMentionCandidatesForConversation(
  agents: SharedCloudAgentSummary[],
  conversation: MentionScopeConversation | null | undefined,
): SharedCloudAgentMentionCandidate[] {
  if (!conversationHasParticipantMentionScope(conversation)) return [];
  const candidates = agents
    .filter((agent) => conversationContainsAccountId(conversation, agent.ownerAccountId))
    .map((agent) => {
      const displayLabel = agent.name;
      const handle = mentionHandleForLabel(displayLabel, agent.agentId);
      const owner = agent.ownerDisplayName?.trim() || agent.ownerAccountId;
      return {
        agent,
        handle,
        normalizedHandle: normalizeMentionLabel(handle),
        displayLabel,
        detailLabel: `${owner}'s Agent`,
        targetKind: 'cloud-shared-agent' as const,
        targetAgentId: agent.agentId,
        targetOwnerAccountId: agent.ownerAccountId,
      };
    });
  const used = new Set<string>();
  return candidates.map((candidate) => {
    let handle = candidate.handle;
    let normalizedHandle = candidate.normalizedHandle;
    if (used.has(normalizedHandle)) {
      handle = uniqueHandle(candidate.handle, candidate.targetOwnerAccountId.slice(0, 8));
      normalizedHandle = normalizeMentionLabel(handle);
    }
    used.add(normalizedHandle);
    return { ...candidate, handle, normalizedHandle };
  });
}
```

- [ ] **Step 4: Add envelope metadata**

In `cloudGroupMessages.ts`, extend message type:

```ts
targetCloudAgentId?: string | null;
targetCloudAgentName?: string | null;
targetCloudAgentOwnerAccountId?: string | null;
targetCloudAgentOwnerName?: string | null;
```

Ensure parser normalizes these fields from incoming envelopes and encoder includes them when present.

- [ ] **Step 5: Wire shared catalog refresh and mention target dispatch**

In `useCloudBridgeState.ts`:

- Add state:

```ts
const [sharedCloudAgentsByOwner, setSharedCloudAgentsByOwner] = useState<Record<string, SharedCloudAgentSummary[]>>({});
```

- When active canonical session changes, derive participant account IDs from `state.identities`/`state.participants` using the same `accountIdForHumanIdentity` helper. Exclude the local account ID.
- Call `cloudAgentsClient.listSharedCloudAgents(session.token, participantOwnerIds)` and store by `ownerAccountId`.
- Expose a flattened `sharedCloudAgents` array from the hook return.

In `useKordiAppModel.ts`, include shared candidates in composer mention targets. For insert, use `@${candidate.handle}`. For send metadata, when resolving a mention candidate with `targetKind === 'cloud-shared-agent'`, attach the four envelope fields from Step 4 and target the owner account ID.

- [ ] **Step 6: Verify and commit Task 4**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx
pnpm --dir app/desktop exec tsc --noEmit --pretty false
```

Expected: tests and TypeScript pass.

Commit:

```bash
git add app/desktop/src/features/chat/messageActions/mentions.ts \
  app/desktop/src/features/cloud/cloudGroupMessages.ts \
  app/desktop/src/features/cloud/useCloudBridgeState.ts \
  app/desktop/src/app/useKordiAppModel.ts \
  app/desktop/tests/cloudBridgeState.test.tsx \
  app/desktop/tests/cloudGroupMessages.test.tsx
git commit -m "feat: mention shared cloud agents in conversations"
```

---

## Task 5: Runtime validation and owner-attributed shared-agent replies

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs` or `runs.rs` unit tests
- Modify: `app/desktop/src/features/chat/useDesktopTranscriptAdapter.ts`
- Test: `app/desktop/tests/desktopTranscriptAdapter.test.tsx`

- [ ] **Step 1: Expose server-side session participant helper**

In `auth/routes.rs`, change:

```rust
async fn cloud_session_participants(
```

to:

```rust
pub(crate) async fn cloud_session_participants(
```

- [ ] **Step 2: Add failing runtime tests**

In `runs.rs` tests, add a pure test for response labeling:

```rust
#[test]
fn shared_cloud_agent_group_response_uses_agent_owner_label() {
    let envelope = CloudGroupEnvelope {
        kind: "group-message".to_string(),
        group_id: "session:group:1".to_string(),
        group_space_id: None,
        group_title: None,
        created_by_account_id: "acct_requester".to_string(),
        actor: CloudGroupParticipant {
            account_id: "acct_requester".to_string(),
            display_name: "Alice".to_string(),
            avatar_url: None,
            role: Some("person".to_string()),
        },
        participants: vec![CloudGroupParticipant {
            account_id: "acct_owner".to_string(),
            display_name: "Shuyang".to_string(),
            avatar_url: None,
            role: Some("person".to_string()),
        }],
        message: Some(CloudGroupMessage {
            id: "msg_request".to_string(),
            sender_account_id: "acct_requester".to_string(),
            text: "@ProjectDriver help".to_string(),
            created_at_ms: 1,
            sender_kind: Some("human".to_string()),
            sender_display_name: Some("Alice".to_string()),
            delivery_state: None,
            reply_to_message_id: None,
            request_id: None,
            message_action: None,
            target_cloud_agent_id: Some("cloud_agent_project".to_string()),
            target_cloud_agent_name: Some("Project Driver".to_string()),
            target_cloud_agent_owner_account_id: Some("acct_owner".to_string()),
            target_cloud_agent_owner_name: Some("Shuyang".to_string()),
        }),
    };

    let body = cloud_group_response_body(&envelope, "acct_owner", "msg_request", "msg_response", "done", "complete", 2);
    let parsed = parse_cloud_group_envelope(&body).expect("response envelope");
    assert_eq!(parsed.message.unwrap().sender_display_name.as_deref(), Some("Project Driver · Shuyang's Agent"));
}
```

This requires adding optional fields to `CloudGroupMessage` in Rust.

- [ ] **Step 3: Add target metadata fields in Rust envelope**

In `runs.rs` `CloudGroupMessage`, add:

```rust
#[serde(rename = "targetCloudAgentId", skip_serializing_if = "Option::is_none")]
target_cloud_agent_id: Option<String>,
#[serde(rename = "targetCloudAgentName", skip_serializing_if = "Option::is_none")]
target_cloud_agent_name: Option<String>,
#[serde(rename = "targetCloudAgentOwnerAccountId", skip_serializing_if = "Option::is_none")]
target_cloud_agent_owner_account_id: Option<String>,
#[serde(rename = "targetCloudAgentOwnerName", skip_serializing_if = "Option::is_none")]
target_cloud_agent_owner_name: Option<String>,
```

Update any test constructors to set these fields to `None`.

- [ ] **Step 4: Update response label**

In `cloud_group_response_body`, compute:

```rust
let shared_agent_label = request_envelope.message.as_ref().and_then(|message| {
    let agent_name = message.target_cloud_agent_name.as_deref()?.trim();
    if agent_name.is_empty() {
        return None;
    }
    let owner_name = message
        .target_cloud_agent_owner_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| owner.display_name.trim());
    if owner_name.is_empty() {
        Some(agent_name.to_string())
    } else {
        Some(format!("{} · {}'s Agent", agent_name, owner_name))
    }
});
let sender_display_name = shared_agent_label.unwrap_or_else(|| {
    if owner.display_name.trim().is_empty() {
        "Kordi".to_string()
    } else {
        format!("{}'s Kordi", owner.display_name.trim())
    }
});
```

- [ ] **Step 5: Validate participant-shared target before queue/run**

Find the fallback enqueue path in `runs.rs` where a group request is claimed or enqueued. Before accepting a `target_cloud_agent_id`, perform:

```rust
let participants = crate::auth::routes::cloud_session_participants(pool, &session_id).await?;
let requester_allowed = participants.iter().any(|id| id == &requester_account_id);
let owner_allowed = participants.iter().any(|id| id == &owner_account_id);
```

If target Cloud Agent metadata exists, query:

```sql
SELECT access_scope, status FROM cloud_agent_definitions WHERE agent_id = $1 AND owner_account_id = $2
```

Require `status = 'active'` and `access_scope = 'participant_conversations'`. If any check fails, mark the run failed with an unavailable error code or return no claim so the desktop unavailable notice can be shown.

Use error text:

```rust
"Shared Cloud Agent is no longer available in this conversation."
```

- [ ] **Step 6: Desktop transcript attribution test**

In `desktopTranscriptAdapter.test.tsx`, add a test with a Cloud group response envelope that includes sender display name `Project Driver · Shuyang's Agent`; assert mapped transcript sender equals that exact string.

- [ ] **Step 7: Verify and commit Task 5**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agent_runtime::runs::tests
cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e
pnpm --dir app/desktop exec tsx --test tests/desktopTranscriptAdapter.test.tsx
pnpm --dir app/desktop exec tsc --noEmit --pretty false
```

Expected: selected tests pass. If `cloud_agent_runtime_e2e` has unrelated environment setup failures, record the failure and keep the pure Rust unit tests plus desktop transcript tests as required evidence.

Commit:

```bash
git add bridges/cloud-server/src/auth/routes.rs \
  bridges/cloud-server/src/cloud_agent_runtime/runs.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs \
  app/desktop/src/features/chat/useDesktopTranscriptAdapter.ts \
  app/desktop/tests/desktopTranscriptAdapter.test.tsx
git commit -m "feat: validate and label shared cloud agent replies"
```

---

## Task 6: Final integration verification and PR

**Files:**
- Read-only verification plus PR body file at `/tmp/kordi-pr-587-body.md`.
- No production deploy in this task.

- [ ] **Step 1: Run focused desktop suite**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/cloudAgents.test.tsx \
  tests/cloudAgentMessages.test.tsx \
  tests/cloudBridgeState.test.tsx \
  tests/cloudGroupMessages.test.tsx \
  tests/desktopTranscriptAdapter.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 2: Run desktop TypeScript**

Run:

```bash
pnpm --dir app/desktop exec tsc --noEmit --pretty false
```

Expected: exits 0.

- [ ] **Step 3: Run Cloud server tests**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e
cargo test -p kordi-cloud-server cloud_agents::models::tests
cargo test -p kordi-cloud-server cloud_agent_runtime::runs::tests
```

Expected: all selected tests pass.

- [ ] **Step 4: Whitespace check**

Run:

```bash
git diff --check
```

Expected: no output, exit 0.

- [ ] **Step 5: Manual dev preview checklist**

Use the takotako dev Cloud URL, not production:

```bash
VITE_KORDI_CLOUD_API_BASE=https://korde-product-cloud.35.188.85.31.sslip.io \
KORDI_CLOUD_API_BASE=https://korde-product-cloud.35.188.85.31.sslip.io \
pnpm --dir app/desktop tauri dev
```

Manual checks:

- Owner creates Cloud Agent; access defaults to `Private — only me`.
- Second signed-in account in contact session with owner does not see private agent in mention picker.
- Owner changes access to `Shared in conversations with me`.
- Second account in contact session with owner sees `@AgentName` with `Owner's Agent` detail.
- Second account sends `@AgentName help`; response appears as `AgentName · Owner's Agent`.
- A group session with the owner offers the same shared agent.
- A session without the owner does not offer the shared agent.
- Owner changes access back to private; agent disappears after refresh/sync.

- [ ] **Step 6: Open PR**

Run:

```bash
git status --short
git push -u origin feature/issue-587-agent-participant-sharing-impl
gh pr create \
  --base main \
  --head feature/issue-587-agent-participant-sharing-impl \
  --title "feat: share cloud agents in owner conversations" \
  --body-file /tmp/kordi-pr-587-body.md
```

PR body must include:

```markdown
Closes #587

## Summary
- Adds participant-conversation Cloud Agent sharing access.
- Lets owners toggle Access from Agent settings.
- Adds mention-safe shared-agent lookup and participant-gated mention eligibility.
- Labels shared replies as the owner's agent.

## Verification
- [ ] pnpm --dir app/desktop exec tsx --test ...
- [ ] pnpm --dir app/desktop exec tsc --noEmit --pretty false
- [ ] cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e
- [ ] cargo test -p kordi-cloud-server cloud_agents::models::tests
- [ ] cargo test -p kordi-cloud-server cloud_agent_runtime::runs::tests
- [ ] git diff --check
```

---

## Self-Review

Spec coverage:
- Private default: Task 1 and Task 3.
- Owner Access toggle: Task 3.
- Mention only where owner participates: Task 4 and Task 5.
- Contact/group session support: Task 4 uses participant-gated conversation scope; Task 5 validates server session participants.
- Owner-attributed replies: Task 5.
- Non-owner prompt/routing privacy: Task 2 shared summary omits private fields.
- Tests/manual checks: Tasks 1-6.

No task asks the implementer to expose owner-local tools/files. Runtime validation is required before shared execution. If a session type lacks reliable server-side membership, Task 5 requires keeping shared execution disabled rather than trusting client metadata.
