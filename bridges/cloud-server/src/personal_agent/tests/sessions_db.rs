//! Personal sessions: created once per agent, marked in conversation
//! snapshots, locked against hide and delete, the default target of their
//! requests, and released when a definition is archived.

use serde_json::json;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::chat_sync::store::{self, StoreError};

#[tokio::test]
async fn listing_creates_each_session_once_even_when_calls_race() {
    let Some(f) = fixture().await else { return };
    let call = || f.send("GET", "/v1/cloud/personal-agents", &f.owner_token, None);
    let (a, b, c) = tokio::join!(call(), call(), call());
    for (status, body) in [&a, &b, &c] {
        assert_eq!(status.as_u16(), 200, "{body}");
    }
    assert_eq!(a.1, b.1);
    assert_eq!(a.1, c.1);
    let agents = a.1["agents"].as_array().unwrap();
    let default_agent = format!("cloud-agent:{}", f.owner);
    assert_eq!(agents.len(), 2);
    assert_eq!(
        agents[0]["agentId"],
        default_agent.as_str(),
        "default first"
    );
    assert_eq!(agents[1]["agentId"], f.agent_id.as_str());
    assert_eq!(
        agents[0]["sessionId"],
        format!("session:self-agent:{}:personal:{default_agent}", f.owner).as_str()
    );
    assert_eq!(agents[1]["proactive"], false);
    let (conversations, created): (i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_chat_conversations \
                 WHERE created_by_account_id = $1 AND kind = 'ai' \
                   AND legacy_session_id LIKE 'session:self-agent:%:personal:%'), \
                (SELECT count(*) FROM cloud_chat_user_sync_events \
                 WHERE account_id = $1 AND event_type = 'conversation.created')",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        (conversations, created),
        (2, 2),
        "one conversation and event each"
    );
    let (payload,): (serde_json::Value,) = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'conversation.created' \
           AND payload #>> '{conversation,personal_agent,agent_id}' = $2",
    )
    .bind(&f.owner)
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(payload["conversation"]["kind"], "ai");

    f.set_proactive(&f.agent_id, true).await;
    let (_, again) = call().await;
    assert_eq!(again["agents"][1]["proactive"], true);
    assert_eq!(
        again["agents"][1]["conversationId"],
        agents[1]["conversationId"]
    );
}

#[tokio::test]
async fn snapshots_name_the_agent_and_clients_cannot_forge_a_session() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, _) = f.personal_session(&f.agent_id).await;
    let bootstrap = store::bootstrap(&f.pool, &f.owner).await.unwrap();
    let personal = bootstrap
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .expect("in the bootstrap");
    let value = serde_json::to_value(personal).unwrap();
    assert_eq!(value["personal_agent"], json!({"agent_id": f.agent_id}));
    let forged = store::create_conversation(
        &f.pool,
        &f.owner,
        CreateConversationRequest {
            client_operation_id: Uuid::new_v4(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: format!("session:self-agent:{}:personal:cloud_agent_new", f.owner),
            member_account_ids: vec![f.owner.clone()],
        },
    )
    .await;
    assert!(matches!(forged, Err(StoreError::InvalidInput(_))));
    let ordinary = store::create_conversation(
        &f.pool,
        &f.owner,
        CreateConversationRequest {
            client_operation_id: Uuid::new_v4(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: format!("session:self-agent:{}", Uuid::new_v4().simple()),
            member_account_ids: vec![f.owner.clone()],
        },
    )
    .await
    .unwrap();
    let value = serde_json::to_value(&ordinary.value).unwrap();
    assert!(value.get("personal_agent").is_none(), "absent elsewhere");
}

#[tokio::test]
async fn personal_sessions_cannot_be_hidden_or_deleted() {
    let Some(f) = fixture().await else { return };
    let (_, session_id) = f.personal_session(&f.agent_id).await;
    let base = format!("/v1/cloud/sessions/{}", urlencode(&session_id));
    let (status, body) = f
        .send("PUT", &format!("{base}/hidden"), &f.owner_token, None)
        .await;
    assert_eq!(status, 409);
    assert_eq!(body["errorCode"], "personal_session_locked");
    let (status, body) = f.send("DELETE", &base, &f.owner_token, None).await;
    assert_eq!(status, 409);
    assert_eq!(body["errorCode"], "personal_session_locked");
    let (status, body) = f
        .send("PUT", &format!("{base}/pinned"), &f.owner_token, None)
        .await;
    assert!(status.is_success(), "pin works: {status} {body}");
    let (status, _) = f
        .send("PUT", &format!("{base}/muted"), &f.owner_token, None)
        .await;
    assert!(status.is_success(), "mute works");
}

fn urlencode(value: &str) -> String {
    value.replace(':', "%3A")
}

fn claim(
    session_id: &str,
    owner: &str,
    message_id: &str,
) -> crate::cloud_agent_runtime::runs::ClaimRunRequest {
    serde_json::from_value(json!({
        "requestMessageId": message_id,
        "sessionId": session_id,
        "ownerAccountId": owner,
        "requesterAccountId": owner,
        "prompt": "hello",
        "idempotencyKey": message_id,
    }))
    .unwrap()
}

#[tokio::test]
async fn requests_without_a_target_go_to_the_session_agent() {
    let Some(f) = fixture().await else { return };
    let (conversation_id, session_id) = f.personal_session(&f.agent_id).await;
    let message = store::send_message(
        &f.pool,
        &f.owner,
        conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".into(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": "What is new?"}]}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    let input = claim(&session_id, &f.owner, &message.id.to_string());
    let agent = crate::cloud_agent_runtime::runs::execution_agent_id(&f.pool, &input)
        .await
        .unwrap();
    assert_eq!(agent, f.agent_id);
    let default_agent = format!("cloud-agent:{}", f.owner);
    let (_, default_session) = f.personal_session(&default_agent).await;
    let input = claim(&default_session, &f.owner, "msg_none");
    let agent = crate::cloud_agent_runtime::runs::execution_agent_id(&f.pool, &input)
        .await
        .unwrap();
    assert_eq!(agent, default_agent, "the default agent's own session");
    let other = claim(
        &format!("session:self-agent:{}", Uuid::new_v4()),
        &f.owner,
        "m",
    );
    let agent = crate::cloud_agent_runtime::runs::execution_agent_id(&f.pool, &other)
        .await
        .unwrap();
    assert_eq!(agent, default_agent, "an ordinary chat is unchanged");
}

#[tokio::test]
async fn archiving_a_definition_releases_its_session() {
    let Some(f) = fixture().await else { return };
    let (run_id, _) = f.queue_evaluation().await;
    let (conversation_id, session_id) = f.personal_session(&f.agent_id).await;
    let (status, _) = f
        .send(
            "DELETE",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let rows: (i64, i64, i64, String, bool) = query_as(
        "SELECT (SELECT count(*) FROM cloud_personal_agent_sessions WHERE agent_id = $1), \
                (SELECT count(*) FROM cloud_personal_agent_settings WHERE agent_id = $1), \
                (SELECT count(*) FROM cloud_personal_agent_state WHERE agent_id = $1), \
                (SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $2), \
                EXISTS(SELECT 1 FROM cloud_chat_conversations WHERE conversation_id = $3)",
    )
    .bind(&f.agent_id)
    .bind(&run_id)
    .bind(conversation_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(rows, (0, 0, 0, "cancelled".to_string(), true));
    let (_, list) = f
        .send("GET", "/v1/cloud/personal-agents", &f.owner_token, None)
        .await;
    assert_eq!(
        list["agents"].as_array().unwrap().len(),
        1,
        "only the default"
    );
    let uri = format!("/v1/cloud/sessions/{}/hidden", urlencode(&session_id));
    let (status, _) = f.send("PUT", &uri, &f.owner_token, None).await;
    assert!(status.is_success(), "an ordinary chat again");
}
