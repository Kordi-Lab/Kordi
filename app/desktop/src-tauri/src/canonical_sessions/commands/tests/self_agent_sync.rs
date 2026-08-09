use super::super::self_agent_sync::apply_canonical_self_agent_sync_plan_in_db;
use super::*;
use crate::canonical_sessions::{
    AppendCanonicalMessageRequest, ApplyCanonicalSelfAgentSyncPlanRequest,
    OpenCanonicalSessionRequest, UpsertCanonicalIdentityRequest,
};

fn self_agent_sync_request() -> ApplyCanonicalSelfAgentSyncPlanRequest {
    ApplyCanonicalSelfAgentSyncPlanRequest {
        agent_identity_request: UpsertCanonicalIdentityRequest {
            id: Some("agent:cloud-self:me".to_string()),
            kind: "agent".to_string(),
            display_name: "My Kordi".to_string(),
            owner_identity_id: Some("human:me".to_string()),
            source: Some("local".to_string()),
            source_host_id: None,
            bridge_node_id: None,
            human_id: None,
            agent_id: Some("cloud-self:me".to_string()),
            avatar_key: Some("cloud-self:me".to_string()),
            profile_image_url: None,
            metadata: None,
        },
        session_requests: vec![OpenCanonicalSessionRequest {
            id: Some("session:self".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Self".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:me".to_string(),
            primary_identity_id: Some("agent:cloud-self:me".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:cloud-self:me".to_string()],
            metadata: None,
        }],
        message_requests: vec![
            AppendCanonicalMessageRequest {
                id: Some("message:one".to_string()),
                session_id: "session:self".to_string(),
                sender_identity_id: "human:me".to_string(),
                sender_role: "user".to_string(),
                message_kind: "text".to_string(),
                content_text: "hello".to_string(),
                content: None,
                created_at_ms: Some(10),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some("sent".to_string()),
                source_transport: Some("cloud-self-agent".to_string()),
                source_event_id: Some("cloud:one".to_string()),
            },
            AppendCanonicalMessageRequest {
                id: Some("message:response".to_string()),
                session_id: "session:self".to_string(),
                sender_identity_id: "agent:cloud-self:me".to_string(),
                sender_role: "owned-agent".to_string(),
                message_kind: "agent-turn".to_string(),
                content_text: "hi".to_string(),
                content: Some(serde_json::json!({
                    "deliveryState": "complete",
                    "requestId": "message:one",
                })),
                created_at_ms: Some(11),
                parent_message_id: Some("message:one".to_string()),
                delegated_exchange_id: None,
                status: Some("complete".to_string()),
                source_transport: Some("cloud-self-agent".to_string()),
                source_event_id: Some("cloud:response".to_string()),
            },
        ],
    }
}

#[test]
fn self_agent_sync_plan_is_applied_atomically_and_idempotently() {
    let mut conn = test_conn();
    seed_identity(&conn);

    let batch = apply_canonical_self_agent_sync_plan_in_db(&mut conn, self_agent_sync_request())
        .expect("apply self-agent sync batch");
    assert_eq!(batch.identity.id, "agent:cloud-self:me");
    assert_eq!(batch.sessions.len(), 1);
    assert_eq!(batch.messages.len(), 2);

    let replayed = apply_canonical_self_agent_sync_plan_in_db(&mut conn, self_agent_sync_request())
        .expect("reapply self-agent sync batch");
    assert_eq!(replayed.messages.len(), 2);
    let persisted_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_messages", [], |row| {
            row.get(0)
        })
        .expect("count persisted messages");
    assert_eq!(persisted_count, 2);
}
