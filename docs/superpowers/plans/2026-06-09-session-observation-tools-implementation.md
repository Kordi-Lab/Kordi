# Session Observation Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement general read-only `search_sessions` and `read_session` Observation tools for all agent sessions, backed by the local canonical sessions database in the desktop runtime.

**Architecture:** Add generic session observation tools to `kordi-tools` that call a runtime callback stored on `ToolContext`. The desktop Tauri crate supplies that callback by querying canonical session tables and attaches it before local agent sends. The tools are built-ins for every non-disabled agent tool registry; side-by-side chat UI remains a normal side-session presentation and is handled as a follow-up on PR #534.

**Tech Stack:** Rust workspace (`kordi-tools`, `kordi-cli`, `kordi-desktop` Tauri crate), `rusqlite`, `serde`, existing Node/React tests for PR #534 copy follow-up.

---

## File Map

- Create `agent/crates/tools/src/session_observation.rs`
  - Defines `SearchSessionsTool` and `ReadSessionTool`.
  - Deserializes tool parameters.
  - Calls `ctx.session_observation` runtime callbacks.
  - Formats text and structured JSON details.

- Modify `agent/crates/tools/src/types.rs`
  - Adds request/response structs used by the tool crate and desktop runtime.
  - Adds `SessionObservationRuntime` to `ToolContext`.

- Modify `agent/crates/tools/src/lib.rs`
  - Exports session observation runtime/request/response types.
  - Adds `pub mod session_observation`.

- Modify `agent/crates/tools/src/registry.rs`
  - Registers `search_sessions` and `read_session` as built-ins.
  - Tests metadata as Observation/ReadOnly/parallel.

- Modify `agent/crates/cli/src/session_bootstrap.rs`
  - Initializes `ToolContext { session_observation: None }` for generic CLI runtime.

- Modify `agent/crates/cli/src/desktop_runtime.rs`
  - Adds `DesktopRuntimeSession::set_session_observation_runtime`.
  - Copies `session_observation` in cloned turn contexts.
  - Preserves the runtime when setup is retargeted by copying `setup.tool_ctx.session_observation.clone()` into any rebuilt `ToolContext`.

- Modify `agent/crates/cli/src/turn_runner/tools.rs`
  - Copies `session_observation` in `tool_context_with_output_forwarding`.

- Modify test helper files that construct `ToolContext`
  - Add `session_observation: None` to existing test contexts.

- Create `app/desktop/src-tauri/src/canonical_sessions/session_observation.rs`
  - Implements canonical DB query helpers and access filtering.
  - Produces `kordi_tools::SessionObservation*` response structs.

- Modify `app/desktop/src-tauri/src/canonical_sessions.rs`
  - Registers the new module.
  - Re-exports runtime builder/query functions for chat integration.

- Create or modify `app/desktop/src-tauri/src/chat/session_observation.rs`
  - Builds `kordi_tools::SessionObservationRuntime` callbacks for desktop agent sessions.

- Modify `app/desktop/src-tauri/src/chat.rs`
  - Adds module and attaches session observation runtime before local sends.

- Modify `app/desktop/src-tauri/src/chat/bridge_outreach.rs`
  - Calls `runtime.set_session_observation_runtime(Some(...))` in `prepare_desktop_session_for_send` so all agent sends have the runtime available.

- Follow-up branch for PR #534, not in this implementation branch:
  - `app/desktop/src/pages/ChatsPage.tsx`
  - `app/desktop/tests/chatHeaderBadge.test.tsx`
  - Replace co-pilot/private wording with neutral side-session wording.

---

### Task 1: Register tool names and metadata with failing tests

**Files:**
- Modify: `agent/crates/tools/src/registry.rs`

- [ ] **Step 1: Write the failing metadata test**

Add `search_sessions` and `read_session` to the existing Observation metadata test in `agent/crates/tools/src/registry.rs`:

```rust
#[test]
fn builtin_metadata_categorizes_observation_tools_as_read_only_parallel() {
    for name in [
        "read",
        "find",
        "grep",
        "ls",
        "web_search",
        "web_fetch",
        "browser_fetch",
        "search_sessions",
        "read_session",
    ] {
        let metadata = metadata_for(name);
        assert_eq!(metadata.layer, ToolLayer::Observation, "{name}");
        assert_eq!(metadata.risk, ToolRiskLevel::ReadOnly, "{name}");
        assert!(metadata.supports_parallel, "{name}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-tools registry::tests::builtin_metadata_categorizes_observation_tools_as_read_only_parallel -- --nocapture
```

Expected: FAIL with `missing builtin tool search_sessions`.

- [ ] **Step 3: Do not implement yet**

Stop after confirming the failure. Implementation happens in Task 2.

---

### Task 2: Add runtime request/response types and `ToolContext` field

**Files:**
- Modify: `agent/crates/tools/src/types.rs`
- Modify: `agent/crates/tools/src/lib.rs`

- [ ] **Step 1: Add request/response structs to `types.rs`**

Insert after `ReflectionRuntime` and before task operator runtime types:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionsRequest {
    pub query: String,
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_messages: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadSessionRequest {
    pub session_id: String,
    pub around_message_id: Option<String>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub message_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationParticipant {
    pub name: String,
    pub kind: String,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationSnippet {
    pub message_id: String,
    pub sender: String,
    pub text: String,
    pub time_label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationSearchResult {
    pub session_id: String,
    pub title: String,
    pub kind: String,
    pub participants: Vec<String>,
    pub updated_at_label: Option<String>,
    pub reason: String,
    pub snippets: Vec<SessionObservationSnippet>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionsResponse {
    pub sessions: Vec<SessionObservationSearchResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationReadSession {
    pub session_id: String,
    pub title: String,
    pub kind: String,
    pub participants: Vec<SessionObservationParticipant>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationWindow {
    pub around_message_id: Option<String>,
    pub has_more_before: bool,
    pub has_more_after: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionObservationMessage {
    pub message_id: String,
    pub sender: String,
    pub role: String,
    pub sequence_num: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub time_label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadSessionResponse {
    pub session: SessionObservationReadSession,
    pub window: SessionObservationWindow,
    pub messages: Vec<SessionObservationMessage>,
}

pub type SearchSessionsFuture = Pin<Box<dyn Future<Output = KordiResult<SearchSessionsResponse>> + Send>>;
pub type ReadSessionFuture = Pin<Box<dyn Future<Output = KordiResult<ReadSessionResponse>> + Send>>;
pub type SearchSessionsFn = Arc<dyn Fn(SearchSessionsRequest) -> SearchSessionsFuture + Send + Sync>;
pub type ReadSessionFn = Arc<dyn Fn(ReadSessionRequest) -> ReadSessionFuture + Send + Sync>;

#[derive(Clone)]
pub struct SessionObservationRuntime {
    pub search_sessions: SearchSessionsFn,
    pub read_session: ReadSessionFn,
}
```

Add a field to `ToolContext`:

```rust
pub session_observation: Option<SessionObservationRuntime>,
```

Place it beside other optional runtimes:

```rust
pub web_search: Option<WebSearchRuntime>,
pub reach_out: Option<ReachOutRuntime>,
pub reflection: Option<ReflectionRuntime>,
pub session_observation: Option<SessionObservationRuntime>,
pub task_operator: Option<TaskOperatorRuntime>,
```

- [ ] **Step 2: Export types from `lib.rs`**

Update the `pub use types::{ ... }` list to include:

```rust
ReadSessionFn, ReadSessionFuture, ReadSessionRequest, ReadSessionResponse,
SearchSessionsFn, SearchSessionsFuture, SearchSessionsRequest, SearchSessionsResponse,
SessionObservationMessage, SessionObservationParticipant, SessionObservationReadSession,
SessionObservationRuntime, SessionObservationSearchResult, SessionObservationSnippet,
SessionObservationWindow,
```

- [ ] **Step 3: Run compile to expose missing initializers**

Run:

```bash
cargo check -p kordi-tools
```

Expected: FAIL in tests/helpers constructing `ToolContext` without `session_observation`.

- [ ] **Step 4: Add `session_observation: None` to every `ToolContext` literal**

Use compiler locations plus search:

```bash
rg -n "ToolContext \{" agent/crates app/desktop/src-tauri/src -g '*.rs'
```

For each literal, add:

```rust
session_observation: None,
```

or clone from an existing context where appropriate:

```rust
session_observation: env.tool_ctx.session_observation.clone(),
```

- [ ] **Step 5: Run compile again**

Run:

```bash
cargo check -p kordi-tools
```

Expected: PASS for `kordi-tools` after literals are updated.

---

### Task 3: Implement `search_sessions` and `read_session` built-in tools

**Files:**
- Create: `agent/crates/tools/src/session_observation.rs`
- Modify: `agent/crates/tools/src/lib.rs`
- Modify: `agent/crates/tools/src/registry.rs`

- [ ] **Step 1: Create failing tool behavior tests**

Create `agent/crates/tools/src/session_observation.rs` with tests first. Include the tests at the bottom of the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionObservationRuntime, Tool, ToolContext};
    use serde_json::json;
    use std::{path::PathBuf, sync::{Arc, Mutex}};

    fn ctx_with_runtime(runtime: Option<SessionObservationRuntime>) -> ToolContext {
        ToolContext {
            cwd: PathBuf::from("/tmp"),
            artifacts_dir: PathBuf::from("/tmp/artifacts"),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            session_observation: runtime,
            task_operator: None,
            execution_mode: crate::ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    #[tokio::test]
    async fn search_sessions_rejects_empty_query() {
        let tool = SearchSessionsTool;
        let error = tool
            .execute(json!({"query":"   "}), &ctx_with_runtime(None), tokio_util::sync::CancellationToken::new())
            .await
            .expect_err("empty query should fail");
        assert!(error.to_string().contains("query cannot be empty"));
    }

    #[tokio::test]
    async fn search_sessions_requires_runtime() {
        let tool = SearchSessionsTool;
        let error = tool
            .execute(json!({"query":"launch"}), &ctx_with_runtime(None), tokio_util::sync::CancellationToken::new())
            .await
            .expect_err("missing runtime should fail");
        assert!(error.to_string().contains("session observation is unavailable"));
    }

    #[tokio::test]
    async fn search_sessions_calls_runtime_with_capped_limit() {
        let captured = Arc::new(Mutex::new(Vec::<SearchSessionsRequest>::new()));
        let captured_clone = captured.clone();
        let runtime = SessionObservationRuntime {
            search_sessions: Arc::new(move |request| {
                captured_clone.lock().expect("captured").push(request);
                Box::pin(async {
                    Ok(SearchSessionsResponse { sessions: vec![SessionObservationSearchResult {
                        session_id: "session:launch".to_string(),
                        title: "Launch".to_string(),
                        kind: "group".to_string(),
                        participants: vec!["Alice".to_string()],
                        updated_at_label: Some("Today".to_string()),
                        reason: "Matched title".to_string(),
                        snippets: vec![SessionObservationSnippet {
                            message_id: "msg:1".to_string(),
                            sender: "Alice".to_string(),
                            text: "Launch note".to_string(),
                            time_label: Some("13:04".to_string()),
                        }],
                    }] })
                })
            }),
            read_session: Arc::new(|_| Box::pin(async { unreachable!("not used") })),
        };

        let result = SearchSessionsTool
            .execute(json!({"query":" launch ", "limit": 99}), &ctx_with_runtime(Some(runtime)), tokio_util::sync::CancellationToken::new())
            .await
            .expect("search result");
        assert!(result.content.iter().any(|block| format!("{block:?}").contains("Launch")));
        assert_eq!(captured.lock().expect("captured")[0].query, "launch");
        assert_eq!(captured.lock().expect("captured")[0].limit, Some(MAX_SEARCH_SESSIONS_LIMIT));
    }

    #[tokio::test]
    async fn read_session_requires_session_id() {
        let error = ReadSessionTool
            .execute(json!({"sessionId":"   "}), &ctx_with_runtime(None), tokio_util::sync::CancellationToken::new())
            .await
            .expect_err("blank session id should fail");
        assert!(error.to_string().contains("sessionId cannot be empty"));
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test -p kordi-tools session_observation -- --nocapture
```

Expected: FAIL because `SearchSessionsTool`, `ReadSessionTool`, and constants are not implemented yet.

- [ ] **Step 3: Implement the module**

Add implementation above the tests:

```rust
use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    ReadSessionRequest, SearchSessionsRequest, Tool, ToolContext, ToolMetadata, ToolResult,
    ToolRiskLevel, ToolLayer, support::text_result,
};

pub const DEFAULT_SEARCH_SESSIONS_LIMIT: usize = 8;
pub const MAX_SEARCH_SESSIONS_LIMIT: usize = 20;
pub const DEFAULT_READ_SESSION_LIMIT: usize = 30;
pub const MAX_READ_SESSION_LIMIT: usize = 80;

pub struct SearchSessionsTool;
pub struct ReadSessionTool;

fn bounded_limit(value: Option<u64>, default: usize, max: usize) -> usize {
    value.map(|raw| raw.max(1) as usize).unwrap_or(default).min(max)
}

fn text_field(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

#[async_trait]
impl Tool for SearchSessionsTool {
    fn name(&self) -> &str { "search_sessions" }

    fn description(&self) -> &str {
        "Search accessible sessions and conversations for relevant prior chats. Use first to find session ids."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query for session titles, participants, and message text." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_SESSIONS_LIMIT, "description": "Maximum number of sessions to return. Defaults to 8." },
                "includeMessages": { "type": "boolean", "description": "Whether to include matching message snippets. Defaults to false." }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    async fn execute(&self, params: Value, ctx: &ToolContext, _cancel: CancellationToken) -> KordiResult<ToolResult> {
        let query = text_field(&params, "query");
        if query.is_empty() {
            return Err(KordiError::Tool("query cannot be empty for search_sessions".to_string()));
        }
        let limit = bounded_limit(params.get("limit").and_then(Value::as_u64), DEFAULT_SEARCH_SESSIONS_LIMIT, MAX_SEARCH_SESSIONS_LIMIT);
        let include_messages = params.get("includeMessages").and_then(Value::as_bool);
        let Some(runtime) = ctx.session_observation.clone() else {
            return Err(KordiError::Tool("session observation is unavailable in this runtime".to_string()));
        };
        let response = (runtime.search_sessions)(SearchSessionsRequest { query, limit: Some(limit), include_messages }).await?;
        let text = if response.sessions.is_empty() {
            "No matching sessions found.".to_string()
        } else {
            response.sessions.iter().map(|session| {
                let mut line = format!("- `{}` — {} ({})", session.session_id, session.title, session.kind);
                if !session.reason.trim().is_empty() { line.push_str(&format!("; {}", session.reason)); }
                for snippet in &session.snippets {
                    line.push_str(&format!("\n  - `{}` {}: {}", snippet.message_id, snippet.sender, snippet.text));
                }
                line
            }).collect::<Vec<_>>().join("\n")
        };
        Ok(text_result(text, Some(serde_json::to_value(response).map_err(|err| KordiError::Tool(format!("Could not serialize search_sessions response: {err}")))?)))
    }
}

#[async_trait]
impl Tool for ReadSessionTool {
    fn name(&self) -> &str { "read_session" }

    fn description(&self) -> &str {
        "Progressively read a session: first a message index, then selected message details by messageIds."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "sessionId": { "type": "string", "description": "Canonical session id to read." },
                "aroundMessageId": { "type": "string", "description": "Optional message id to center the index window around." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_READ_SESSION_LIMIT, "description": "Maximum number of messages to return. Defaults to 30." },
                "mode": { "type": "string", "enum": ["index", "messages"], "description": "Defaults to index; use messages only with messageIds." },
                "messageIds": { "type": "array", "items": { "type": "string" }, "description": "Message ids to read when mode is messages." }
            },
            "required": ["sessionId"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    async fn execute(&self, params: Value, ctx: &ToolContext, _cancel: CancellationToken) -> KordiResult<ToolResult> {
        let session_id = text_field(&params, "sessionId");
        if session_id.is_empty() {
            return Err(KordiError::Tool("sessionId cannot be empty for read_session".to_string()));
        }
        let around_message_id = params.get("aroundMessageId").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string);
        let limit = bounded_limit(params.get("limit").and_then(Value::as_u64), DEFAULT_READ_SESSION_LIMIT, MAX_READ_SESSION_LIMIT);
        let Some(runtime) = ctx.session_observation.clone() else {
            return Err(KordiError::Tool("session observation is unavailable in this runtime".to_string()));
        };
        let mode = params.get("mode").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string);
        let message_ids = params.get("messageIds").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string).collect::<Vec<_>>());
        let response = (runtime.read_session)(ReadSessionRequest { session_id, around_message_id, limit: Some(limit), mode, message_ids }).await?;
        let mut text = format!("Session `{}` — {} ({})", response.session.session_id, response.session.title, response.session.kind);
        for message in &response.messages {
            if let Some(message_text) = message.text.as_deref() {
                text.push_str(&format!("\n- `{}` #{} {}: {}", message.message_id, message.sequence_num, message.sender, message_text));
            } else {
                text.push_str(&format!("\n- `{}` #{} {}", message.message_id, message.sequence_num, message.sender));
            }
        }
        Ok(text_result(text, Some(serde_json::to_value(response).map_err(|err| KordiError::Tool(format!("Could not serialize read_session response: {err}")))?)))
    }
}
```

- [ ] **Step 4: Wire module and registry**

In `agent/crates/tools/src/lib.rs`, add:

```rust
pub mod session_observation;
```

In `agent/crates/tools/src/registry.rs`, add to `builtin_tools()` after `ls` or near other Observation tools:

```rust
Box::new(crate::session_observation::SearchSessionsTool),
Box::new(crate::session_observation::ReadSessionTool),
```

- [ ] **Step 5: Run tests**

Run:

```bash
cargo test -p kordi-tools session_observation -- --nocapture
cargo test -p kordi-tools registry::tests::builtin_metadata_categorizes_observation_tools_as_read_only_parallel -- --nocapture
```

Expected: PASS.

---

### Task 4: Propagate `session_observation` through CLI runtime contexts

**Files:**
- Modify: `agent/crates/cli/src/session_bootstrap.rs`
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Modify: `agent/crates/cli/src/turn_runner/tools.rs`
- Modify helper contexts under:
  - `agent/crates/cli/src/turn_runner/tests.rs`
  - `agent/crates/cli/src/turn_runner/tests/compaction.rs`
  - `agent/crates/cli/src/turn_runner/tests/tool_execution.rs`
  - `agent/crates/cli/src/turn_runner/tests/provider_failures.rs`
  - `agent/crates/cli/src/tui/menus/models.rs`
  - `agent/crates/cli/src/tui/session/resume.rs`
  - `agent/crates/cli/src/tui/menus/auth/menus.rs`
  - `agent/crates/cli/src/tui/turns.rs`

- [ ] **Step 1: Write CLI registry availability test**

In `agent/crates/cli/src/tool_registry.rs`, add:

```rust
#[test]
fn session_observation_tools_are_active_by_default() {
    let registry = ToolRegistry::from_builtin_and_extensions(vec![], ToolSelection::All);
    assert!(registry.active_names().contains(&"search_sessions".to_string()));
    assert!(registry.active_names().contains(&"read_session".to_string()));
    assert_eq!(registry.metadata_for("search_sessions").unwrap().layer, ToolLayer::Observation);
    assert_eq!(registry.metadata_for("read_session").unwrap().risk, ToolRiskLevel::ReadOnly);
}
```

- [ ] **Step 2: Run failing/passing registry test**

Run:

```bash
cargo test -p kordi-cli tool_registry::tests::session_observation_tools_are_active_by_default -- --nocapture
```

Expected before Task 3 completion: FAIL. Expected after Task 3: PASS.

- [ ] **Step 3: Add `session_observation: None` to bootstrap context**

In `agent/crates/cli/src/session_bootstrap.rs`, inside the `ToolContext` literal, add:

```rust
session_observation: None,
```

- [ ] **Step 4: Add runtime setter to desktop runtime**

In `agent/crates/cli/src/desktop_runtime.rs`, near `set_reach_out_runtime`, add:

```rust
pub fn set_session_observation_runtime(
    &mut self,
    runtime: Option<kordi_tools::SessionObservationRuntime>,
) {
    self.setup.tool_ctx.session_observation = runtime;
}
```

- [ ] **Step 5: Clone runtime in turn contexts**

In `agent/crates/cli/src/turn_runner/tools.rs`, inside `tool_context_with_output_forwarding`, add:

```rust
session_observation: env.tool_ctx.session_observation.clone(),
```

In `agent/crates/cli/src/desktop_runtime.rs`, wherever a `ToolContext` is cloned into a new `TurnConfig`, add:

```rust
session_observation: setup.tool_ctx.session_observation.clone(),
```

or equivalent local variable path.

- [ ] **Step 6: Run compile for CLI**

Run:

```bash
cargo check -p kordi-cli --features desktop-runtime
```

Expected: PASS after all context literals include `session_observation`.

---

### Task 5: Implement canonical DB query engine with tests

**Files:**
- Create: `app/desktop/src-tauri/src/canonical_sessions/session_observation.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs` or put tests inside the new module with `#[cfg(test)]`.

- [ ] **Step 1: Write failing canonical query tests**

Create `app/desktop/src-tauri/src/canonical_sessions/session_observation.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_sessions::{
        AppendCanonicalMessageRequest, OpenCanonicalSessionRequest, UpsertCanonicalIdentityRequest,
        append_message_in_db, open_or_create_session_in_db, schema, upsert_identity_in_db,
    };
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        schema::initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn seed_identity(conn: &Connection, id: &str, name: &str, kind: &str) {
        upsert_identity_in_db(conn, UpsertCanonicalIdentityRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            display_name: name.to_string(),
            owner_identity_id: None,
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: kind.eq("human").then(|| id.to_string()),
            agent_id: kind.eq("agent").then(|| id.to_string()),
            avatar_key: Some(id.to_string()),
            profile_image_url: None,
            metadata: None,
        }).expect("identity");
    }

    fn seed_session(conn: &Connection, session_id: &str, title: &str, participant_ids: Vec<String>) {
        open_or_create_session_in_db(conn, OpenCanonicalSessionRequest {
            id: Some(session_id.to_string()),
            kind: "group".to_string(),
            title: Some(title.to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: participant_ids[0].clone(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: participant_ids,
            metadata: None,
        }).expect("session");
    }

    fn seed_message(conn: &Connection, id: &str, session_id: &str, sender: &str, text: &str, sequence: i64) {
        append_message_in_db(conn, AppendCanonicalMessageRequest {
            id: Some(id.to_string()),
            session_id: session_id.to_string(),
            sender_identity_id: sender.to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: text.to_string(),
            content: None,
            created_at_ms: Some(1_700_000_000_000 + sequence),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            source_transport: None,
            source_event_id: None,
        }).expect("message");
    }

    #[test]
    fn search_sessions_matches_titles_participants_and_messages() {
        let conn = test_conn();
        seed_identity(&conn, "human:alice", "Alice", "human");
        seed_identity(&conn, "human:bob", "Bob", "human");
        seed_session(&conn, "session:launch", "Launch planning", vec!["human:alice".to_string(), "human:bob".to_string()]);
        seed_message(&conn, "msg:launch-1", "session:launch", "human:alice", "The beta note needs review", 1);

        let response = search_sessions_in_conn(&conn, kordi_tools::SearchSessionsRequest {
            query: "beta".to_string(),
            limit: Some(8),
            include_messages: Some(true),
        }).expect("search");

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(response.sessions[0].session_id, "session:launch");
        assert_eq!(response.sessions[0].participants, vec!["Alice".to_string(), "Bob".to_string()]);
        assert_eq!(response.sessions[0].snippets[0].message_id, "msg:launch-1");
    }

    #[test]
    fn read_session_returns_recent_window_and_participants() {
        let conn = test_conn();
        seed_identity(&conn, "human:alice", "Alice", "human");
        seed_session(&conn, "session:launch", "Launch planning", vec!["human:alice".to_string()]);
        seed_message(&conn, "msg:1", "session:launch", "human:alice", "First", 1);
        seed_message(&conn, "msg:2", "session:launch", "human:alice", "Second", 2);

        let response = read_session_in_conn(&conn, kordi_tools::ReadSessionRequest {
            session_id: "session:launch".to_string(),
            around_message_id: None,
            limit: Some(1),
        }).expect("read");

        assert_eq!(response.session.title, "Launch planning");
        assert_eq!(response.messages.len(), 1);
        assert_eq!(response.messages[0].message_id, "msg:2");
        assert!(response.window.has_more_before);
    }

    #[test]
    fn search_sessions_excludes_archived_sessions() {
        let conn = test_conn();
        seed_identity(&conn, "human:alice", "Alice", "human");
        seed_session(&conn, "session:hidden", "Hidden beta", vec!["human:alice".to_string()]);
        conn.execute("UPDATE sessions SET status = 'archived' WHERE id = 'session:hidden'", []).expect("archive");
        let response = search_sessions_in_conn(&conn, kordi_tools::SearchSessionsRequest {
            query: "beta".to_string(),
            limit: Some(8),
            include_messages: Some(true),
        }).expect("search");
        assert!(response.sessions.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::session_observation -- --nocapture
```

Expected: FAIL because `search_sessions_in_conn` and `read_session_in_conn` do not exist.

- [ ] **Step 3: Implement query helpers**

Add implementation above tests. Use these constants:

```rust
const DEFAULT_SEARCH_LIMIT: usize = 8;
const MAX_SEARCH_LIMIT: usize = 20;
const MAX_SNIPPETS_PER_SESSION: usize = 3;
const MAX_SNIPPET_CHARS: usize = 500;
const DEFAULT_READ_LIMIT: usize = 30;
const MAX_READ_LIMIT: usize = 80;
const MAX_READ_MESSAGE_CHARS: usize = 1200;
```

Implement public entry points:

```rust
pub(crate) fn search_sessions(request: kordi_tools::SearchSessionsRequest) -> Result<kordi_tools::SearchSessionsResponse, String> {
    let conn = super::open_db()?;
    search_sessions_in_conn(&conn, request)
}

pub(crate) fn read_session(request: kordi_tools::ReadSessionRequest) -> Result<kordi_tools::ReadSessionResponse, String> {
    let conn = super::open_db()?;
    read_session_in_conn(&conn, request)
}
```

Implement testable functions:

```rust
pub(super) fn search_sessions_in_conn(
    conn: &rusqlite::Connection,
    request: kordi_tools::SearchSessionsRequest,
) -> Result<kordi_tools::SearchSessionsResponse, String> {
    query_ranked_accessible_sessions(conn, request)
}

pub(super) fn read_session_in_conn(
    conn: &rusqlite::Connection,
    request: kordi_tools::ReadSessionRequest,
) -> Result<kordi_tools::ReadSessionResponse, String> {
    query_bounded_accessible_session_window(conn, request)
}
```

Implementation requirements:

- `search_sessions_in_conn` trims query and errors on empty query.
- SQL filters sessions with `s.status = 'active'`.
- Session candidates can be found with a join across `sessions`, `session_participants`, `identities`, and `session_messages`.
- Ranking can be simple in Rust:
  - +100 title contains query
  - +70 participant contains query
  - +50 message contains query
  - then sort by score desc, `last_message_at_ms` desc, `updated_at_ms` desc.
- `include_messages == Some(false)` returns empty `snippets`.
- Snippet text uses newline-collapsed truncation.
- `read_session_in_conn` errors if session is missing or non-active.
- `read_session_in_conn` with no anchor returns the latest `limit` messages in chronological order.
- `read_session_in_conn` with anchor returns a bounded chronological window centered around that message by `sequence_num`.

Use helper functions:

```rust
fn bounded_limit(value: Option<usize>, default: usize, max: usize) -> usize {
    value.unwrap_or(default).clamp(1, max)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let normalized = value.trim().replace(['\r', '\n'], " ");
    if normalized.chars().count() <= max_chars { return normalized; }
    let mut out = normalized.chars().take(max_chars.saturating_sub(1)).collect::<String>();
    out.push('…');
    out
}
```

- [ ] **Step 4: Register module**

In `app/desktop/src-tauri/src/canonical_sessions.rs`, add:

```rust
mod session_observation;
```

and expose:

```rust
pub(crate) use self::session_observation::{read_session as read_observable_session, search_sessions as search_observable_sessions};
```

- [ ] **Step 5: Run tests**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::session_observation -- --nocapture
```

Expected: PASS.

---

### Task 6: Build and attach desktop session observation runtime

**Files:**
- Create: `app/desktop/src-tauri/src/chat/session_observation.rs`
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Modify: `app/desktop/src-tauri/src/chat/bridge_outreach.rs`

- [ ] **Step 1: Create runtime builder**

Create `app/desktop/src-tauri/src/chat/session_observation.rs`:

```rust
use std::sync::Arc;

pub(super) fn build_session_observation_runtime() -> kordi_tools::SessionObservationRuntime {
    let search_sessions = Arc::new(|request: kordi_tools::SearchSessionsRequest| {
        Box::pin(async move {
            crate::canonical_sessions::search_observable_sessions(request)
                .map_err(kordi_core::error::KordiError::Tool)
        }) as kordi_tools::SearchSessionsFuture
    });

    let read_session = Arc::new(|request: kordi_tools::ReadSessionRequest| {
        Box::pin(async move {
            crate::canonical_sessions::read_observable_session(request)
                .map_err(kordi_core::error::KordiError::Tool)
        }) as kordi_tools::ReadSessionFuture
    });

    kordi_tools::SessionObservationRuntime { search_sessions, read_session }
}
```

- [ ] **Step 2: Register chat module**

In `app/desktop/src-tauri/src/chat.rs`, add near other modules:

```rust
pub(crate) mod session_observation;
```

- [ ] **Step 3: Attach runtime before every desktop send**

In `app/desktop/src-tauri/src/chat/bridge_outreach.rs`, inside `prepare_desktop_session_for_send`, before mention-specific context logic, add:

```rust
runtime.set_session_observation_runtime(Some(
    crate::chat::session_observation::build_session_observation_runtime(),
));
```

Keep existing `runtime.set_reach_out_runtime(None);` behavior unchanged.

- [ ] **Step 4: Add focused integration test**

In `app/desktop/src-tauri/src/chat/bridge_outreach.rs` tests, add a source-level guard if constructing a full runtime is too heavy:

```rust
#[test]
fn prepare_send_attaches_session_observation_runtime() {
    let source = std::fs::read_to_string("src/chat/bridge_outreach.rs").expect("source");
    assert!(source.contains("set_session_observation_runtime(Some"));
    assert!(source.contains("build_session_observation_runtime()"));
}
```

If the test working directory is not stable, use `include_str!("bridge_outreach.rs")` in the test instead:

```rust
let source = include_str!("bridge_outreach.rs");
```

- [ ] **Step 5: Run desktop checks**

Run:

```bash
cargo test -p kordi-desktop chat::bridge_outreach::tests::prepare_send_attaches_session_observation_runtime -- --nocapture
cargo check -p kordi-desktop
```

Expected: PASS.

---

### Task 7: Verify tool calls through runtime callbacks

**Files:**
- Modify: `agent/crates/tools/src/session_observation.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/session_observation.rs`

- [ ] **Step 1: Add runtime serialization assertions**

Extend `search_sessions_calls_runtime_with_capped_limit` to assert structured details:

```rust
let details = result.details.expect("details");
assert_eq!(details["sessions"][0]["sessionId"], "session:launch");
assert_eq!(details["sessions"][0]["snippets"][0]["messageId"], "msg:1");
```

Add a read-session runtime test:

```rust
#[tokio::test]
async fn read_session_calls_runtime_and_serializes_details() {
    let runtime = SessionObservationRuntime {
        search_sessions: Arc::new(|_| Box::pin(async { unreachable!("not used") })),
        read_session: Arc::new(|request| Box::pin(async move {
            Ok(ReadSessionResponse {
                session: SessionObservationReadSession {
                    session_id: request.session_id,
                    title: "Launch".to_string(),
                    kind: "group".to_string(),
                    participants: vec![SessionObservationParticipant { name: "Alice".to_string(), kind: "human".to_string(), role: "participant".to_string() }],
                },
                window: SessionObservationWindow { around_message_id: None, has_more_before: false, has_more_after: false },
                messages: vec![SessionObservationMessage { message_id: "msg:1".to_string(), sender: "Alice".to_string(), role: "user".to_string(), sequence_num: 1, text: Some("Launch note".to_string()), time_label: Some("13:04".to_string()) }],
            })
        })),
    };
    let result = ReadSessionTool
        .execute(json!({"sessionId":"session:launch"}), &ctx_with_runtime(Some(runtime)), tokio_util::sync::CancellationToken::new())
        .await
        .expect("read result");
    assert_eq!(result.details.unwrap()["messages"][0]["messageId"], "msg:1");
}
```

- [ ] **Step 2: Run tests**

Run:

```bash
cargo test -p kordi-tools session_observation -- --nocapture
```

Expected: PASS.

---

### Task 8: PR #534 side-session copy follow-up plan

**Files in #534 worktree, not in this implementation branch:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/tests/chatHeaderBadge.test.tsx`

- [ ] **Step 1: Switch to #534 branch/worktree after tools land or when explicitly requested**

Use existing worktree:

```bash
cd /Users/shuyang/kordi/.worktrees/side-by-side-panel
```

- [ ] **Step 2: Update source tests**

Replace earlier co-pilot/private assertions with neutral side-session assertions:

```ts
test('side-by-side panel opens from an explicit neutral side-session action', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /Ask agent|Open side session/);
  assert.doesNotMatch(source, /Private helper for this chat/);
  assert.doesNotMatch(source, /data-chat-copilot-scope="private"/);
  assert.doesNotMatch(source, /const companionConversation =[^;]+\?\? suggestedCompanionConversation/s);
});
```

- [ ] **Step 3: Update UI copy**

In `ChatsPage.tsx`, change:

```tsx
Ask co-pilot
```

to:

```tsx
Ask agent
```

Change:

```tsx
Co-pilot · {companionConversation.name}
```

to:

```tsx
Side session · {companionConversation.name}
```

Remove:

```tsx
data-chat-copilot-scope="private"
```

Remove the copy:

```tsx
Private helper for this chat
```

Use neutral composer hint:

```tsx
placeholder={companionPaneKind === 'agent' ? 'Ask agent…' : `Message ${companionConversation.name}`}
```

- [ ] **Step 4: Re-run #534 targeted checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderBadge.test.tsx
pnpm --dir app/desktop typecheck
git diff --check
```

Expected: PASS for the targeted test file and typecheck. Existing full-suite failures on #534 remain separate until the branch is rebased/conflicts are resolved.

---

### Task 9: Final verification for session observation implementation

**Files:** all touched files.

- [ ] **Step 1: Run Rust tool tests**

```bash
cargo test -p kordi-tools session_observation -- --nocapture
cargo test -p kordi-tools registry::tests::builtin_metadata_categorizes_observation_tools_as_read_only_parallel -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: Run CLI registry/context tests**

```bash
cargo test -p kordi-cli tool_registry::tests::session_observation_tools_are_active_by_default -- --nocapture
cargo check -p kordi-cli --features desktop-runtime
```

Expected: PASS.

- [ ] **Step 3: Run desktop canonical tests**

```bash
cargo test -p kordi-desktop canonical_sessions::session_observation -- --nocapture
cargo test -p kordi-desktop chat::bridge_outreach::tests::prepare_send_attaches_session_observation_runtime -- --nocapture
cargo check -p kordi-desktop
```

Expected: PASS.

- [ ] **Step 4: Run workspace whitespace check**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Review changed files**

```bash
git diff --stat
git diff -- agent/crates/tools/src/session_observation.rs agent/crates/tools/src/types.rs agent/crates/tools/src/lib.rs agent/crates/tools/src/registry.rs agent/crates/cli/src/session_bootstrap.rs agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/turn_runner/tools.rs app/desktop/src-tauri/src/canonical_sessions/session_observation.rs app/desktop/src-tauri/src/canonical_sessions.rs app/desktop/src-tauri/src/chat/session_observation.rs app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/bridge_outreach.rs
```

Expected: only planned files changed.

---

## Implementation Notes

- Keep tool names exactly `search_sessions` and `read_session`.
- Do not add `kordi` to tool names.
- Do not add a co-pilot-specific system prompt.
- Do not special-case side-by-side sessions for tool availability.
- Use local canonical DB only for v1; no live Cloud fetch.
- Deny by default when a session is missing, non-active, or access is uncertain.
- Keep returned text compact; structured JSON details carry stable IDs.
