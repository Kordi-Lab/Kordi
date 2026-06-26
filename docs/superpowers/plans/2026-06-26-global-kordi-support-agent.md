# Global Kordi Support Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centrally hosted, read-only `Kordi Support` contact that appears for every Cloud user and routes messages to a server-managed Kordi support agent.

**Architecture:** Reuse the existing Cloud contacts, direct-message, Cloud Agent definition, fallback-run, and hosted runner pipeline. The server appends a virtual system contact to every contact list, seeds/locks the backing Cloud Agent definition for the configured support owner account, accepts targeted messages to that system contact without a normal accepted-contact row, and claims a hosted fallback run immediately. Desktop treats the row as a locked Cloud agent contact and encodes all messages to it with `targetCloudAgentId` metadata.

**Tech Stack:** Rust/Axum/Postgres/sqlx for Cloud server, Rust runner for hosted agent execution, React/TypeScript/Tauri desktop, node:test/tsx for desktop tests, cargo tests for server/runner tests.

---

## File Structure

### Server
- Create: `bridges/cloud-server/migrations/0027_system_support_agent.sql`
  - Adds `is_system_managed` to `cloud_agent_definitions` so support definition can be locked.
- Modify: `bridges/cloud-server/src/pg/pool.rs`
  - Registers migration 0027.
- Create: `bridges/cloud-server/src/support_agent.rs`
  - Owns support-agent config, constants, prompt, contact summary construction, direct-message target parsing, and bootstrap helper.
- Modify: `bridges/cloud-server/src/lib.rs`
  - Exports `support_agent` module.
- Modify: `bridges/cloud-server/src/server.rs`
  - Runs support-agent bootstrap after migrations/pool setup path is available through `ServerState` startup.
- Modify: `bridges/cloud-server/src/cloud_agents/models.rs`
  - Adds `systemManaged` response field and keeps create/update request fields unchanged.
- Modify: `bridges/cloud-server/src/cloud_agents/store.rs`
  - Reads/writes `is_system_managed`, upserts configured support definition, and rejects update/archive for system-managed agents.
- Modify: `bridges/cloud-server/src/cloud_agents/routes.rs`
  - Maps `SystemManaged` store errors to `403`.
- Modify: `bridges/cloud-server/src/auth/routes.rs`
  - Appends virtual support contact to `GET /v1/cloud/contacts`; allows targeted support messages without normal contact acceptance; enqueues support fallback runs immediately.
- Test: `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`
  - DB-backed route tests for bootstrap, default contact listing, locked definition behavior, and message/run creation.

### Desktop
- Modify: `app/desktop/src/features/cloud/authClient.ts`
  - Extends `CloudContactSummary` with optional system-agent metadata.
- Modify: `app/desktop/src/kordi-app/types.ts`
  - Extends `Contact` with optional `systemContact`, `locked`, `targetCloudAgentId`, `targetCloudAgentOwnerAccountId`, `targetCloudAgentName`, and `targetCloudAgentOwnerName`.
- Modify: `app/desktop/src/features/cloud/useCloudContacts.ts`
  - Maps system contact summaries to locked `Contact` rows with agent runtime metadata.
- Modify: `app/desktop/src/features/cloud/CloudContactsAdapter.tsx`
  - Keeps system contacts visible and non-addable; labels active details correctly.
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
  - Builds system support contact conversations as agent-targeted direct sessions.
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Encodes messages to locked support contacts using `encodeCloudDirectMessageEnvelope` with `targetCloudAgentId` metadata.
- Test: `app/desktop/tests/cloudSupportAgent.test.tsx`
  - Contact mapping, locked UI state, bridge host peer generation, and send-body encoding tests.

### Deployment / Ops
- Modify: `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
  - Documents/env-passes support-agent config names.
- Modify: `docs/hosted-cloud-developer-guide.md`
  - Documents configuring the support agent owner/account/auth source on takotako.

---

## Server Environment Contract

Use these environment variables. They are explicit so the support agent can be disabled in local dev and enabled on takotako without hardcoding user secrets.

```text
KORDI_SUPPORT_AGENT_ENABLED=true
KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID=acct_<admin-or-system-owner>
KORDI_SUPPORT_AGENT_ID=cloud_agent_kordi_support
KORDI_SUPPORT_AGENT_NAME=Kordi Support
KORDI_SUPPORT_AGENT_DESCRIPTION=Ask questions about Kordi or suggest improvements.
KORDI_SUPPORT_AGENT_DEFAULT_MODEL=<model id used by hosted runner>
KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER=openai
KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE=<server auth choice already available on takotako>
```

`KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID` must be an existing Cloud account that has a current provider-auth snapshot. On the test server this is the account whose auth is already used for hosted Cloud Agent testing.

---

### Task 1: Add server support-agent config and system-managed agent schema

**Files:**
- Create: `bridges/cloud-server/src/support_agent.rs`
- Create: `bridges/cloud-server/migrations/0027_system_support_agent.sql`
- Modify: `bridges/cloud-server/src/pg/pool.rs`
- Modify: `bridges/cloud-server/src/lib.rs`
- Test: `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`

- [ ] **Step 1: Write migration source test**

Add `bridges/cloud-server/tests/cloud_support_agent_e2e.rs` with this initial source-level test:

```rust
#[test]
fn support_agent_migration_is_registered_and_adds_system_managed_flag() {
    let pool_source = std::fs::read_to_string("src/pg/pool.rs").expect("read pool source");
    assert!(pool_source.contains("0027_system_support_agent.sql"));

    let migration = std::fs::read_to_string("migrations/0027_system_support_agent.sql")
        .expect("read support agent migration");
    assert!(migration.contains("ALTER TABLE cloud_agent_definitions"));
    assert!(migration.contains("is_system_managed"));
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_migration_is_registered -- --nocapture
```

Expected: FAIL because `cloud_support_agent_e2e.rs` or migration registration does not exist.

- [ ] **Step 3: Add migration**

Create `bridges/cloud-server/migrations/0027_system_support_agent.sql`:

```sql
ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS is_system_managed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_system_managed
    ON cloud_agent_definitions(is_system_managed, status, agent_id)
    WHERE is_system_managed = TRUE;
```

- [ ] **Step 4: Register migration**

In `bridges/cloud-server/src/pg/pool.rs`, add the next migration entry after 0026:

```rust
Migration {
    version: 27,
    name: "system_support_agent",
    sql: include_str!("../../migrations/0027_system_support_agent.sql"),
},
```

- [ ] **Step 5: Create support config module**

Create `bridges/cloud-server/src/support_agent.rs`:

```rust
use serde::{Deserialize, Serialize};

pub const DEFAULT_SUPPORT_AGENT_ID: &str = "cloud_agent_kordi_support";
pub const DEFAULT_SUPPORT_AGENT_NAME: &str = "Kordi Support";
pub const DEFAULT_SUPPORT_AGENT_DESCRIPTION: &str = "Ask questions about Kordi or suggest improvements.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportAgentConfig {
    pub enabled: bool,
    pub owner_account_id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub default_model: Option<String>,
    pub default_auth_provider: Option<String>,
    pub default_auth_choice: Option<String>,
}

impl SupportAgentConfig {
    pub fn from_env() -> Option<Self> {
        let enabled = std::env::var("KORDI_SUPPORT_AGENT_ENABLED")
            .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !enabled {
            return None;
        }
        let owner_account_id = std::env::var("KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID").ok()?.trim().to_string();
        if owner_account_id.is_empty() {
            return None;
        }
        Some(Self {
            enabled,
            owner_account_id,
            agent_id: std::env::var("KORDI_SUPPORT_AGENT_ID").unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_ID.to_string()).trim().to_string(),
            name: std::env::var("KORDI_SUPPORT_AGENT_NAME").unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_NAME.to_string()).trim().to_string(),
            description: std::env::var("KORDI_SUPPORT_AGENT_DESCRIPTION").unwrap_or_else(|_| DEFAULT_SUPPORT_AGENT_DESCRIPTION.to_string()).trim().to_string(),
            default_model: std::env::var("KORDI_SUPPORT_AGENT_DEFAULT_MODEL").ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
            default_auth_provider: std::env::var("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER").ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
            default_auth_choice: std::env::var("KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE").ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        })
    }

    pub fn model_routing_json(&self) -> serde_json::Value {
        serde_json::json!({
            "defaultModel": self.default_model,
            "defaultAuthProvider": self.default_auth_provider,
            "defaultAuthChoice": self.default_auth_choice,
        })
    }
}

pub fn support_agent_system_prompt() -> String {
    r#"You are Kordi Support, the official help agent for Kordi.

Your job:
- Answer questions about how to use Kordi clearly and concisely.
- Help users understand chats, contacts, groups, agents, tasks, reminders, pins, artifacts, Cloud sync, and provider setup.
- Accept product suggestions and summarize them back to the user.
- Be honest when something is not implemented or when you need a human maintainer.

Boundaries:
- Do not reveal provider keys, server internals, raw runtime ids, or hidden Cloud infrastructure details.
- Do not claim to create GitHub issues or admin tickets unless a tool explicitly confirms that happened.
- Do not access private user data outside the current support conversation.
"#.trim().to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportDirectMessageEnvelope {
    pub schema_version: i64,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub target_cloud_agent_id: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_name: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_owner_account_id: Option<String>,
    #[serde(default)]
    pub target_cloud_agent_owner_name: Option<String>,
}
```

- [ ] **Step 6: Export module**

In `bridges/cloud-server/src/lib.rs`, add:

```rust
pub mod support_agent;
```

- [ ] **Step 7: Run test and verify it passes**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_migration_is_registered -- --nocapture
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bridges/cloud-server/src/support_agent.rs bridges/cloud-server/src/lib.rs bridges/cloud-server/src/pg/pool.rs bridges/cloud-server/migrations/0027_system_support_agent.sql bridges/cloud-server/tests/cloud_support_agent_e2e.rs
git commit -m "feat: add support agent server config"
```

---

### Task 2: Bootstrap and lock the server-managed support Cloud Agent definition

**Files:**
- Modify: `bridges/cloud-server/src/cloud_agents/models.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/store.rs`
- Modify: `bridges/cloud-server/src/cloud_agents/routes.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_definitions_e2e.rs`
- Test: `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`

- [ ] **Step 1: Write model/source tests**

Append to `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`:

```rust
#[test]
fn support_agent_definition_is_system_managed_and_locked_in_source() {
    let models = std::fs::read_to_string("src/cloud_agents/models.rs").expect("read models");
    let store = std::fs::read_to_string("src/cloud_agents/store.rs").expect("read store");
    let routes = std::fs::read_to_string("src/cloud_agents/routes.rs").expect("read routes");

    assert!(models.contains("system_managed"));
    assert!(store.contains("upsert_system_support_agent_definition"));
    assert!(store.contains("CloudAgentStoreError::SystemManaged"));
    assert!(routes.contains("system_managed_cloud_agent"));
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_definition_is_system_managed -- --nocapture
```

Expected: FAIL because model/store/routes do not contain the new code.

- [ ] **Step 3: Extend model response**

In `bridges/cloud-server/src/cloud_agents/models.rs`, add field to `CloudAgentDefinition`:

```rust
#[serde(rename = "systemManaged")]
pub system_managed: bool,
```

Do not add this field to `CreateCloudAgentRequest` or `UpdateCloudAgentRequest`; normal users cannot set it.

- [ ] **Step 4: Extend store error**

In `bridges/cloud-server/src/cloud_agents/store.rs`, extend `CloudAgentStoreError`:

```rust
#[derive(Debug)]
pub enum CloudAgentStoreError {
    Invalid(String),
    SystemManaged,
    Database(sqlx_core::Error),
}
```

Update `From<sqlx_core::Error>` to keep mapping DB errors to `Database`.

- [ ] **Step 5: Add `is_system_managed` to row mapping**

Update the store row tuple used for agent definitions to include `bool` as the last field:

```rust
type AgentRow = (
    String, String, String, String, String, Option<String>, String, Option<String>,
    serde_json::Value, serde_json::Value, serde_json::Value, serde_json::Value,
    String, String, Option<String>, bool,
);
```

Update `row_to_agent_definition` to set:

```rust
system_managed: row.15,
```

Update every `SELECT ... FROM cloud_agent_definitions` projection to include `is_system_managed` after `archived_at`.

- [ ] **Step 6: Reject update/archive for locked agents**

In `update_agent_definition`, before the `UPDATE`, query ownership and lock state:

```rust
let lock: Option<(bool,)> = query_as(
    "SELECT is_system_managed FROM cloud_agent_definitions WHERE owner_account_id = $1 AND agent_id = $2 AND status <> 'archived'",
)
.bind(owner_account_id)
.bind(agent_id)
.fetch_optional(pool)
.await?;
if matches!(lock, Some((true,))) {
    return Err(CloudAgentStoreError::SystemManaged);
}
```

Add the same guard to `archive_agent_definition`.

- [ ] **Step 7: Add support definition upsert helper**

In `bridges/cloud-server/src/cloud_agents/store.rs`, add:

```rust
pub async fn upsert_system_support_agent_definition(
    pool: &PgPool,
    config: &crate::support_agent::SupportAgentConfig,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CloudAgentDefinition, CloudAgentStoreError> {
    let prompt = crate::support_agent::support_agent_system_prompt();
    let row = query_as::<_, AgentRow>(
        "INSERT INTO cloud_agent_definitions (
            agent_id, owner_account_id, access_scope, status, name, role, description,
            system_prompt, source_summary, boundaries_json, resources_json, skills_json,
            model_routing_json, is_system_managed, created_at, updated_at
         ) VALUES ($1,$2,'participant_conversations','active',$3,'Kordi product support',$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$11)
         ON CONFLICT (agent_id) DO UPDATE SET
            owner_account_id = EXCLUDED.owner_account_id,
            access_scope = 'participant_conversations',
            status = 'active',
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            description = EXCLUDED.description,
            system_prompt = EXCLUDED.system_prompt,
            source_summary = EXCLUDED.source_summary,
            boundaries_json = EXCLUDED.boundaries_json,
            resources_json = EXCLUDED.resources_json,
            skills_json = EXCLUDED.skills_json,
            model_routing_json = EXCLUDED.model_routing_json,
            is_system_managed = TRUE,
            archived_at = NULL,
            updated_at = EXCLUDED.updated_at
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
                   system_prompt, source_summary, boundaries_json, resources_json, skills_json,
                   model_routing_json, created_at, updated_at, archived_at, is_system_managed"
    )
    .bind(&config.agent_id)
    .bind(&config.owner_account_id)
    .bind(&config.name)
    .bind(&config.description)
    .bind(prompt)
    .bind(Some("Official Kordi help and feedback agent."))
    .bind(serde_json::json!([
        "Do not reveal provider keys or hidden runtime metadata.",
        "Do not claim to file tickets unless tooling confirms it.",
        "Use only the current support conversation as user-provided context."
    ]))
    .bind(serde_json::json!([{ "kind": "product", "value": "kordi", "title": "Kordi product guidance" }]))
    .bind(serde_json::json!([{ "name": "support", "description": "Answer Kordi usage questions and collect suggestions." }]))
    .bind(config.model_routing_json())
    .bind(now.to_rfc3339())
    .fetch_one(pool)
    .await?;
    row_to_agent_definition(row)
}
```

- [ ] **Step 8: Map locked error to 403**

In `bridges/cloud-server/src/cloud_agents/routes.rs`, update `store_error_response`:

```rust
CloudAgentStoreError::SystemManaged => error_response(
    "system_managed_cloud_agent",
    "This Cloud Agent is managed by Kordi and cannot be changed here.",
    StatusCode::FORBIDDEN,
),
```

- [ ] **Step 9: Bootstrap at server startup**

In `bridges/cloud-server/src/server.rs`, after `ServerState` is available and before serving requests, call a helper when env config is enabled. If `server.rs` does not have a single async startup point, add this near the existing startup path that also initializes scheduled workers:

```rust
if let Some(config) = crate::support_agent::SupportAgentConfig::from_env() {
    match crate::cloud_agents::store::upsert_system_support_agent_definition(
        state.db_pool(),
        &config,
        chrono::Utc::now(),
    ).await {
        Ok(_) => eprintln!("[support_agent] system support agent ready"),
        Err(err) => eprintln!("[support_agent] bootstrap failed: {err:?}"),
    }
}
```

If the startup function is synchronous, create `ServerState::spawn_startup_tasks` as async in the same style as existing worker startup and await it from the binary entrypoint.

- [ ] **Step 10: Run focused tests**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_definition_is_system_managed -- --nocapture
cargo test -p kordi-cloud-server cloud_agents::models::tests --lib
cargo check -p kordi-cloud-server
```

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add bridges/cloud-server/src/cloud_agents/models.rs bridges/cloud-server/src/cloud_agents/store.rs bridges/cloud-server/src/cloud_agents/routes.rs bridges/cloud-server/src/server.rs bridges/cloud-server/tests/cloud_support_agent_e2e.rs
git commit -m "feat: bootstrap locked Kordi support agent"
```

---

### Task 3: Append default support contact and allow targeted support messages

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `bridges/cloud-server/src/support_agent.rs`
- Test: `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`

- [ ] **Step 1: Write source tests for contact list and message policy**

Append to `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`:

```rust
#[test]
fn support_agent_contact_is_appended_and_messages_are_allowed_without_contact_row() {
    let auth_routes = std::fs::read_to_string("src/auth/routes.rs").expect("read auth routes");
    let support = std::fs::read_to_string("src/support_agent.rs").expect("read support module");

    assert!(auth_routes.contains("support_agent_contact_summary"));
    assert!(auth_routes.contains("message_targets_support_agent"));
    assert!(auth_routes.contains("claim_support_agent_run_for_message"));
    assert!(support.contains("SupportContactSummaryFields"));
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_contact_is_appended -- --nocapture
```

Expected: FAIL because helpers are not implemented.

- [ ] **Step 3: Extend contact summary response struct**

In `bridges/cloud-server/src/auth/routes.rs`, find `ContactSummary` and add optional fields:

```rust
#[serde(rename = "contactId", skip_serializing_if = "Option::is_none")]
pub contact_id: Option<String>,
#[serde(rename = "contactKind", skip_serializing_if = "Option::is_none")]
pub contact_kind: Option<String>,
#[serde(rename = "locked", skip_serializing_if = "Option::is_none")]
pub locked: Option<bool>,
#[serde(rename = "targetCloudAgentId", skip_serializing_if = "Option::is_none")]
pub target_cloud_agent_id: Option<String>,
#[serde(rename = "targetCloudAgentName", skip_serializing_if = "Option::is_none")]
pub target_cloud_agent_name: Option<String>,
#[serde(rename = "targetCloudAgentOwnerAccountId", skip_serializing_if = "Option::is_none")]
pub target_cloud_agent_owner_account_id: Option<String>,
#[serde(rename = "targetCloudAgentOwnerName", skip_serializing_if = "Option::is_none")]
pub target_cloud_agent_owner_name: Option<String>,
#[serde(rename = "subtitle", skip_serializing_if = "Option::is_none")]
pub subtitle: Option<String>,
```

Update existing `ContactSummary` construction from DB rows to set these new fields to `None`.

- [ ] **Step 4: Add contact summary helper**

In `bridges/cloud-server/src/support_agent.rs`, add:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportContactSummaryFields {
    pub contact_id: String,
    pub account_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: String,
    pub target_cloud_agent_id: String,
    pub target_cloud_agent_name: String,
    pub target_cloud_agent_owner_account_id: String,
    pub target_cloud_agent_owner_name: String,
}

pub fn support_contact_summary_fields(config: &SupportAgentConfig, created_at: String) -> SupportContactSummaryFields {
    SupportContactSummaryFields {
        contact_id: "cloud-system:kordi-support".to_string(),
        account_id: config.owner_account_id.clone(),
        display_name: config.name.clone(),
        avatar_url: None,
        created_at,
        target_cloud_agent_id: config.agent_id.clone(),
        target_cloud_agent_name: config.name.clone(),
        target_cloud_agent_owner_account_id: config.owner_account_id.clone(),
        target_cloud_agent_owner_name: "Kordi".to_string(),
    }
}
```

- [ ] **Step 5: Append support contact in list_contacts**

In `list_contacts`, after DB rows are mapped into `contacts`, make it mutable and append:

```rust
let mut contacts = rows.into_iter().map(/* existing mapping */).collect::<Vec<_>>();
if let Some(config) = crate::support_agent::SupportAgentConfig::from_env() {
    if config.owner_account_id != session.account_id {
        let fields = crate::support_agent::support_contact_summary_fields(&config, chrono::Utc::now().to_rfc3339());
        contacts.insert(0, ContactSummary {
            account_id: fields.account_id,
            display_name: Some(fields.display_name),
            avatar_url: fields.avatar_url,
            node_id: None,
            created_at: fields.created_at,
            contact_id: Some(fields.contact_id),
            contact_kind: Some("system_agent".to_string()),
            locked: Some(true),
            target_cloud_agent_id: Some(fields.target_cloud_agent_id),
            target_cloud_agent_name: Some(fields.target_cloud_agent_name),
            target_cloud_agent_owner_account_id: Some(fields.target_cloud_agent_owner_account_id),
            target_cloud_agent_owner_name: Some(fields.target_cloud_agent_owner_name),
            subtitle: Some("Ask questions or suggest improvements".to_string()),
        });
    }
}
```

- [ ] **Step 6: Decode support targeted direct message**

In `bridges/cloud-server/src/support_agent.rs`, add base64url parsing:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";

pub fn parse_support_direct_message(body: &str) -> Option<SupportDirectMessageEnvelope> {
    let encoded = body.trim().strip_prefix(CLOUD_DIRECT_MESSAGE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn message_targets_support_agent(body: &str, peer_account_id: &str, config: &SupportAgentConfig) -> bool {
    let Some(envelope) = parse_support_direct_message(body) else { return false; };
    envelope.kind == "message"
        && envelope.target_cloud_agent_id.as_deref() == Some(config.agent_id.as_str())
        && envelope.target_cloud_agent_owner_account_id.as_deref() == Some(config.owner_account_id.as_str())
        && peer_account_id == config.owner_account_id
}
```

- [ ] **Step 7: Allow support target through contact guard**

In `send_message`, before the mutual-contact rejection, compute:

```rust
let support_target_allowed = crate::support_agent::SupportAgentConfig::from_env()
    .as_ref()
    .map(|config| crate::support_agent::message_targets_support_agent(&body, &peer, config))
    .unwrap_or(false);
```

Change the guard to:

```rust
if !is_self_message && mutual.is_none() && !support_target_allowed && cloud_message_requires_accepted_contact(&body) {
    return err(
        "not_a_contact",
        "You can only message accepted contacts.",
        StatusCode::FORBIDDEN,
    );
}
```

- [ ] **Step 8: Claim hosted support run after inserting the message**

In `send_message`, after `cloud_messages` and sync events are inserted successfully, add:

```rust
if support_target_allowed {
    if let Some(config) = crate::support_agent::SupportAgentConfig::from_env() {
        if let Some(envelope) = crate::support_agent::parse_support_direct_message(&body) {
            let claim = crate::cloud_agent_runtime::runs::ClaimRunRequest {
                request_message_id: message_id.clone(),
                session_id: cloud_session_id.clone(),
                owner_account_id: config.owner_account_id.clone(),
                requester_account_id: session.account_id.clone(),
                prompt: envelope.text.trim().to_string(),
                idempotency_key: format!("kordi-support:{}:{}", cloud_session_id, message_id),
            };
            if claim.is_well_formed() {
                let _ = crate::cloud_agent_runtime::runs::claim_run(pool, &claim, Utc::now()).await;
            }
        }
    }
}
```

The support claim is idempotent through `idempotency_key`; the HTTP send should still succeed if claim insertion races with another claimant.

- [ ] **Step 9: Run focused tests**

Run:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_agent_contact_is_appended -- --nocapture
cargo test -p kordi-cloud-server cloud_message_policy_tests --lib
cargo check -p kordi-cloud-server
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/src/support_agent.rs bridges/cloud-server/tests/cloud_support_agent_e2e.rs
git commit -m "feat: expose Kordi support as default contact"
```

---

### Task 4: Desktop contact model maps support contact as locked hosted agent

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/features/cloud/useCloudContacts.ts`
- Test: `app/desktop/tests/cloudSupportAgent.test.tsx`

- [ ] **Step 1: Write failing desktop mapping test**

Create `app/desktop/tests/cloudSupportAgent.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';

test('cloud support contact maps to a locked hosted agent contact', () => {
  const contact = cloudContactToContact({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_support_owner',
    displayName: 'Kordi Support',
    subtitle: 'Ask questions or suggest improvements',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-06-26T00:00:00Z',
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });

  assert.equal(contact.id, 'cloud-system:kordi-support');
  assert.equal(contact.name, 'Kordi Support');
  assert.equal(contact.entityType, 'agent');
  assert.equal(contact.bridgePeerNodeId, 'acct_support_owner');
  assert.equal(contact.bridgePeerRuntime, 'agent');
  assert.equal(contact.locked, true);
  assert.equal(contact.systemContact, true);
  assert.equal(contact.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(contact.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx
```

Expected: FAIL because the new fields are not typed/mapped.

- [ ] **Step 3: Extend `CloudContactSummary` type**

In `app/desktop/src/features/cloud/authClient.ts`, add optional fields:

```ts
export type CloudContactSummary = {
  contactId?: string | null;
  contactKind?: 'user' | 'system_agent' | string | null;
  accountId: string;
  displayName: string | null;
  subtitle?: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  createdAt: string;
  locked?: boolean | null;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerAccountId?: string | null;
  targetCloudAgentOwnerName?: string | null;
};
```

- [ ] **Step 4: Extend `Contact` type**

In `app/desktop/src/kordi-app/types.ts`, add optional fields to `Contact`:

```ts
systemContact?: boolean | null;
locked?: boolean | null;
targetCloudAgentId?: string | null;
targetCloudAgentName?: string | null;
targetCloudAgentOwnerAccountId?: string | null;
targetCloudAgentOwnerName?: string | null;
```

- [ ] **Step 5: Map support contacts**

In `cloudContactToContact`, compute:

```ts
const isSystemAgent = row.contactKind === 'system_agent' && Boolean(row.targetCloudAgentId?.trim());
const name = row.displayName ?? row.accountId;
```

Return these changed fields:

```ts
id: row.contactId?.trim() || `cloud:${row.accountId}`,
classType: isSystemAgent ? 'other-users-agents' : 'other-users',
entityType: isSystemAgent ? 'agent' : 'user',
subtitle: row.subtitle?.trim() || row.accountId,
detail: isSystemAgent ? (row.subtitle?.trim() || 'Official Kordi support contact.') : row.accountId,
bridgePeerRuntime: isSystemAgent ? 'agent' : 'person',
bridgeAgentId: row.targetCloudAgentId?.trim() || null,
locked: row.locked === true || isSystemAgent,
systemContact: isSystemAgent,
targetCloudAgentId: row.targetCloudAgentId?.trim() || null,
targetCloudAgentName: row.targetCloudAgentName?.trim() || null,
targetCloudAgentOwnerAccountId: row.targetCloudAgentOwnerAccountId?.trim() || null,
targetCloudAgentOwnerName: row.targetCloudAgentOwnerName?.trim() || null,
```

Keep `bridgePeerNodeId`, `bridgeHumanId`, and `owner` pointing to `row.accountId` / display name so direct session routing remains compatible.

- [ ] **Step 6: Run test and verify it passes**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/features/cloud/authClient.ts app/desktop/src/kordi-app/types.ts app/desktop/src/features/cloud/useCloudContacts.ts app/desktop/tests/cloudSupportAgent.test.tsx
git commit -m "feat: map Kordi support as locked cloud contact"
```

---

### Task 5: Desktop sends support messages as targeted hosted-agent requests

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Test: `app/desktop/tests/cloudSupportAgent.test.tsx`
- Test: `app/desktop/tests/cloudDirectContactSend.test.ts`

- [ ] **Step 1: Write failing helper tests**

Append to `app/desktop/tests/cloudSupportAgent.test.tsx`:

```tsx
import { encodeCloudDirectMessageEnvelope, parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudBridgeConversationId } from '../src/features/cloud/cloudBridgeState';

test('support agent conversation id uses the support owner and agent runtime', () => {
  assert.equal(
    cloudBridgeConversationId('acct_support_owner', 'agent'),
    'bridge:cloud:acct_support_owner:agent',
  );
});

test('support agent direct message envelope carries hosted target metadata', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'How do reminders work?',
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });
  const parsed = parseCloudDirectMessageEnvelope(body);
  assert.equal(parsed?.text, 'How do reminders work?');
  assert.equal(parsed?.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(parsed?.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});
```

- [ ] **Step 2: Run tests and verify current gap**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx tests/cloudDirectContactSend.test.ts
```

Expected: the envelope helper test may pass because the generic envelope exists; the implementation gap remains in `sendCloudBridgeMessage`, covered in the next test.

- [ ] **Step 3: Add send-target resolver test**

Export a pure helper from `useCloudBridgeState.ts` in the implementation step below. First add this failing test to `cloudSupportAgent.test.tsx`:

```tsx
import { cloudBridgeSendBodyForConversation } from '../src/features/cloud/useCloudBridgeState';

test('support contact send body is encoded for the configured hosted support agent', () => {
  const body = cloudBridgeSendBodyForConversation({
    conversationId: 'bridge:cloud:acct_support_owner:agent',
    text: 'I have a suggestion',
    contacts: [{
      id: 'cloud-system:kordi-support',
      name: 'Kordi Support',
      initials: 'KS',
      classType: 'other-users-agents',
      entityType: 'agent',
      subtitle: 'Ask questions or suggest improvements',
      bridges: ['cloud'],
      status: 'online',
      discoverableOn: ['cloud'],
      detail: 'Official Kordi support contact.',
      owner: 'Kordi Support',
      bridgeHostId: 'cloud',
      bridgePeerNodeId: 'acct_support_owner',
      bridgePeerRuntime: 'agent',
      bridgeHumanId: 'acct_support_owner',
      bridgeAgentId: 'cloud_agent_kordi_support',
      systemContact: true,
      locked: true,
      targetCloudAgentId: 'cloud_agent_kordi_support',
      targetCloudAgentName: 'Kordi Support',
      targetCloudAgentOwnerAccountId: 'acct_support_owner',
      targetCloudAgentOwnerName: 'Kordi',
    }],
  });

  const parsed = parseCloudDirectMessageEnvelope(body);
  assert.equal(parsed?.text, 'I have a suggestion');
  assert.equal(parsed?.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(parsed?.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});
```

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx
```

Expected: FAIL because `cloudBridgeSendBodyForConversation` is not exported.

- [ ] **Step 4: Implement pure send-body helper**

In `app/desktop/src/features/cloud/useCloudBridgeState.ts`, export:

```ts
export function cloudBridgeSendBodyForConversation({
  conversationId,
  text,
  contacts,
}: {
  conversationId: string;
  text: string;
  contacts: Contact[];
}): string {
  const trimmed = text.trim();
  const peerId = cloudPeerAccountIdFromConversationId(conversationId);
  const target = contacts.find((contact) => {
    const contactPeerId = contact.bridgePeerNodeId?.trim() || contact.id.replace(/^cloud:/, '').trim();
    return contactPeerId === peerId
      && contact.targetCloudAgentId?.trim()
      && contact.targetCloudAgentOwnerAccountId?.trim();
  });
  if (!target) return trimmed;
  return encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: trimmed,
    targetCloudAgentId: target.targetCloudAgentId?.trim() || null,
    targetCloudAgentName: target.targetCloudAgentName?.trim() || target.name,
    targetCloudAgentOwnerAccountId: target.targetCloudAgentOwnerAccountId?.trim() || null,
    targetCloudAgentOwnerName: target.targetCloudAgentOwnerName?.trim() || target.owner,
  });
}
```

Ensure imports include `Contact` and `encodeCloudDirectMessageEnvelope`.

- [ ] **Step 5: Use helper in sendCloudBridgeMessage**

In `sendCloudBridgeMessage`, replace:

```ts
const message = await client.sendMessage(session.token, peerId, trimmed, { sessionId: cloudSessionId, attachments: uploadedAttachments });
```

with:

```ts
const body = cloudBridgeSendBodyForConversation({
  conversationId,
  text: trimmed,
  contacts,
});
const message = await client.sendMessage(session.token, peerId, body, { sessionId: cloudSessionId, attachments: uploadedAttachments });
```

Add `contacts` to the callback dependency array.

- [ ] **Step 6: Keep support agent row in agent/contact channel**

In `buildCloudBridgeHost`, `cloudContactToAgentPeer(contact)` should receive `contact.bridgeAgentId` if present. If it currently derives only from peer account id, update it so support peers have stable id:

```ts
id: contact.bridgeAgentId || `cloud-agent:${peerAccountId}`,
label: contact.targetCloudAgentName || cloudAgentDisplayName(contact),
runtime: CLOUD_AGENT_RUNTIME,
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx tests/cloudDirectContactSend.test.ts tests/cloudAgentMessages.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add app/desktop/src/features/cloud/cloudBridgeState.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudSupportAgent.test.tsx app/desktop/tests/cloudDirectContactSend.test.ts
git commit -m "feat: route support contact messages to hosted agent"
```

---

### Task 6: Server e2e coverage for support contact, message send, and run claim

**Files:**
- Modify: `bridges/cloud-server/tests/cloud_support_agent_e2e.rs`

- [ ] **Step 1: Add DB-backed e2e test**

Add helpers copied from `cloud_auth_e2e.rs`: `try_pool`, `fast_router`, `unique_email`, `signup_body`, `post`, `get_with_token`, `post_json_with_token`, `read_json`.

Then add:

```rust
#[tokio::test]
async fn support_contact_is_listed_and_targeted_message_creates_run() {
    let Some(pool) = try_pool().await else { return };

    let owner_email = unique_email("support-owner");
    let user_email = unique_email("support-user");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state.clone());

    let owner_response = router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&owner_email, "correct horse"))).await.unwrap();
    let owner_body = read_json(owner_response).await;
    let owner_token = owner_body["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner_body["account"]["accountId"].as_str().unwrap().to_string();

    std::env::set_var("KORDI_SUPPORT_AGENT_ENABLED", "true");
    std::env::set_var("KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID", &owner_account_id);
    std::env::set_var("KORDI_SUPPORT_AGENT_ID", "cloud_agent_kordi_support");
    std::env::set_var("KORDI_SUPPORT_AGENT_NAME", "Kordi Support");

    kordi_cloud_server::cloud_agents::store::upsert_system_support_agent_definition(
        state.db_pool(),
        &kordi_cloud_server::support_agent::SupportAgentConfig::from_env().unwrap(),
        chrono::Utc::now(),
    ).await.unwrap();

    let user_response = router.clone().oneshot(post("/v1/cloud/auth/signup", signup_body(&user_email, "correct horse"))).await.unwrap();
    let user_body = read_json(user_response).await;
    let user_token = user_body["session"]["token"].as_str().unwrap().to_string();

    let contacts = router.clone().oneshot(get_with_token("/v1/cloud/contacts", &user_token)).await.unwrap();
    assert_eq!(contacts.status(), StatusCode::OK);
    let contacts_body = read_json(contacts).await;
    let support = contacts_body["contacts"].as_array().unwrap().iter()
        .find(|item| item["contactId"] == "cloud-system:kordi-support")
        .expect("support contact");
    assert_eq!(support["locked"], true);
    assert_eq!(support["targetCloudAgentId"], "cloud_agent_kordi_support");

    let request_body = kordi_cloud_server::support_agent::encode_support_direct_message_for_tests(
        "How do I pin a message?",
        "cloud_agent_kordi_support",
        &owner_account_id,
    );
    let send = router.clone().oneshot(post_json_with_token("/v1/cloud/messages", &user_token, serde_json::json!({
        "peerAccountId": owner_account_id,
        "body": request_body,
        "sessionId": "session:direct-person:support-test",
    }))).await.unwrap();
    assert_eq!(send.status(), StatusCode::CREATED);
    let send_body = read_json(send).await;
    let message_id = send_body["message"]["messageId"].as_str().unwrap();

    let run_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_fallback_runs WHERE request_message_id = $1 AND owner_account_id = $2",
    )
    .bind(message_id)
    .bind(&owner_account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_count.0, 1);

    std::env::remove_var("KORDI_SUPPORT_AGENT_ENABLED");
    std::env::remove_var("KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID");
    std::env::remove_var("KORDI_SUPPORT_AGENT_ID");
    std::env::remove_var("KORDI_SUPPORT_AGENT_NAME");
    drop(owner_token);
}
```

Also add test-only helper in `support_agent.rs`:

```rust
#[cfg(test)]
pub fn encode_support_direct_message_for_tests(text: &str, agent_id: &str, owner_account_id: &str) -> String {
    let body = serde_json::json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": text,
        "targetCloudAgentId": agent_id,
        "targetCloudAgentOwnerAccountId": owner_account_id,
        "targetCloudAgentName": DEFAULT_SUPPORT_AGENT_NAME,
        "targetCloudAgentOwnerName": "Kordi",
    });
    format!("kordi-cloud-message:{}", URL_SAFE_NO_PAD.encode(body.to_string()))
}
```

- [ ] **Step 2: Run e2e test**

Run without DB:

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_contact_is_listed -- --nocapture
```

Expected without `DATABASE_URL`: test prints skip and returns PASS.

Run with DB when available:

```bash
DATABASE_URL="$DATABASE_URL" cargo test -p kordi-cloud-server --test cloud_support_agent_e2e support_contact_is_listed -- --nocapture
```

Expected with DB: PASS and `run_count` is 1.

- [ ] **Step 3: Commit**

```bash
git add bridges/cloud-server/src/support_agent.rs bridges/cloud-server/tests/cloud_support_agent_e2e.rs
git commit -m "test: cover hosted support agent message flow"
```

---

### Task 7: Runner/provider-auth verification and support prompt behavior

**Files:**
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`
- Test: `bridges/cloud-agent-runner/src/runtime.rs`

- [ ] **Step 1: Add runner regression test for support prompts using provider auth**

In `bridges/cloud-agent-runner/src/runtime.rs` tests, add:

```rust
#[tokio::test]
async fn support_agent_runs_use_model_loop_and_provider_auth() {
    let mut client = FakeRunClient::default();
    client.next_run = Some(CloudAgentRun {
        run_id: "car_support".to_string(),
        status: "leased".to_string(),
        prompt: "How do pins work?".to_string(),
        owner_account_id: "acct_support_owner".to_string(),
        requester_account_id: "acct_user".to_string(),
        session_id: "session:direct-person:acct_support_owner:acct_user".to_string(),
        sandbox_id: None,
        response_message_id: None,
        error_code: None,
        error_message: None,
        provider_auth_available: true,
    });
    client.model_loop_text = Some("Pins keep important messages easy to find.".to_string());

    let outcome = process_one_run(&mut client, "runner-1").await.unwrap();

    assert!(matches!(outcome, RunnerStepOutcome::Completed { .. }));
    assert_eq!(client.actions, vec!["lease", "provider_auth:car_support", "complete:car_support:Pins keep important messages easy to find."]);
}
```

- [ ] **Step 2: Run test and verify it passes or reveals missing instrumentation**

Run:

```bash
cargo test -p kordi-cloud-agent-runner support_agent_runs_use_model_loop_and_provider_auth --lib
```

Expected: PASS if existing runtime already covers model-loop provider-auth path; if it fails because `FakeRunClient` does not record provider auth actions, add that recording in the fake only.

- [ ] **Step 3: Confirm missing-provider-auth still fails closed**

Run:

```bash
cargo test -p kordi-cloud-agent-runner runtime::tests::marks_failed_when_provider_auth_is_missing --lib
```

Expected: PASS. Do not bypass provider-auth checks for support agent runs.

- [ ] **Step 4: Commit if test changed code**

```bash
git add bridges/cloud-agent-runner/src/runtime.rs
git commit -m "test: verify support agent runner auth path"
```

If no code changed because an existing test already proves the path, skip this commit and record the verification in the PR body.

---

### Task 8: Deployment configuration docs for takotako

**Files:**
- Modify: `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
- Modify: `docs/hosted-cloud-developer-guide.md`

- [ ] **Step 1: Add deploy script env pass-through comments**

In `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`, near existing env/config documentation, add:

```bash
# Optional global Kordi Support Agent. When enabled, every Cloud user sees a
# locked "Kordi Support" contact that targets the configured Cloud Agent owner.
# Required on the target cluster for production use:
#   KORDI_SUPPORT_AGENT_ENABLED=true
#   KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID=acct_...
#   KORDI_SUPPORT_AGENT_ID=cloud_agent_kordi_support
#   KORDI_SUPPORT_AGENT_NAME="Kordi Support"
#   KORDI_SUPPORT_AGENT_DEFAULT_MODEL=...
#   KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER=openai
#   KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE=...
```

If the script renders Kubernetes env lists explicitly, include these variables in the deployment manifest using existing secret/configmap style. Do not hardcode secret values.

- [ ] **Step 2: Document setup**

In `docs/hosted-cloud-developer-guide.md`, add a section:

```markdown
### Global Kordi Support Agent

Set these environment variables on the Cloud server deployment to enable the official support contact for every Cloud account:

- `KORDI_SUPPORT_AGENT_ENABLED=true`
- `KORDI_SUPPORT_AGENT_OWNER_ACCOUNT_ID=<account that owns the provider-auth snapshot>`
- `KORDI_SUPPORT_AGENT_ID=cloud_agent_kordi_support`
- `KORDI_SUPPORT_AGENT_NAME=Kordi Support`
- `KORDI_SUPPORT_AGENT_DEFAULT_MODEL=<hosted model>`
- `KORDI_SUPPORT_AGENT_DEFAULT_AUTH_PROVIDER=openai`
- `KORDI_SUPPORT_AGENT_DEFAULT_AUTH_CHOICE=<server auth choice>`

The owner account must already have a current provider-auth snapshot. The support contact is virtual and locked: users can message it, but cannot edit or delete the backing agent definition.
```

- [ ] **Step 3: Commit docs**

```bash
git add bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh docs/hosted-cloud-developer-guide.md
git commit -m "docs: document global support agent deployment"
```

---

### Task 9: Full verification, PR, and takotako deploy

**Files:**
- No source files unless verification reveals a failure.

- [ ] **Step 1: Run desktop verification**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx tests/cloudDirectContactSend.test.ts tests/cloudAgentMessages.test.tsx tests/cloudContactsLatency.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 2: Run server verification**

```bash
cargo test -p kordi-cloud-server --test cloud_support_agent_e2e -- --nocapture
cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e -- --nocapture
cargo test -p kordi-cloud-server cloud_agent_runtime::runs::tests --lib
cargo check -p kordi-cloud-server
```

Expected: all tests PASS. DB-backed tests skip only when `DATABASE_URL` is absent.

- [ ] **Step 3: Run runner verification**

```bash
cargo test -p kordi-cloud-agent-runner runtime::tests --lib
cargo check -p kordi-cloud-agent-runner
```

Expected: all tests PASS.

- [ ] **Step 4: Check formatting/whitespace**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feature/issue-616-global-support-agent
gh pr create \
  --title "Add global hosted Kordi Support Agent" \
  --body "$(cat <<'EOF'
## Summary
- add a locked global Kordi Support contact for Cloud users
- route support-contact messages to a server-managed hosted Cloud Agent
- seed/lock the backing support agent definition and document deployment env

Fixes #616

## Test Plan
- pnpm --dir app/desktop exec tsx --test tests/cloudSupportAgent.test.tsx tests/cloudDirectContactSend.test.ts tests/cloudAgentMessages.test.tsx tests/cloudContactsLatency.test.tsx
- pnpm --dir app/desktop typecheck
- cargo test -p kordi-cloud-server --test cloud_support_agent_e2e -- --nocapture
- cargo test -p kordi-cloud-server --test cloud_agent_definitions_e2e -- --nocapture
- cargo test -p kordi-cloud-server cloud_agent_runtime::runs::tests --lib
- cargo check -p kordi-cloud-server
- cargo test -p kordi-cloud-agent-runner runtime::tests --lib
- cargo check -p kordi-cloud-agent-runner
- git diff --check
EOF
)"
```

- [ ] **Step 6: Deploy Cloud server to takotako after PR review or explicit approval**

Use the required target:

```bash
gcloud compute ssh --zone "us-central1-c" "takotako" --project "hai-gcp-representation"
```

Deploy with rolling update only. Do not delete PVCs, DBs, or user data. Confirm env includes support-agent config and owner account has provider auth.

- [ ] **Step 7: Verify deployed behavior**

From a fresh/existing Cloud user on takotako:

```bash
curl -fsS https://korde-product-cloud.35.188.85.31.sslip.io/health
```

Then in desktop preview:
- Contact list shows `Kordi Support` at startup.
- User sends `How do pins work?` to `Kordi Support`.
- A `cloud_agent_fallback_runs` row is created for `cloud_agent_kordi_support` owner.
- Runner completes the response.
- UI shows the response without exposing provider/runtime metadata.

---

## Self-Review

### Spec coverage
- Default contact for every Cloud user: Task 3 server contact append, Task 4 desktop mapping.
- User can message it: Task 5 send-body encoding, Task 3 server message allowance and run claim.
- Cannot edit/delete/reconfigure: Task 2 `is_system_managed` lock and 403 route mapping; Task 4 `locked` contact metadata.
- Hosted on server and uses configured auth: Task 2 support owner/model routing, Task 3 server-side run claim, Task 7 runner provider-auth verification.
- Suggestions/questions behavior: Task 2 support system prompt.
- No internal metadata leak: Task 2 prompt boundary, Task 9 manual UI verification.
- Existing users receive contact: Task 3 virtual contact appended by list endpoint, not signup-only migration.

### Placeholder scan
No unfinished placeholder markers or open-ended implementation instructions remain. Environment values are intentionally parameterized because secrets must not be committed.

### Type consistency
The plan uses these field names consistently across server and desktop: `contactId`, `contactKind`, `locked`, `targetCloudAgentId`, `targetCloudAgentName`, `targetCloudAgentOwnerAccountId`, `targetCloudAgentOwnerName`, and `systemManaged`.
