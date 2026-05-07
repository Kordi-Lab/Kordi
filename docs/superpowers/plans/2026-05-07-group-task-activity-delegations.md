# Group Task Activity Delegations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync group-level agent delegation as canonical task activity and render each task with participants in chat/project Tasks panels.

**Architecture:** Keep `delegated_exchanges` as the durable task source. Add a small backend sync helper for group agent session-message/session-relay activity, then expose derived task activity records from the canonical frontend read model. Replace static Tasks UI with a reusable task activity list component.

**Tech Stack:** Rust/Tauri backend with rusqlite canonical session DB; React 19 + TypeScript frontend; Node `tsx --test` unit tests; Cargo Rust tests.

---

## File Structure

- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions.rs`
  - Register a new `tasks` submodule.
- Create: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs`
  - Detect group agent delegation, resolve initiator/target, create/update `delegated_exchanges`, and backfill `delegated_exchange_id` on related canonical messages.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`
  - Call the group task helper after relay/message sync for `session-message` and `session-relay` paths.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs`
  - Add backend regression tests for group bridge-agent task sync, fanout dedupe, and human fanout non-task behavior.
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`
  - Add backend regression test for local-agent group relay task sync.
- Modify: `app/desktop/src/kordi-app/types.ts`
  - Add `SessionTaskActivity` and `SessionTaskParticipant`; add `taskActivities` to `Conversation` and `ProjectSession`.
- Modify: `app/desktop/src/features/canonical/readModel/indexes.ts`
  - Derive task activity records from `delegatedExchanges`, identities, and participants.
- Modify: `app/desktop/src/features/canonical/sessionReadModel.ts`
  - Expose `taskActivities(sessionId)` and attach task activity details to hydrated conversations.
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
  - Use canonical task counts/activity for project sessions and aggregate project task counts.
- Create: `app/desktop/src/pages/TaskActivityList.tsx`
  - Reusable task rendering component for chat and project panels.
- Modify: `app/desktop/src/pages/ChatDetailPanel.tsx`
  - Replace hardcoded Tasks content with `TaskActivityList`.
- Modify: `app/desktop/src/pages/ProjectDetailPanel.tsx`
  - Replace static project task text with `TaskActivityList` and canonical counts.
- Create: `app/desktop/tests/canonicalTaskActivityReadModel.test.tsx`
  - Test frontend task activity derivation with participants.
- Modify: `app/desktop/tests/chatDetailPanel.test.tsx`
  - Test chat task panel renders task participants and empty state.
- Create: `app/desktop/tests/projectTaskActivityPanel.test.tsx`
  - Test project task panel renders canonical task activity.

---

### Task 1: Backend failing tests for group task activity

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`

- [ ] **Step 1: Add failing test for bridge-agent group session-message task creation**

Append this test to `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs`:

```rust
#[test]
fn group_bridge_agent_session_message_creates_delegated_exchange_task() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        ("human:local", "human", "Local", Some("kh_local"), Some("kd_local"), None, None),
        ("human:remote", "human", "Remote", Some("kh_remote"), Some("kd_remote"), None, None),
        ("agent:remote", "agent", "Remote Kordi", None, Some("kd_remote"), Some("human:remote"), Some("ka_remote")),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:task-sync";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Task group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:local".to_string(), "human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    ).expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-agent".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Task group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:parent:request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote-agent".to_string()),
        bridge_request_id: Some("bridge_req_group_task".to_string()),
        delivery_state: Some("processing".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: Some("ka_remote".to_string()),
        target_display_name: "Remote Kordi".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("kordi-desktop".to_string()),
        request_text: "@RemoteKordi summarize the plan".to_string(),
        trigger_text: Some("@RemoteKordi summarize the plan".to_string()),
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "processing".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_500,
        completed_at_ms: None,
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote-agent".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Remote Kordi".to_string()),
        peer_owner_name: Some("Remote".to_string()),
        peer_runtime: "kordi-desktop".to_string(),
        project_id: None,
        project_name: None,
        title: "Remote Kordi".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 1_500,
        updated_at_label: "10:00".to_string(),
        awaiting_reply: true,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_group_task_request".to_string(),
        direction: "outbound".to_string(),
        sender: Some("Local".to_string()),
        text: "@RemoteKordi summarize the plan".to_string(),
        time_label: "10:00".to_string(),
        timestamp_ms: 1_000,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("processing".to_string()),
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local",
        None,
        Some("human:remote"),
        "agent:remote",
        true,
    ).expect("sync group agent task");

    let rows = conn.prepare(
        "SELECT id, session_id, initiator_identity_id, target_identity_id, bridge_request_id, context_policy, status
         FROM delegated_exchanges WHERE session_id = ?1",
    ).expect("prepare exchange query")
        .query_map(rusqlite::params![parent_session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        }).expect("query exchanges")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect exchanges");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "delegation:bridge-session-message:session:group:task-sync:bridge_req_group_task");
    assert_eq!(rows[0].1, parent_session_id);
    assert_eq!(rows[0].2, "human:local");
    assert_eq!(rows[0].3, "agent:remote");
    assert_eq!(rows[0].4.as_deref(), Some("bridge_req_group_task"));
    assert_eq!(rows[0].5, "session-message");
    assert_eq!(rows[0].6, "processing");
}
```

- [ ] **Step 2: Add failing test for deduping group fanout copies**

Append this test to the same file:

```rust
#[test]
fn group_bridge_agent_session_message_fanout_keeps_one_delegated_exchange_task() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        ("human:local", "human", "Local", Some("kh_local"), Some("kd_local"), None, None),
        ("human:alice", "human", "Alice", Some("kh_alice"), Some("kd_alice"), None, None),
        ("human:bob", "human", "Bob", Some("kh_bob"), Some("kd_bob"), None, None),
        ("agent:alice", "agent", "Alice Kordi", None, Some("kd_alice"), Some("human:alice"), Some("ka_alice")),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:task-fanout";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Fanout group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:local".to_string(), "human:alice".to_string(), "human:bob".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    ).expect("seed group");

    for (conversation_id, target_node, target_name) in [
        ("bridge:host:alice-agent", "kd_alice", "Alice Kordi"),
        ("bridge:host:bob-copy", "kd_bob", "Bob"),
    ] {
        let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
            target_kind: if target_name.contains("Kordi") { "bridge-agent" } else { "bridge-person" }.to_string(),
            parent_session_id: Some(parent_session_id.to_string()),
            parent_session_title: Some("Fanout group".to_string()),
            parent_session_kind: Some("group".to_string()),
            parent_group_space_id: Some(parent_session_id.to_string()),
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            parent_turn_id: None,
            parent_message_id: Some("msg:parent:fanout".to_string()),
            bridge_host_id: "bridge-host".to_string(),
            bridge_conversation_id: Some(conversation_id.to_string()),
            bridge_request_id: Some("bridge_req_group_task_fanout".to_string()),
            delivery_state: Some("responded".to_string()),
            target_node_id: target_node.to_string(),
            target_human_id: Some(if target_node == "kd_alice" { "kh_alice" } else { "kh_bob" }.to_string()),
            target_agent_id: if target_name.contains("Kordi") { Some("ka_alice".to_string()) } else { None },
            target_display_name: target_name.to_string(),
            target_owner_name: Some(target_name.to_string()),
            target_runtime: Some(if target_name.contains("Kordi") { "kordi-desktop" } else { "person" }.to_string()),
            request_text: "@AliceKordi check this".to_string(),
            trigger_text: Some("@AliceKordi check this".to_string()),
            context_text: None,
            context_policy: Some("session-message".to_string()),
            project_id: None,
            project_name: None,
            status: "completed".to_string(),
            created_at_ms: 1_000,
            updated_at_ms: 2_000,
            completed_at_ms: Some(2_000),
            error: None,
        };
        let conversation = crate::bridge::DesktopBridgeConversation {
            id: conversation_id.to_string(),
            canonical_session_id: parent_session_id.to_string(),
            host_id: "bridge-host".to_string(),
            peer_node_id: target_node.to_string(),
            peer_display_name: Some(target_name.to_string()),
            peer_owner_name: Some(target_name.to_string()),
            peer_runtime: if target_name.contains("Kordi") { "kordi-desktop" } else { "person" }.to_string(),
            project_id: None,
            project_name: None,
            title: target_name.to_string(),
            subtitle: String::new(),
            unread_count: 0,
            updated_at_ms: 2_000,
            updated_at_label: "10:01".to_string(),
            awaiting_reply: false,
            peer_typing: false,
            peer_last_heartbeat_label: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        };
        let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
            id: format!("bridge_msg_{target_node}"),
            direction: if target_name.contains("Kordi") { "inbound-response" } else { "outbound" }.to_string(),
            sender: Some(target_name.to_string()),
            text: if target_name.contains("Kordi") { "Checked." } else { "@AliceKordi check this" }.to_string(),
            time_label: "10:01".to_string(),
            timestamp_ms: 2_000,
            request_id: outreach.bridge_request_id.clone(),
            delivery_state: Some("responded".to_string()),
            outreach: Some(outreach.clone()),
            attachments: Vec::new(),
        }];
        sync_bridge_outreach_into_parent_session(
            &conn,
            &conversation,
            &messages,
            &outreach,
            "human:local",
            None,
            Some("human:alice"),
            if target_name.contains("Kordi") { "agent:alice" } else { "human:bob" },
            target_name.contains("Kordi"),
        ).expect("sync fanout copy");
    }

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![parent_session_id],
        |row| row.get(0),
    ).expect("exchange count");
    assert_eq!(count, 1);
}
```

- [ ] **Step 3: Add failing test that human-only fanout is not a task**

Append this test to `group_agent_requests.rs`:

```rust
#[test]
fn group_person_session_message_does_not_create_delegated_exchange_task() {
    let conn = test_conn();
    for (id, display_name, human_id, node_id) in [
        ("human:local", "Local", "kh_local", "kd_local"),
        ("human:remote", "Remote", "kh_remote", "kd_remote"),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: "human".to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some(node_id.to_string()),
                human_id: Some(human_id.to_string()),
                agent_id: None,
                avatar_key: Some(human_id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:person-fanout-not-task";
    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("People".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: None,
        parent_message_id: Some("msg:person".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote".to_string()),
        bridge_request_id: Some("bridge_req_person_only".to_string()),
        delivery_state: Some("delivered".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: None,
        target_display_name: "Remote".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "hello everyone".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-message".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Remote".to_string()),
        peer_owner_name: Some("Remote".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Remote".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 1_000,
        updated_at_label: "10:00".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_person_only".to_string(),
        direction: "outbound".to_string(),
        sender: Some("Local".to_string()),
        text: "hello everyone".to_string(),
        time_label: "10:00".to_string(),
        timestamp_ms: 1_000,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("delivered".to_string()),
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local",
        None,
        Some("human:remote"),
        "human:remote",
        false,
    ).expect("sync person fanout");

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![parent_session_id],
        |row| row.get(0),
    ).expect("exchange count");
    assert_eq!(count, 0);
}
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_requests -- --nocapture
```

Expected: the new bridge-agent tests fail because no delegated exchange is created for group `session-message`; the human-only test should pass or remain unaffected.

- [ ] **Step 5: Commit failing tests**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs
git commit -m "test: cover group task activity delegation sync"
```

---

### Task 2: Backend group task sync helper

**Files:**
- Create: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`

- [ ] **Step 1: Create the task sync helper**

Create `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs`:

```rust
use rusqlite::{params, Connection, OptionalExtension};

use super::super::bridge_routing::{outreach_is_session_message, outreach_is_session_relay};
use super::super::models::CreateCanonicalDelegatedExchangeRequest;
use super::super::{create_delegated_exchange_in_db, identity_display_name};

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn is_group_parent_session(
    parent_session_id: &str,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach
        .parent_session_kind
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || outreach
            .parent_group_space_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || parent_session_id.starts_with("session:group:")
}

fn outreach_is_agent_task(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    peer_is_agent: bool,
) -> bool {
    outreach.target_kind.eq_ignore_ascii_case("bridge-agent")
        || peer_is_agent
        || clean_text(outreach.target_agent_id.as_deref()).is_some()
        || outreach
            .target_runtime
            .as_deref()
            .is_some_and(|runtime| runtime.to_lowercase().contains("kordi") || runtime.to_lowercase().contains("agent"))
        || outreach.parent_turn_id.is_some()
}

fn group_task_request_key(
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> String {
    clean_text(outreach.bridge_request_id.as_deref())
        .or_else(|| clean_text(outreach.parent_turn_id.as_deref()))
        .or_else(|| clean_text(outreach.parent_message_id.as_deref()))
        .unwrap_or_else(|| conversation.id.clone())
}

fn group_task_delegation_id(parent_session_id: &str, request_key: &str) -> String {
    format!("delegation:bridge-session-message:{parent_session_id}:{request_key}")
}

fn terminal_response_status(delivery_state: Option<&str>) -> Option<&'static str> {
    match delivery_state.map(str::trim) {
        Some("responded") | Some("read") | Some("complete") | Some("completed") => Some("complete"),
        Some("processing_failed") | Some("failed") => Some("failed"),
        Some("cancelled") => Some("cancelled"),
        Some("timeout") => Some("timeout"),
        _ => None,
    }
}

fn outreach_task_status(
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> String {
    for message in messages {
        if matches!(message.direction.as_str(), "inbound-response" | "outbound-response") {
            if let Some(status) = terminal_response_status(message.delivery_state.as_deref()) {
                return status.to_string();
            }
            if !message.text.trim().is_empty()
                && !message.text.trim().eq_ignore_ascii_case("processing")
                && !message.text.trim().eq_ignore_ascii_case("processing...")
                && !message.text.trim().eq_ignore_ascii_case("processing…")
            {
                return "complete".to_string();
            }
        }
    }

    match outreach.status.trim() {
        "completed" | "complete" => "complete".to_string(),
        "failed" | "processing_failed" => "failed".to_string(),
        "cancelled" => "cancelled".to_string(),
        "timeout" => "timeout".to_string(),
        "sending" | "awaitingReply" | "processing" => "processing".to_string(),
        _ => "processing".to_string(),
    }
}

fn message_has_request_id(
    message: &crate::bridge::DesktopBridgeConversationMessage,
    request_id: Option<&str>,
) -> bool {
    request_id.is_some_and(|request_id| {
        message
            .request_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| value == request_id)
    })
}

fn request_message_source_ids(
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> Vec<String> {
    let request_id = outreach.bridge_request_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let mut ids = Vec::new();
    if let Some(parent_message_id) = clean_text(outreach.parent_message_id.as_deref()) {
        ids.push(parent_message_id);
    }
    for message in messages {
        if !message_has_request_id(message, request_id) {
            continue;
        }
        if matches!(message.direction.as_str(), "outbound" | "inbound") {
            ids.push(format!(
                "desktop-bridge-parent:{parent_session_id}:{}",
                outreach
                    .parent_message_id
                    .as_deref()
                    .or(message.request_id.as_deref())
                    .unwrap_or(message.id.as_str())
            ));
            ids.push(format!("desktop-bridge-session-relay:{parent_session_id}:{}:{}", conversation.id, message.id));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn response_message_source_ids(
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> Vec<String> {
    let request_id = outreach.bridge_request_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let mut ids = Vec::new();
    for message in messages {
        if !message_has_request_id(message, request_id) {
            continue;
        }
        if matches!(message.direction.as_str(), "inbound-response" | "outbound-response") {
            let stable_id = message
                .request_id
                .as_deref()
                .or(outreach.bridge_request_id.as_deref())
                .or(outreach.parent_turn_id.as_deref())
                .or(outreach.parent_message_id.as_deref())
                .map(|value| format!("agent-response:{value}"))
                .unwrap_or_else(|| format!("{}:{}", conversation.id, message.id));
            ids.push(format!("desktop-bridge-parent:{parent_session_id}:{stable_id}"));
            ids.push(format!("desktop-bridge-session-relay:{parent_session_id}:{stable_id}"));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn first_message_id_for_sources(conn: &Connection, source_event_ids: &[String]) -> Result<Option<String>, String> {
    for source_event_id in source_event_ids {
        let found = conn
            .query_row(
                "SELECT id FROM session_messages WHERE source_event_id = ?1 ORDER BY created_at_ms ASC, sequence_num ASC LIMIT 1",
                params![source_event_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn backfill_message_delegation_ids(
    conn: &Connection,
    delegation_id: &str,
    source_event_ids: &[String],
) -> Result<(), String> {
    for source_event_id in source_event_ids {
        conn.execute(
            "UPDATE session_messages
             SET delegated_exchange_id = ?1
             WHERE source_event_id = ?2
               AND (delegated_exchange_id IS NULL OR delegated_exchange_id = ?1)",
            params![delegation_id, source_event_id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn local_agent_identity_for_relay(
    local_agent_identity_id: Option<&str>,
    local_human_identity_id: &str,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> String {
    if outreach.parent_turn_id.is_some() {
        local_agent_identity_id.unwrap_or(local_human_identity_id).to_string()
    } else {
        local_human_identity_id.to_string()
    }
}

pub(super) fn sync_group_agent_task_activity(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
    peer_is_agent: bool,
) -> Result<(), String> {
    if !(outreach_is_session_message(outreach) || outreach_is_session_relay(outreach)) {
        return Ok(());
    }
    if !is_group_parent_session(parent_session_id, outreach) {
        return Ok(());
    }
    if !outreach_is_agent_task(outreach, peer_is_agent) {
        return Ok(());
    }

    let request_key = group_task_request_key(conversation, outreach);
    let delegation_id = group_task_delegation_id(parent_session_id, &request_key);
    let request_source_ids = request_message_source_ids(parent_session_id, conversation, messages, outreach);
    let response_source_ids = response_message_source_ids(parent_session_id, conversation, messages, outreach);
    let request_message_id = first_message_id_for_sources(conn, &request_source_ids)?
        .or_else(|| clean_text(outreach.parent_message_id.as_deref()));
    let response_message_id = first_message_id_for_sources(conn, &response_source_ids)?;
    let initiator_identity_id = if outreach.parent_turn_id.is_some() {
        local_agent_identity_for_relay(local_agent_identity_id, local_human_identity_id, outreach)
    } else {
        relationship_identity_id
            .map(ToString::to_string)
            .unwrap_or_else(|| local_human_identity_id.to_string())
    };
    let target_identity_id = if outreach.parent_turn_id.is_some() {
        local_agent_identity_id
            .map(ToString::to_string)
            .unwrap_or_else(|| remote_target_identity_id.to_string())
    } else {
        remote_target_identity_id.to_string()
    };

    if identity_display_name(conn, &target_identity_id)?.is_none() {
        return Ok(());
    }

    create_delegated_exchange_in_db(
        conn,
        CreateCanonicalDelegatedExchangeRequest {
            id: Some(delegation_id.clone()),
            session_id: parent_session_id.to_string(),
            initiator_identity_id,
            target_identity_id,
            trigger_message_id: clean_text(outreach.parent_message_id.as_deref()),
            request_message_id: request_message_id.clone(),
            response_message_id,
            transport: Some("bridge".to_string()),
            bridge_host_id: Some(conversation.host_id.clone()),
            bridge_conversation_id: outreach
                .bridge_conversation_id
                .clone()
                .or_else(|| Some(conversation.id.clone())),
            bridge_request_id: clean_text(outreach.bridge_request_id.as_deref()),
            context_policy: Some(if outreach_is_session_message(outreach) { "session-message" } else { "session-relay" }.to_string()),
            status: Some(outreach_task_status(messages, outreach)),
            error: outreach.error.clone(),
        },
    )?;

    backfill_message_delegation_ids(conn, &delegation_id, &request_source_ids)?;
    backfill_message_delegation_ids(conn, &delegation_id, &response_source_ids)?;

    Ok(())
}
```

- [ ] **Step 2: Register the module**

Modify `app/desktop/src-tauri/src/canonical_sessions/parent_sessions.rs`:

```rust
mod messages;
mod outreach;
mod participants;
mod relay;
mod tasks;
```

- [ ] **Step 3: Call helper from outreach sync**

In `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`, change the imports:

```rust
use super::relay::{
    sync_parent_session_invite, sync_parent_session_relay_join_event,
    sync_parent_session_relay_messages, sync_parent_session_update,
};
use super::tasks::sync_group_agent_task_activity;
```

Then replace this block:

```rust
    if is_session_relay || is_session_message {
        sync_parent_session_relay_messages(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        sync_parent_session_relay_join_event(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        if is_session_relay {
            sync_parent_session_bridge_messages(
                conn,
                parent_session_id,
                conversation,
                messages,
                outreach,
                local_human_identity_id,
                remote_target_identity_id,
            )?;
        }
        return Ok(!is_session_message);
    }
```

with:

```rust
    if is_session_relay || is_session_message {
        sync_parent_session_relay_messages(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        sync_parent_session_relay_join_event(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        if is_session_relay {
            sync_parent_session_bridge_messages(
                conn,
                parent_session_id,
                conversation,
                messages,
                outreach,
                local_human_identity_id,
                remote_target_identity_id,
            )?;
        }
        sync_group_agent_task_activity(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        return Ok(!is_session_message);
    }
```

- [ ] **Step 4: Run backend tests**

Run:

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_requests -- --nocapture
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_message_sync -- --nocapture
```

Expected: `group_agent_requests` and `group_message_sync` pass.

- [ ] **Step 5: Commit backend implementation**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/parent_sessions.rs \
  app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs \
  app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs
git commit -m "feat: sync group agent task activity"
```

---

### Task 3: Local-agent relay backend test and status refinement

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs`

- [ ] **Step 1: Add failing/passing coverage for local-agent relay task**

Append this test to `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`:

```rust
#[test]
fn group_local_agent_response_relay_creates_delegated_exchange_task() {
    let conn = test_conn();
    for (id, kind, display_name, human_id, node_id, owner_id, agent_id) in [
        ("human:local", "human", "Local", Some("kh_local"), Some("kd_local"), None, None),
        ("human:remote", "human", "Remote", Some("kh_remote"), Some("kd_remote"), None, None),
        ("agent:local", "agent", "Local Kordi", None, Some("kd_local"), Some("human:local"), Some("ka_local")),
    ] {
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_id.map(ToString::to_string),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: node_id.map(ToString::to_string),
                human_id: human_id.map(ToString::to_string),
                agent_id: agent_id.map(ToString::to_string),
                avatar_key: human_id.or(agent_id).map(ToString::to_string),
                profile_image_url: None,
                metadata: None,
            },
        ).expect("upsert identity");
    }

    let parent_session_id = "session:group:local-agent-task";
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some("Local agent group".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["human:local".to_string(), "human:remote".to_string(), "agent:local".to_string()],
            metadata: Some(serde_json::json!({ "source": "chat-create-flow" })),
        },
    ).expect("seed group");

    let outreach = crate::bridge::DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some(parent_session_id.to_string()),
        parent_session_title: Some("Local agent group".to_string()),
        parent_session_kind: Some("group".to_string()),
        parent_group_space_id: Some(parent_session_id.to_string()),
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: Some("turn:local-agent".to_string()),
        parent_message_id: Some("msg:local-agent-request".to_string()),
        bridge_host_id: "bridge-host".to_string(),
        bridge_conversation_id: Some("bridge:host:remote".to_string()),
        bridge_request_id: Some("bridge_req_local_agent_task".to_string()),
        delivery_state: Some("responded".to_string()),
        target_node_id: "kd_remote".to_string(),
        target_human_id: Some("kh_remote".to_string()),
        target_agent_id: None,
        target_display_name: "Remote".to_string(),
        target_owner_name: Some("Remote".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "local answer".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-relay".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 2_000,
        updated_at_ms: 2_100,
        completed_at_ms: Some(2_100),
        error: None,
    };
    let conversation = crate::bridge::DesktopBridgeConversation {
        id: "bridge:host:remote".to_string(),
        canonical_session_id: parent_session_id.to_string(),
        host_id: "bridge-host".to_string(),
        peer_node_id: "kd_remote".to_string(),
        peer_display_name: Some("Remote".to_string()),
        peer_owner_name: Some("Remote".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        title: "Remote".to_string(),
        subtitle: String::new(),
        unread_count: 0,
        updated_at_ms: 2_100,
        updated_at_label: "10:03".to_string(),
        awaiting_reply: false,
        peer_typing: false,
        peer_last_heartbeat_label: None,
        outreach: None,
        identity: None,
        messages: Vec::new(),
    };
    let messages = vec![crate::bridge::DesktopBridgeConversationMessage {
        id: "bridge_msg_local_agent_relay".to_string(),
        direction: "outbound-response".to_string(),
        sender: Some("Local Kordi".to_string()),
        text: "local answer".to_string(),
        time_label: "10:03".to_string(),
        timestamp_ms: 2_100,
        request_id: outreach.bridge_request_id.clone(),
        delivery_state: Some("responded".to_string()),
        outreach: Some(outreach.clone()),
        attachments: Vec::new(),
    }];

    sync_bridge_outreach_into_parent_session(
        &conn,
        &conversation,
        &messages,
        &outreach,
        "human:local",
        Some("agent:local"),
        Some("human:remote"),
        "human:remote",
        false,
    ).expect("sync local agent relay task");

    let row: (String, String, String) = conn.query_row(
        "SELECT initiator_identity_id, target_identity_id, status FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![parent_session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).expect("delegated exchange");
    assert_eq!(row.0, "agent:local");
    assert_eq!(row.1, "agent:local");
    assert_eq!(row.2, "complete");
}
```

- [ ] **Step 2: Run the local-agent relay test**

Run:

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_responses::group_local_agent_response_relay_creates_delegated_exchange_task -- --nocapture
```

Expected: pass after Task 2. If it fails because target identity is remote human, adjust `sync_group_agent_task_activity(...)` so `outreach.parent_turn_id.is_some()` sets `target_identity_id` to `local_agent_identity_id.unwrap_or(local_human_identity_id)`.

- [ ] **Step 3: Run broader backend regression tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_responses -- --nocapture
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::direct_message_sync -- --nocapture
```

Expected: pass.

- [ ] **Step 4: Commit test/refinement**

```bash
git add app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs \
  app/desktop/src-tauri/src/canonical_sessions/parent_sessions/tasks.rs
git commit -m "test: cover local agent group task relay"
```

---

### Task 4: Frontend types and read-model task activity

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/features/canonical/readModel/indexes.ts`
- Modify: `app/desktop/src/features/canonical/sessionReadModel.ts`
- Create: `app/desktop/tests/canonicalTaskActivityReadModel.test.tsx`

- [ ] **Step 1: Add shared task activity types**

In `app/desktop/src/kordi-app/types.ts`, add after `ConversationBridgeTarget`:

```ts
export type SessionTaskParticipant = Pick<ConversationParticipant,
  | 'id'
  | 'name'
  | 'kind'
  | 'role'
  | 'source'
  | 'ownerIdentityId'
  | 'ownerName'
  | 'bridgeHostId'
  | 'bridgeNodeId'
  | 'humanId'
  | 'agentId'
  | 'avatarKey'
  | 'profileImageUrl'
>;

export type SessionTaskActivity = {
  id: string;
  sessionId: string;
  status: string;
  initiator: SessionTaskParticipant | null;
  target: SessionTaskParticipant | null;
  participants: SessionTaskParticipant[];
  createdAtMs: number;
  updatedAtMs: number;
  bridgeConversationId?: string | null;
  bridgeRequestId?: string | null;
  contextPolicy: string;
  error?: string | null;
};
```

Add `taskActivities?: SessionTaskActivity[];` to `Conversation` near `canonicalDelegatedExchangeCount`:

```ts
  canonicalDelegatedExchangeCount?: number;
  taskActivities?: SessionTaskActivity[];
```

Add `taskActivities?: SessionTaskActivity[];` to `ProjectSession` near `tasks`:

```ts
  tasks: number;
  taskActivities?: SessionTaskActivity[];
```

- [ ] **Step 2: Extend canonical indexes**

In `app/desktop/src/features/canonical/readModel/indexes.ts`, update imports:

```ts
  SessionTaskActivity,
```

Add to `CanonicalIndexes`:

```ts
  taskActivitiesBySessionId: Map<string, SessionTaskActivity[]>;
```

Add to `emptyIndexes()`:

```ts
    taskActivitiesBySessionId: new Map(),
```

Add this helper before `export function buildCanonicalIndexes(...)`:

```ts
function taskParticipantFromIdentity(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): SessionTaskActivity['initiator'] {
  if (!identity) return null;
  const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
  return {
    id: identity.id,
    name: ownerScopedAgentName(identity, identityById, profileHumanIdentityId) ?? identity.displayName,
    kind: identity.kind,
    role: identity.id === profileHumanIdentityId ? 'self' : identity.kind === 'agent' ? 'delegate' : 'person',
    source: identity.source,
    ownerIdentityId: identity.ownerIdentityId,
    ownerName: owner ? (ownerScopedAgentName(owner, identityById, profileHumanIdentityId) ?? owner.displayName) : null,
    bridgeHostId: identity.sourceHostId,
    bridgeNodeId: identity.bridgeNodeId,
    humanId: identity.humanId,
    agentId: identity.agentId,
    avatarKey: identity.avatarKey,
    profileImageUrl: identity.profileImageUrl,
  };
}

function buildTaskActivitiesBySessionId(
  canonicalState: CanonicalSessionState,
  identityById: Map<string, CanonicalIdentity>,
  canonicalParticipantsBySessionId: Map<string, ConversationParticipant[]>,
) {
  const activities = new Map<string, SessionTaskActivity[]>();
  for (const exchange of canonicalState.delegatedExchanges) {
    const participants = canonicalParticipantsBySessionId.get(exchange.sessionId) ?? [];
    const activity: SessionTaskActivity = {
      id: exchange.id,
      sessionId: exchange.sessionId,
      status: exchange.status,
      initiator: taskParticipantFromIdentity(identityById.get(exchange.initiatorIdentityId), identityById, canonicalState.profile.humanIdentityId),
      target: taskParticipantFromIdentity(identityById.get(exchange.targetIdentityId), identityById, canonicalState.profile.humanIdentityId),
      participants: participants.map((participant) => ({ ...participant })),
      createdAtMs: exchange.createdAtMs,
      updatedAtMs: exchange.updatedAtMs,
      bridgeConversationId: exchange.bridgeConversationId,
      bridgeRequestId: exchange.bridgeRequestId,
      contextPolicy: exchange.contextPolicy,
      error: exchange.error,
    };
    activities.set(exchange.sessionId, [...(activities.get(exchange.sessionId) ?? []), activity]);
  }
  for (const [sessionId, sessionActivities] of activities) {
    activities.set(sessionId, sessionActivities.sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id)));
  }
  return activities;
}
```

Near the end of `buildCanonicalIndexes`, after `presenceSummaryBySessionId` is built, add:

```ts
  const taskActivitiesBySessionId = buildTaskActivitiesBySessionId(
    canonicalState,
    identityById,
    canonicalParticipantsBySessionId,
  );
```

Return it:

```ts
    taskActivitiesBySessionId,
```

- [ ] **Step 3: Expose task activities from session read model**

In `app/desktop/src/features/canonical/sessionReadModel.ts`, update imports:

```ts
  SessionTaskActivity,
```

Add `taskActivities?: SessionTaskActivity[];` to `CanonicalConversationLike`.

Add to `CanonicalSessionReadModel`:

```ts
  taskActivities: (sessionId: string) => SessionTaskActivity[];
```

Add method inside returned object:

```ts
    taskActivities(sessionId) {
      return indexes.taskActivitiesBySessionId.get(sessionId) ?? [];
    },
```

In `applyConversation(...)`, before `return`, compute:

```ts
      const taskActivities = this.taskActivities(sessionId);
```

Then set:

```ts
        taskActivities,
        canonicalDelegatedExchangeCount: taskActivities.length,
```

Replace the existing `canonicalDelegatedExchangeCount: indexes.delegatedExchangeCountBySessionId.get(sessionId) ?? 0` line with the `taskActivities.length` line above so count and detail are consistent.

- [ ] **Step 4: Add frontend read-model test**

Create `app/desktop/tests/canonicalTaskActivityReadModel.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('canonical read model maps delegated exchanges to task activity with participants', () => {
  const sessionId = 'session:group:task-read-model';
  const state = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-alice', humanId: 'human-alice', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:alice', kind: 'agent', displayName: 'Alice Kordi', source: 'bridge', sourceHostId: 'host-1', ownerIdentityId: 'human:alice', bridgeNodeId: 'node-alice', agentId: 'agent-alice', avatarKey: 'agent-alice', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Task group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'chat-create-flow' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:alice', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [
      {
        id: 'delegation:bridge-session-message:session:group:task-read-model:bridge_req_task',
        sessionId,
        initiatorIdentityId: 'human:me',
        targetIdentityId: 'agent:alice',
        triggerMessageId: 'msg:parent',
        requestMessageId: 'msg:parent',
        responseMessageId: null,
        transport: 'bridge',
        bridgeHostId: 'host-1',
        bridgeConversationId: 'bridge:host:alice-agent',
        bridgeRequestId: 'bridge_req_task',
        contextPolicy: 'session-message',
        status: 'processing',
        error: null,
        createdAtMs: 2,
        updatedAtMs: 3,
      },
    ],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(state as never);
  const conversation = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '')[0];

  assert.equal(conversation?.canonicalDelegatedExchangeCount, 1);
  assert.equal(conversation?.taskActivities?.length, 1);
  assert.equal(conversation?.taskActivities?.[0]?.target?.name, 'Alice Kordi');
  assert.equal(conversation?.taskActivities?.[0]?.initiator?.name, 'Me');
  assert.deepEqual(conversation?.taskActivities?.[0]?.participants.map((participant) => participant.name), ['Me', 'Alice', 'Alice Kordi']);
  assert.equal(conversation?.taskActivities?.[0]?.bridgeRequestId, 'bridge_req_task');
});
```

- [ ] **Step 5: Run frontend read-model test**

Run:

```bash
pnpm --dir app/desktop test:unit -- canonicalTaskActivityReadModel.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit frontend read-model changes**

```bash
git add app/desktop/src/kordi-app/types.ts \
  app/desktop/src/features/canonical/readModel/indexes.ts \
  app/desktop/src/features/canonical/sessionReadModel.ts \
  app/desktop/tests/canonicalTaskActivityReadModel.test.tsx
git commit -m "feat: expose canonical task activity read model"
```

---

### Task 5: Project/session view models use canonical task counts

**Files:**
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`

- [ ] **Step 1: Add local helper functions near `liveTurnsViewModelSignature(...)`**

Add:

```ts
function canonicalTaskActivitiesForSession(
  readModel: ReturnType<typeof createCanonicalSessionReadModel>,
  sessionId: string,
) {
  return readModel?.taskActivities(sessionId) ?? [];
}

function canonicalTaskCountForSession(
  readModel: ReturnType<typeof createCanonicalSessionReadModel>,
  sessionId: string,
  fallback: number,
) {
  const activities = canonicalTaskActivitiesForSession(readModel, sessionId);
  return activities.length > 0 ? activities.length : fallback;
}
```

- [ ] **Step 2: Attach canonical task activity to project sessions**

Inside `runtimeProjects.map(...)`, before `return { id: group.id, ... }`, add:

```ts
      const sessionTaskActivitiesById = new Map(
        group.sessions.map(({ id: sessionId }) => [
          sessionId,
          canonicalTaskActivitiesForSession(canonicalReadModel, sessionId),
        ]),
      );
      const canonicalProjectTaskCount = [...sessionTaskActivitiesById.values()]
        .reduce((total, activities) => total + activities.length, 0);
```

Replace project `tasks` line:

```ts
        tasks: workspaceProject?.tasks ?? 0,
```

with:

```ts
        tasks: canonicalProjectTaskCount > 0 ? canonicalProjectTaskCount : (workspaceProject?.tasks ?? 0),
```

Inside the project session map, before `return { id: sessionId, ... }`, add:

```ts
          const taskActivities = sessionTaskActivitiesById.get(sessionId) ?? [];
          const taskCount = taskActivities.length > 0 ? taskActivities.length : (workspaceProject?.tasks ?? 0);
```

Replace session `tasks` line:

```ts
            tasks: workspaceProject?.tasks ?? 0,
```

with:

```ts
            tasks: taskCount,
            taskActivities,
```

- [ ] **Step 3: Adjust native project draft session**

Add task activities to `nativeProjectDraftSession`:

```ts
    taskActivities: [],
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: pass.

- [ ] **Step 5: Commit view model changes**

```bash
git add app/desktop/src/app/useWorkspaceViewModels.ts
git commit -m "feat: use canonical project task counts"
```

---

### Task 6: Task activity UI component and panel replacement

**Files:**
- Create: `app/desktop/src/pages/TaskActivityList.tsx`
- Modify: `app/desktop/src/pages/ChatDetailPanel.tsx`
- Modify: `app/desktop/src/pages/ProjectDetailPanel.tsx`
- Modify: `app/desktop/tests/chatDetailPanel.test.tsx`
- Create: `app/desktop/tests/projectTaskActivityPanel.test.tsx`

- [ ] **Step 1: Create reusable task component**

Create `app/desktop/src/pages/TaskActivityList.tsx`:

```tsx
import { Bot, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { SessionTaskActivity, SessionTaskParticipant } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

function taskStatusClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (['complete', 'completed', 'read', 'delivered'].includes(normalized)) return 'app-badge-neutral';
  if (['failed', 'timeout', 'cancelled'].includes(normalized)) return 'app-badge-attention';
  return 'app-badge-neutral';
}

function taskStatusLabel(status: string) {
  const normalized = status.trim().toLowerCase();
  if (['complete', 'completed'].includes(normalized)) return 'Complete';
  if (normalized === 'processing') return 'Running';
  if (normalized === 'cancelled') return 'Stopped';
  if (normalized === 'timeout') return 'Timed out';
  if (normalized === 'failed') return 'Failed';
  return status || 'Pending';
}

function participantLabel(participant: SessionTaskParticipant | null | undefined, fallback: string) {
  return participant?.name?.trim() || fallback;
}

function participantAvatar(participant: SessionTaskParticipant, index: number) {
  return (
    <IdentityAvatar
      key={`${participant.id}-${index}`}
      kind={participant.kind === 'agent' ? 'agent' : 'human'}
      seed={participant.avatarKey || participant.agentId || participant.humanId || participant.id || participant.name}
      imageUrl={participant.profileImageUrl}
      name={participant.name}
      className="h-6 w-6 border border-white/10"
    />
  );
}

export function TaskActivityList({
  activities,
  emptyMessage,
}: {
  activities: SessionTaskActivity[];
  emptyMessage: string;
}) {
  if (activities.length === 0) {
    return <div className="app-inspector-empty">{emptyMessage}</div>;
  }

  return (
    <div className="space-y-3">
      {activities.map((activity) => {
        const visibleParticipants = activity.participants.slice(0, 4);
        const extraCount = Math.max(0, activity.participants.length - visibleParticipants.length);
        const targetName = participantLabel(activity.target, 'Agent');
        const initiatorName = participantLabel(activity.initiator, 'Participant');
        return (
          <div key={activity.id} className="app-inspector-emphasis">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 app-inspector-heading">
                  <Bot className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                  <span className="truncate">{targetName}</span>
                </div>
                <div className="mt-1 app-inspector-subtext">Delegated by {initiatorName}</div>
              </div>
              <Badge variant="secondary" className={cn('rounded-full px-2.5 py-1', taskStatusClass(activity.status))}>
                {taskStatusLabel(activity.status)}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Users className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <div className="flex -space-x-1.5">
                  {visibleParticipants.map(participantAvatar)}
                </div>
                {extraCount > 0 ? <span className="text-[11px] text-slate-500">+{extraCount}</span> : null}
              </div>
              <div className="truncate text-[11px] text-slate-500">
                {activity.participants.map((participant) => participant.name).join(' • ')}
              </div>
            </div>
            {activity.error ? <div className="mt-2 text-[12px] text-amber-200">{activity.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update ChatDetailPanel types and imports**

In `app/desktop/src/pages/ChatDetailPanel.tsx`, import:

```ts
import { TaskActivityList } from '@/pages/TaskActivityList';
```

Update existing type import to include `SessionTaskActivity`:

```ts
import type { DesktopBridgeIdentitySnapshot, DesktopBridgeOutreachMetadata, DetailTab, OutreachThreadSummary, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
```

Add to `ActiveConversation`:

```ts
  taskActivities?: SessionTaskActivity[];
```

- [ ] **Step 3: Replace ChatDetailPanel hardcoded task UI**

Replace the final return block in `ChatDetailPanelView` with:

```tsx
  return (
    <div className="app-detail-sheet">
      <section className="app-detail-section">
        <div className="app-detail-kicker">Tasks</div>
        <TaskActivityList
          activities={activeConv.taskActivities ?? []}
          emptyMessage="No delegated tasks in this session yet."
        />
      </section>
    </div>
  );
```

- [ ] **Step 4: Update ProjectDetailPanel types and imports**

In `app/desktop/src/pages/ProjectDetailPanel.tsx`, import:

```ts
import { TaskActivityList } from '@/pages/TaskActivityList';
```

Update type import to include `SessionTaskActivity`:

```ts
import type { DesktopBridgeHost, DesktopBridgeInvite, DesktopBridgeProject, DetailTab, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
```

Add to local `ProjectSession` type:

```ts
  taskActivities?: SessionTaskActivity[];
```

- [ ] **Step 5: Replace ProjectDetailPanel task UI**

Replace final return block in `ProjectDetailPanel` with:

```tsx
  return (
    <div className="app-detail-sheet">
      <section className="app-detail-section">
        <div className="app-detail-kicker">Tasks</div>
        <div className="space-y-3">
          <EmphasisBlock title="Project task summary">
            <div className="mb-2 flex items-center gap-2">
              <Badge className="app-badge-neutral px-2.5 py-1">{activeProject.tasks}</Badge>
              <span>delegated task{activeProject.tasks === 1 ? '' : 's'} across project sessions</span>
            </div>
            Active session: {activeProjectSession.tasks} delegated task{activeProjectSession.tasks === 1 ? '' : 's'}.
          </EmphasisBlock>
          <TaskActivityList
            activities={activeProjectSession.taskActivities ?? []}
            emptyMessage="No delegated tasks in this project session yet."
          />
          {activeProject.pendingInvites.length > 0 ? (
            <EmphasisBlock title="Pending invites">
              <div className="mb-2">
                <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">
                  {activeProject.pendingInvites.length}
                </Badge>
              </div>
              Membership approvals still waiting at the project level.
            </EmphasisBlock>
          ) : null}
        </div>
      </section>
    </div>
  );
```

- [ ] **Step 6: Add ChatDetailPanel tests**

Append to `app/desktop/tests/chatDetailPanel.test.tsx`:

```ts
test('chat detail task panel renders delegated task participants', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:weekend-plan',
      canonicalSessionId: 'session:group:weekend-plan',
      name: 'Weekend plan',
      type: 'person',
      subtitle: 'session:group:weekend-plan',
      unread: 0,
      bridges: ['Bridge'],
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me', 'Alice', 'Remote Kordi'],
      messages: [],
      taskActivities: [{
        id: 'delegation:1',
        sessionId: 'session:group:weekend-plan',
        status: 'processing',
        initiator: { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
        target: { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        participants: [
          { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
          { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'alice' },
          { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        bridgeConversationId: 'bridge:host:remote-agent',
        bridgeRequestId: 'bridge_req_task',
        contextPolicy: 'session-message',
      }],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationIsBridge: false,
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

  assert.match(markup, /Remote Kordi/);
  assert.match(markup, /Delegated by Me/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Running/);
  assert.doesNotMatch(markup, /Research Agent relay/);
});

test('chat detail task panel renders empty task state', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:empty',
      canonicalSessionId: 'session:group:empty',
      name: 'Empty group',
      type: 'person',
      subtitle: '',
      unread: 0,
      bridges: ['Bridge'],
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationIsBridge: false,
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

  assert.match(markup, /No delegated tasks in this session yet/);
});
```

- [ ] **Step 7: Add ProjectDetailPanel test**

Create `app/desktop/tests/projectTaskActivityPanel.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectDetailPanel } from '../src/pages/ProjectDetailPanel';

test('project detail task panel renders active session task activity with participants', () => {
  const activeProjectSession = {
    id: 'session:project:one',
    name: 'Project session',
    summary: 'Latest work',
    lastActive: '10:00',
    status: 'Active',
    participants: ['Me', 'Remote Kordi'],
    artifacts: 0,
    tasks: 1,
    messages: [],
    taskActivities: [{
      id: 'delegation:project:1',
      sessionId: 'session:project:one',
      status: 'complete',
      initiator: { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
      target: { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
      participants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
        { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
      bridgeConversationId: 'bridge:host:remote-agent',
      bridgeRequestId: 'bridge_req_project_task',
      contextPolicy: 'session-message',
    }],
  };

  const markup = renderToStaticMarkup(createElement(ProjectDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeProject: {
      id: 'project:root',
      name: 'Project',
      summary: 'Summary',
      bridge: 'Local',
      scope: '/tmp/project',
      status: 'Local',
      people: ['Me'],
      agents: ['Kordi'],
      pendingInvites: [],
      artifacts: 0,
      tasks: 1,
      root: '/tmp/project',
      sessions: [activeProjectSession],
    },
    activeProjectSession,
    activeProjectLastMessage: undefined,
    activeProjectBridgeHost: null,
    activeProjectBridgeProject: null,
    isProjectBridgeBusy: false,
    bridgeInvite: null,
    onCreateProjectBridgeInvite: () => {},
    onOpenBridgeHosts: () => {},
    onSetTasksTab: () => {},
    getStatusBadgeClass: () => 'app-badge-neutral',
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /Project task summary/);
  assert.match(markup, /Remote Kordi/);
  assert.match(markup, /Complete/);
  assert.match(markup, /Me/);
});
```

- [ ] **Step 8: Run UI tests and typecheck**

Run:

```bash
pnpm --dir app/desktop test:unit -- chatDetailPanel.test.tsx projectTaskActivityPanel.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: pass.

- [ ] **Step 9: Commit UI changes**

```bash
git add app/desktop/src/pages/TaskActivityList.tsx \
  app/desktop/src/pages/ChatDetailPanel.tsx \
  app/desktop/src/pages/ProjectDetailPanel.tsx \
  app/desktop/tests/chatDetailPanel.test.tsx \
  app/desktop/tests/projectTaskActivityPanel.test.tsx
git commit -m "feat: show task activity participants"
```

---

### Task 7: Full verification

**Files:**
- No code changes unless verification reveals a defect.

- [ ] **Step 1: Run backend task-related tests**

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_requests -- --nocapture
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_agent_responses -- --nocapture
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::group_message_sync -- --nocapture
cargo test -p kordi-desktop --no-default-features canonical_sessions::tests::direct_message_sync -- --nocapture
```

Expected: all pass.

- [ ] **Step 2: Run frontend tests**

```bash
pnpm --dir app/desktop test:unit
```

Expected: all tests pass.

- [ ] **Step 3: Run frontend typecheck and lint**

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: both pass.

- [ ] **Step 4: Run Rust desktop check**

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo check -p kordi-desktop --no-default-features
```

Expected: pass.

- [ ] **Step 5: Final commit if fixes were needed**

If verification required any fixes:

```bash
git add app/desktop/src-tauri/src/canonical_sessions app/desktop/src app/desktop/tests
git commit -m "fix: stabilize group task activity verification"
```

Expected: either no changes to commit or a small verification-fix commit.

---

## Self-Review

- Spec coverage: Backend sync, dedupe, participants, frontend read model, and task panels are covered.
- Completion-detail scan: Every task includes file paths, commands, and expected results.
- Type consistency: `SessionTaskActivity` flows from `types.ts` → canonical indexes → session read model → workspace view models → panels.
- Scope check: Human fanout remains delivery-only; agent delegation is the only task source.
