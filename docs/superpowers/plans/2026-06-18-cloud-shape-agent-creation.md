# Cloud Shape Agent Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `+ New agent` flow on the Agent page that uses an LLM Shape-style wizard to create creator-owned Cloud-synced Agents, with an access-control menu for future sharing.

**Architecture:** Add a Cloud Agent Definition backend table/API, a desktop Cloud client/sync adapter, and a focused Agent creation dialog. Agent creation is two-phase: generate an LLM draft locally/client-side first, then save the reviewed Agent definition to Cloud. MVP visibility is `private` to the creator's Cloud account; an access menu exposes the current access state and can later support contacts/workspaces/public sharing.

**Tech Stack:** Rust/Axum/sqlx Postgres cloud-server, React/TypeScript desktop app, existing Cloud auth/sync event infrastructure, existing Agent page panes and composer model/provider routing.

---

## Product Decisions Locked For MVP

- New Agents are **not public by default**.
- New Agents are synced only to the creator's own Cloud account/devices.
- The UI includes an **Access** menu/control, but MVP options are intentionally narrow:
  - `Private — only me` enabled/default
  - `Shared with contacts/workspace` disabled with “coming later” copy unless implemented in a later task
  - `Public` disabled/hidden unless explicitly scoped later
- A created Agent should appear on the creator's other signed-in devices through Cloud sync.
- No direct dependency on `~/.bb-agent/agents` as source of truth. The bb-agent Shape extension is a flow/artifact reference only.

---

## Shape Flow Reference Summary

The reference at `https://github.com/shuyhere/bb-agent/tree/master/extensions/shape` implements `/shape new` as:

1. **Resources** — URLs, local files, pasted descriptions.
2. **Identity** — user describes role/audience/tone.
3. **Ingest** — crawl/read/summarize resources into progressive knowledge.
4. **Draft/confirm** — propose name, role, audience, tone, sources, skills, boundaries.
5. **Build** — write `agent.json`, `SYSTEM_PROMPT.md`, `knowledge/`, `skills/`, and `tools/search_knowledge.py`.
6. **Registry** — add to `~/.bb-agent/agents/registry.json`.

Kordi should adapt this as a Cloud-native UI wizard:

- `agent.json` maps to a Cloud Agent Definition row.
- `SYSTEM_PROMPT.md` maps to `system_prompt` and prompt preview.
- `knowledge/` maps to structured source/resource summaries in MVP; full knowledge pages can follow later.
- `skills/` maps to suggested skill metadata first, not automatic unsafe tool installation.
- Registry maps to Cloud `GET /v1/cloud/agents` plus sync events.

---

## Target File Map

### Cloud server

- Create `bridges/cloud-server/migrations/0025_cloud_agent_definitions.sql`
  - Adds Cloud-owned Agent definitions.
- Modify `bridges/cloud-server/src/pg/pool.rs`
  - Embeds migration version 25.
- Create `bridges/cloud-server/src/cloud_agents/mod.rs`
  - Module exports.
- Create `bridges/cloud-server/src/cloud_agents/models.rs`
  - Request/response structs and validation helpers.
- Create `bridges/cloud-server/src/cloud_agents/store.rs`
  - Database CRUD and sync-event insertion.
- Create `bridges/cloud-server/src/cloud_agents/routes.rs`
  - Authenticated HTTP routes.
- Modify `bridges/cloud-server/src/lib.rs`
  - Exports `cloud_agents` module.
- Modify `bridges/cloud-server/src/server.rs`
  - Merges Cloud Agent routes.
- Modify `bridges/cloud-server/src/events/mod.rs`
  - Adds optional live event publisher for `agent.definition.upserted`.
- Create `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`
  - End-to-end backend tests.

### Desktop cloud client/sync

- Create `app/desktop/src/features/cloud/cloudAgentsClient.ts`
  - Pure HTTP client wrapper for `/v1/cloud/agents`.
- Create `app/desktop/src/features/cloud/cloudAgents.ts`
  - Normalizers, merge reducers, Agent conversion helpers.
- Modify `app/desktop/src/features/cloud/authClient.ts`
  - Adds types and methods, or re-exports from `cloudAgentsClient.ts` depending on existing style.
- Modify `app/desktop/src/features/cloud/cloudDiffSync.ts`
  - Applies `agent.definition.upserted` and `agent.definition.archived` events.
- Modify relevant cloud state owner, likely `app/desktop/src/app/useKordiAppModel.ts` or adjacent hook.
  - Stores cloud Agent definitions and refreshes them on auth.

### Desktop Agent UI

- Modify `app/desktop/src/kordi-app/types.ts`
  - Extends `Agent` with Cloud definition metadata.
- Modify `app/desktop/src/kordi-app/agents/model.ts`
  - Adds creation/access props and draft types.
- Modify `app/desktop/src/kordi-app/agents/AgentsPage.tsx`
  - Owns dialog open state or receives it via props.
- Modify `app/desktop/src/kordi-app/agents/AgentsSidebar.tsx`
  - Adds `+ New agent` button in header.
- Create `app/desktop/src/kordi-app/agents/AgentCreateDialog.tsx`
  - Shape wizard UI.
- Create `app/desktop/src/kordi-app/agents/useAgentCreateFlow.ts`
  - Wizard state machine and actions.
- Create `app/desktop/src/kordi-app/agents/shapeAgentDraft.ts`
  - Draft validation, fallback generation helpers, resource parsing.
- Create `app/desktop/src/kordi-app/agents/shapeAgentPrompts.ts`
  - LLM prompt templates.
- Modify `app/desktop/src/kordi-app/agents/AgentDetailPane.tsx`
  - Shows Cloud/private status and Access menu for cloud Agents.
- Modify `app/desktop/src/kordi-app/agents/AgentContentPane.tsx`
  - Shows prompt/source/skills from Cloud definition for cloud Agents.
- Modify `app/desktop/src/app/assembleMainContentSlot.tsx`
  - Passes create/save/list handlers to `AgentsPage`.
- Modify `app/desktop/src/app/useWorkspaceViewModels.ts`
  - Merges Cloud Agent definitions into `displayedAgents`.

### Tests

- Create `app/desktop/tests/cloudAgents.test.tsx`
- Create `app/desktop/tests/agentCreateDialog.test.tsx`
- Create `app/desktop/tests/agentShapeDraft.test.ts`
- Update `app/desktop/tests/cloudDiffSync.test.tsx`
- Update/add Agent page tests if a suitable test file exists.

---

## Backend Data Model

### Task 1: Add Cloud Agent Definitions schema

**Files:**
- Create: `bridges/cloud-server/migrations/0025_cloud_agent_definitions.sql`
- Modify: `bridges/cloud-server/src/pg/pool.rs`

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS cloud_agent_definitions (
    agent_id            TEXT PRIMARY KEY,
    owner_account_id    TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    access_scope        TEXT NOT NULL DEFAULT 'private',
    status              TEXT NOT NULL DEFAULT 'active',
    name                TEXT NOT NULL,
    role                TEXT NOT NULL,
    description         TEXT,
    system_prompt       TEXT NOT NULL,
    source_summary      TEXT,
    boundaries_json     JSONB NOT NULL DEFAULT '[]',
    resources_json      JSONB NOT NULL DEFAULT '[]',
    skills_json         JSONB NOT NULL DEFAULT '[]',
    model_routing_json  JSONB NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    archived_at         TEXT,
    CONSTRAINT cloud_agent_definitions_access_scope_check
        CHECK (access_scope IN ('private')),
    CONSTRAINT cloud_agent_definitions_status_check
        CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_owner_updated
    ON cloud_agent_definitions(owner_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_owner_status
    ON cloud_agent_definitions(owner_account_id, status, updated_at DESC);
```

- [ ] **Step 2: Embed migration**

Add migration 25 to `bridges/cloud-server/src/pg/pool.rs` after version 24:

```rust
EmbeddedMigration {
    version: 25,
    description: "cloud agent definitions",
    sql: include_str!("../../migrations/0025_cloud_agent_definitions.sql"),
},
```

- [ ] **Step 3: Verify migration compiles**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agent_definitions -- --nocapture
```

Expected initially: test target may not exist until Task 2, but the crate should compile once tests are added.

---

### Task 2: Add backend models and validation

**Files:**
- Create: `bridges/cloud-server/src/cloud_agents/mod.rs`
- Create: `bridges/cloud-server/src/cloud_agents/models.rs`
- Modify: `bridges/cloud-server/src/lib.rs`

- [ ] **Step 1: Add module export**

`bridges/cloud-server/src/cloud_agents/mod.rs`:

```rust
pub mod models;
pub mod routes;
pub mod store;
```

`bridges/cloud-server/src/lib.rs`:

```rust
pub mod cloud_agents;
```

- [ ] **Step 2: Define request/response types**

`models.rs` should define:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentResource {
    pub kind: String,
    pub value: String,
    pub title: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentSkill {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentDefinition {
    pub agent_id: String,
    pub owner_account_id: String,
    pub access_scope: String,
    pub status: String,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub source_summary: Option<String>,
    pub boundaries: Vec<String>,
    pub resources: Vec<CloudAgentResource>,
    pub skills: Vec<CloudAgentSkill>,
    pub model_routing: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCloudAgentRequest {
    pub access_scope: Option<String>,
    pub name: String,
    pub role: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub source_summary: Option<String>,
    pub boundaries: Vec<String>,
    pub resources: Vec<CloudAgentResource>,
    pub skills: Vec<CloudAgentSkill>,
    pub model_routing: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCloudAgentRequest {
    pub name: Option<String>,
    pub role: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub source_summary: Option<String>,
    pub boundaries: Option<Vec<String>>,
    pub resources: Option<Vec<CloudAgentResource>>,
    pub skills: Option<Vec<CloudAgentSkill>>,
    pub model_routing: Option<serde_json::Value>,
}
```

- [ ] **Step 3: Add validation helpers**

Add functions:

```rust
pub fn clean_required_text(value: &str, field: &str, max_len: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required"));
    }
    if trimmed.len() > max_len {
        return Err(format!("{field} is too long"));
    }
    Ok(trimmed.to_string())
}

pub fn clean_access_scope(value: Option<&str>) -> Result<String, String> {
    match value.unwrap_or("private").trim() {
        "" | "private" => Ok("private".to_string()),
        _ => Err("Only private agent access is supported in this version".to_string()),
    }
}
```

- [ ] **Step 4: Add unit tests in `models.rs`**

Test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_scope_defaults_to_private() {
        assert_eq!(clean_access_scope(None).unwrap(), "private");
        assert_eq!(clean_access_scope(Some("")).unwrap(), "private");
    }

    #[test]
    fn access_scope_rejects_public_for_mvp() {
        assert!(clean_access_scope(Some("public")).is_err());
    }
}
```

Run:

```bash
cargo test -p kordi-cloud-server cloud_agents::models -- --nocapture
```

Expected: model tests pass.

---

### Task 3: Add backend store and routes

**Files:**
- Create: `bridges/cloud-server/src/cloud_agents/store.rs`
- Create: `bridges/cloud-server/src/cloud_agents/routes.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Modify: `bridges/cloud-server/src/events/mod.rs`
- Create: `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`

- [ ] **Step 1: Write failing e2e tests**

Tests should cover:

1. A signed-in account can create a private Agent.
2. Same account can list it.
3. Another account cannot list it.
4. Another account cannot update/archive it.
5. Owner can archive it.
6. Sync events include `agent.definition.upserted` and `agent.definition.archived` for the owner account.

- [ ] **Step 2: Implement `store.rs`**

Required functions:

```rust
pub async fn create_agent_definition(
    pool: &sqlx_postgres::PgPool,
    owner_account_id: &str,
    input: CreateCloudAgentRequest,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CloudAgentDefinition, sqlx::Error>;

pub async fn list_agent_definitions(
    pool: &sqlx_postgres::PgPool,
    owner_account_id: &str,
) -> Result<Vec<CloudAgentDefinition>, sqlx::Error>;

pub async fn update_agent_definition(
    pool: &sqlx_postgres::PgPool,
    owner_account_id: &str,
    agent_id: &str,
    input: UpdateCloudAgentRequest,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Option<CloudAgentDefinition>, sqlx::Error>;

pub async fn archive_agent_definition(
    pool: &sqlx_postgres::PgPool,
    owner_account_id: &str,
    agent_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Option<CloudAgentDefinition>, sqlx::Error>;
```

- [ ] **Step 3: Insert sync events in store**

For create/update:

```sql
INSERT INTO cloud_sync_events
(account_id, event_type, peer_account_id, message_id, payload_json, occurred_at)
VALUES ($1, 'agent.definition.upserted', NULL, NULL, $2, $3)
```

For archive:

```sql
INSERT INTO cloud_sync_events
(account_id, event_type, peer_account_id, message_id, payload_json, occurred_at)
VALUES ($1, 'agent.definition.archived', NULL, NULL, $2, $3)
```

- [ ] **Step 4: Implement `routes.rs`**

Routes:

```rust
pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/agents", get(list_agents).post(create_agent))
        .route("/v1/cloud/agents/:agent_id", put(update_agent).delete(archive_agent))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::routes::cloud_session_middleware,
        ))
        .with_state(state)
}
```

- [ ] **Step 5: Merge routes in `server.rs`**

```rust
.merge(crate::cloud_agents::routes::routes(state.clone()))
```

- [ ] **Step 6: Run backend tests**

```bash
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e -- --nocapture
```

Expected: all e2e tests pass.

---

## Desktop Cloud Agent State

### Task 4: Add Cloud Agent client and normalizers

**Files:**
- Create: `app/desktop/src/features/cloud/cloudAgentsClient.ts`
- Create: `app/desktop/src/features/cloud/cloudAgents.ts`
- Create: `app/desktop/tests/cloudAgents.test.tsx`

- [ ] **Step 1: Write client/normalizer tests**

Tests:

- Normalizes valid Cloud Agent payload.
- Rejects missing `agentId`, `name`, `role`, `systemPrompt`.
- Converts private Cloud Agent definition to Kordi `Agent` with:
  - `status: 'Cloud'`
  - `role` from definition
  - `systemPrompt` from definition
  - `isOwned: true`
  - `exposesIdentityFiles: false`
  - `loadedSkills` from definition skills

- [ ] **Step 2: Implement types**

`cloudAgentsClient.ts`:

```ts
export type CloudAgentAccessScope = 'private';
export type CloudAgentStatus = 'active' | 'archived';

export type CloudAgentResource = {
  kind: 'url' | 'file' | 'text' | string;
  value: string;
  title?: string | null;
  summary?: string | null;
};

export type CloudAgentSkill = {
  name: string;
  description: string;
};

export type CloudAgentDefinition = {
  agentId: string;
  ownerAccountId: string;
  accessScope: CloudAgentAccessScope;
  status: CloudAgentStatus;
  name: string;
  role: string;
  description: string | null;
  systemPrompt: string;
  sourceSummary: string | null;
  boundaries: string[];
  resources: CloudAgentResource[];
  skills: CloudAgentSkill[];
  modelRouting: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};
```

- [ ] **Step 3: Implement HTTP methods**

Methods:

```ts
listCloudAgents(token: string): Promise<CloudAgentDefinition[]>
createCloudAgent(token: string, input: CreateCloudAgentInput): Promise<CloudAgentDefinition>
updateCloudAgent(token: string, agentId: string, input: UpdateCloudAgentInput): Promise<CloudAgentDefinition>
archiveCloudAgent(token: string, agentId: string): Promise<CloudAgentDefinition>
```

- [ ] **Step 4: Implement conversion helper**

`cloudAgents.ts`:

```ts
export function cloudAgentDefinitionToAgent(definition: CloudAgentDefinition): Agent {
  return {
    name: definition.name,
    id: `cloud-agent:${definition.agentId}`,
    role: definition.role,
    messaging: 'Cloud synced',
    status: definition.accessScope === 'private' ? 'Private' : 'Cloud',
    tasks: 0,
    defaultProvider: 'Cloud',
    defaultModel: typeof definition.modelRouting.defaultModel === 'string' ? definition.modelRouting.defaultModel : '',
    bridgesConfig: 'Cloud Agent',
    contactId: `cloud-agent:${definition.agentId}`,
    systemPrompt: definition.systemPrompt,
    xMd: definition.sourceSummary ?? definition.description ?? '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: definition.skills.map((skill) => skill.name),
    loadedPlugins: [],
    lastActivities: [definition.updatedAt],
    exposesIdentityFiles: false,
    exposesLoadedSkills: true,
    exposesLoadedTools: false,
    exposesLoadedPlugins: false,
    isOwned: true,
    isBridgeRegistered: true,
    avatarSeed: definition.agentId,
  };
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAgents.test.tsx
```

Expected: tests pass.

---

### Task 5: Apply Cloud Agent sync events

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudDiffSync.ts`
- Test: `app/desktop/tests/cloudDiffSync.test.tsx`

- [ ] **Step 1: Add failing sync tests**

Test that:

- `agent.definition.upserted` adds/replaces a Cloud Agent definition.
- `agent.definition.archived` removes or marks archived.
- Malformed events are ignored.

- [ ] **Step 2: Add reducer helpers**

Add functions in `cloudAgents.ts`:

```ts
export function applyCloudAgentSyncEvents(
  current: Record<string, CloudAgentDefinition>,
  events: CloudSyncEvent[],
): Record<string, CloudAgentDefinition>;
```

- [ ] **Step 3: Integrate where cloud sync state is collected**

Use the existing cloud sync polling path to update a `cloudAgentsById` state map near other Cloud state.

- [ ] **Step 4: Run sync tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudDiffSync.test.tsx tests/cloudAgents.test.tsx
```

Expected: tests pass.

---

## Shape Draft Generation

### Task 6: Resource parsing and draft schema

**Files:**
- Create: `app/desktop/src/kordi-app/agents/shapeAgentDraft.ts`
- Test: `app/desktop/tests/agentShapeDraft.test.ts`

- [ ] **Step 1: Write failing tests**

Test:

- Parses newline/comma separated resources.
- Classifies `https://` as URL.
- Classifies long/plain text as text.
- Rejects empty creation input.
- Validates LLM draft requires name, role, system prompt, boundaries.

- [ ] **Step 2: Implement types and parser**

```ts
export type ShapeAgentResourceInput = {
  kind: 'url' | 'text' | 'file';
  value: string;
};

export type ShapeAgentDraft = {
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  sourceSummary: string;
  boundaries: string[];
  skills: Array<{ name: string; description: string }>;
};
```

- [ ] **Step 3: Implement parser**

```ts
export function parseShapeResources(raw: string): ShapeAgentResourceInput[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({
      kind: /^https?:\/\//i.test(value) ? 'url' : 'text',
      value,
    }));
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentShapeDraft.test.ts
```

Expected: tests pass.

---

### Task 7: LLM prompt for Shape draft

**Files:**
- Create: `app/desktop/src/kordi-app/agents/shapeAgentPrompts.ts`
- Test: `app/desktop/tests/agentShapeDraft.test.ts`

- [ ] **Step 1: Write prompt tests**

Assert prompt includes:

- resources
- identity
- private Cloud access constraint
- output JSON schema
- Shape role templates
- boundaries requirement

- [ ] **Step 2: Implement prompt builder**

The prompt must instruct the model to return JSON only:

```ts
export function buildShapeAgentDraftPrompt(input: {
  resources: ShapeAgentResourceInput[];
  identity: string;
}): string {
  return `You are creating a Kordi Cloud Agent draft.

Access model:
- This Agent is private to the creator's Cloud account by default.
- Do not claim it is public or shared with other people.

Use this Shape-style process:
1. Infer the best Agent role from the resources and identity.
2. Generate a clear name, role, description, system prompt, source summary, boundaries, and suggested skills.
3. Prefer these role patterns when applicable: customer support, technical support, shopping assistant, content/brand voice, personal assistant, tutor, internal knowledge base.

Resources:
${input.resources.map((resource) => `- ${resource.kind}: ${resource.value}`).join('\n') || '- description-only'}

Identity intent:
${input.identity.trim()}

Return only JSON matching:
{
  "name": "string",
  "role": "string",
  "description": "string",
  "systemPrompt": "string",
  "sourceSummary": "string",
  "boundaries": ["string"],
  "skills": [{ "name": "string", "description": "string" }]
}`;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentShapeDraft.test.ts
```

Expected: tests pass.

---

## Agent Creation UI

### Task 8: Build `AgentCreateDialog`

**Files:**
- Create: `app/desktop/src/kordi-app/agents/AgentCreateDialog.tsx`
- Create: `app/desktop/src/kordi-app/agents/useAgentCreateFlow.ts`
- Test: `app/desktop/tests/agentCreateDialog.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Test:

- Dialog opens with title `New agent`.
- Step 1 has resources input.
- Step 2 has identity input.
- Access menu shows `Private — only me` selected.
- Generate button calls `onGenerateDraft`.
- Review screen displays draft.
- Create button calls `onCreateAgent` with `accessScope: 'private'`.
- Error state keeps inputs.

- [ ] **Step 2: Implement dialog props**

```ts
export type AgentCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerateDraft: (input: ShapeAgentCreateInput) => Promise<ShapeAgentDraft>;
  onCreateAgent: (input: CreateCloudAgentInput) => Promise<CloudAgentDefinition>;
  onCreated: (agent: CloudAgentDefinition) => void;
};
```

- [ ] **Step 3: Implement wizard steps**

State:

```ts
type CreateStep = 'resources' | 'identity' | 'generating' | 'review' | 'saving' | 'error';
```

Access menu:

- enabled item: `Private — only me`
- disabled item: `Share with people… Coming later`
- disabled item: `Workspace… Coming later`

- [ ] **Step 4: Run UI test**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentCreateDialog.test.tsx
```

Expected: tests pass.

---

### Task 9: Add `+ New agent` entry point

**Files:**
- Modify: `app/desktop/src/kordi-app/agents/AgentsSidebar.tsx`
- Modify: `app/desktop/src/kordi-app/agents/AgentsPage.tsx`
- Modify: `app/desktop/src/kordi-app/agents/model.ts`
- Test: `app/desktop/tests/agentCreateDialog.test.tsx`

- [ ] **Step 1: Write failing test**

Assert `AgentsPage` renders a `New agent` button and clicking it opens the dialog.

- [ ] **Step 2: Add props**

`AgentsPageProps`:

```ts
onCreateCloudAgent?: (input: CreateCloudAgentInput) => Promise<CloudAgentDefinition>;
onGenerateShapeAgentDraft?: (input: ShapeAgentCreateInput) => Promise<ShapeAgentDraft>;
onCloudAgentCreated?: (agent: CloudAgentDefinition) => void;
```

- [ ] **Step 3: Add sidebar button**

In `AgentsSidebar` header, add a compact button:

```tsx
<button type="button" aria-label="New agent" title="New agent" onClick={onCreateAgentClick}>+</button>
```

- [ ] **Step 4: Wire dialog in `AgentsPage`**

Keep dialog state local to `AgentsPage` unless app-level control is required.

- [ ] **Step 5: Run test**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentCreateDialog.test.tsx
```

Expected: tests pass.

---

## Agent Page Integration

### Task 10: Merge Cloud Agents into displayed Agents

**Files:**
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/assembleMainContentSlot.tsx`
- Test: `app/desktop/tests/cloudAgents.test.tsx`

- [ ] **Step 1: Write failing integration test**

Given a Cloud Agent definition in app model state, `displayedAgents` includes it as a Kordi `Agent`.

- [ ] **Step 2: Add state**

App model should hold:

```ts
const [cloudAgentsById, setCloudAgentsById] = useState<Record<string, CloudAgentDefinition>>({});
```

- [ ] **Step 3: Load on authenticated Cloud session**

When Cloud session is authenticated:

```ts
const agents = await cloudAgentsClient.listCloudAgents(session.token);
setCloudAgentsById(Object.fromEntries(agents.map((agent) => [agent.agentId, agent])));
```

- [ ] **Step 4: Merge into `displayedAgents`**

Append active, private Cloud Agents after local/bridge agents or in a separate group if the UI supports grouping.

- [ ] **Step 5: Select created Agent**

After creation:

```ts
setCloudAgentsById((current) => ({ ...current, [agent.agentId]: agent }));
setActiveAgentId(`cloud-agent:${agent.agentId}`);
```

- [ ] **Step 6: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAgents.test.tsx tests/agentCreateDialog.test.tsx
```

Expected: tests pass.

---

### Task 11: Cloud Agent detail/access menu

**Files:**
- Modify: `app/desktop/src/kordi-app/agents/AgentDetailPane.tsx`
- Modify: `app/desktop/src/kordi-app/agents/AgentContentPane.tsx`
- Test: `app/desktop/tests/agentCreateDialog.test.tsx` or new `app/desktop/tests/agentsPageCloudAccess.test.tsx`

- [ ] **Step 1: Write failing test**

For a Cloud Agent, the detail pane shows:

- `Private — only me`
- access menu button
- disabled future sharing entries

- [ ] **Step 2: Extend `Agent` type**

Add optional metadata:

```ts
cloudAgentId?: string;
cloudAgentAccessScope?: 'private';
cloudAgentOwnerAccountId?: string;
cloudAgentSourceSummary?: string | null;
cloudAgentBoundaries?: string[];
```

- [ ] **Step 3: Add Access menu UI**

Menu content:

- checked: `Private — only me`
- disabled: `Share with contacts…`
- disabled: `Workspace access…`

Copy:

> This Agent syncs to your Cloud account. Sharing controls will be enabled after contact/workspace permissions are implemented.

- [ ] **Step 4: Show Cloud source/boundaries**

In content/detail panes, show:

- source summary
- boundaries list
- suggested skills

- [ ] **Step 5: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentsPageCloudAccess.test.tsx tests/agentCreateDialog.test.tsx
```

Expected: tests pass.

---

## LLM Integration

### Task 12: Connect draft generation to model route

**Files:**
- Modify: `app/desktop/src/app/assembleMainContentSlot.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Possibly create: `app/desktop/src/features/chat/shapeAgentDraftGeneration.ts`
- Test: `app/desktop/tests/agentShapeDraft.test.ts`

- [ ] **Step 1: Decide invocation path**

MVP should use the existing local/desktop model invocation path if available. If no clean API exists, create a small wrapper that accepts a prompt and returns text using the same provider route used by Agent chat.

- [ ] **Step 2: Parse JSON safely**

Implement:

```ts
export function parseShapeAgentDraftJson(raw: string): ShapeAgentDraft | null;
```

Rules:

- Strip markdown fences.
- Parse JSON.
- Validate required fields.
- Limit arrays to safe sizes: max 10 boundaries, max 8 skills.

- [ ] **Step 3: Error handling**

If model output is invalid:

- show `The model returned an invalid draft. Try again or simplify the description.`
- preserve resources/identity
- do not save anything to Cloud

- [ ] **Step 4: Run tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/agentShapeDraft.test.ts tests/agentCreateDialog.test.tsx
```

Expected: tests pass.

---

## Verification Plan

Run focused tests after each task. Before PR:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/cloudAgents.test.tsx \
  tests/agentCreateDialog.test.tsx \
  tests/agentShapeDraft.test.ts \
  tests/cloudDiffSync.test.tsx

pnpm --dir app/desktop exec tsc --noEmit --pretty false

cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e -- --nocapture

git diff --check
```

Manual preview:

1. Start local Cloud API/tunnel.
2. Sign in as user A on desktop profile 1.
3. Open Agents page.
4. Click `+ New agent`.
5. Create description-only Agent.
6. Confirm Access menu says `Private — only me`.
7. Confirm Agent appears in user A Agent list.
8. Sign in as same user A on another profile/device.
9. Confirm Agent syncs there.
10. Sign in as user B.
11. Confirm user B does not see user A’s private Agent.

---

## Future Sharing Menu Expansion

Do not implement these in MVP unless separately scoped:

- Share with selected contacts.
- Share with a group/workspace.
- Public Cloud Agent directory.
- Import/export to Shape filesystem layout.
- Installing generated executable tools without sandbox/review.

