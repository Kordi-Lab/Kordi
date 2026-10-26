//! Which agents are personal agents: the default agent is on until turned
//! off, a definition is off until turned on, and turning one on makes its
//! session ready at once (new, reused, unhidden, or replaced after a delete).

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;

fn setting_uri(agent_id: &str) -> String {
    format!("/v1/cloud/agents/{agent_id}/personal-agent")
}

fn session_uri(session_id: &str) -> String {
    format!("/v1/cloud/sessions/{}", session_id.replace(':', "%3A"))
}

async fn binding(f: &Fixture, agent_id: &str) -> Option<(Uuid, String)> {
    query_as(
        "SELECT binding.conversation_id, conversation.legacy_session_id \
         FROM cloud_personal_agent_sessions binding \
         JOIN cloud_chat_conversations conversation USING (conversation_id) \
         WHERE binding.agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(&f.pool)
    .await
    .unwrap()
}

async fn listed(f: &Fixture) -> Vec<String> {
    let (_, body) = f
        .send("GET", "/v1/cloud/personal-agents", &f.owner_token, None)
        .await;
    body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["agentId"].as_str().unwrap().to_string())
        .collect()
}

async fn events(f: &Fixture, event_type: &str) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = $2 ORDER BY stream_seq",
    )
    .bind(&f.owner)
    .bind(event_type)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter().map(|(payload,)| payload).collect()
}

#[tokio::test]
async fn the_default_agent_is_on_until_turned_off_and_definitions_are_off() {
    let Some(f) = fixture().await else { return };
    let default_agent = format!("cloud-agent:{}", f.owner);
    let (_, body) = f
        .send("GET", &setting_uri(&default_agent), &f.owner_token, None)
        .await;
    assert_eq!(body, json!({"proactive": true}), "no row is on");
    let (_, body) = f
        .send("GET", &setting_uri(&f.agent_id), &f.owner_token, None)
        .await;
    assert_eq!(body, json!({"proactive": false}), "a definition starts off");
    assert_eq!(listed(&f).await, vec![default_agent.clone()]);

    // The sweep watches the default agent with no row once it has a granted
    // connector, and stops once it is turned off.
    let mail = connector(&f.pool, &f.owner, "google_calendar").await;
    grant(&f.pool, &mail, &default_agent).await;
    crate::personal_agent::sweep::seed(&f.pool).await.unwrap();
    sqlx_core::query::query(
        "UPDATE cloud_personal_agent_state SET cursor_received_at = now() - interval '1 hour', \
         enabled_at = now() - interval '1 hour' WHERE agent_id = $1",
    )
    .bind(&default_agent)
    .execute(&f.pool)
    .await
    .unwrap();
    event_on(
        &f.pool,
        &mail,
        "event.updated",
        json!({"summary": "Lab sync"}),
        120,
    )
    .await;
    assert!(picked(&f, &default_agent).await, "on with no row");
    let (status, body) = f.set_proactive(&default_agent, false).await;
    assert_eq!((status.as_u16(), body), (200, json!({"proactive": false})));
    let (stored,): (bool,) =
        query_as("SELECT proactive FROM cloud_personal_agent_settings WHERE agent_id = $1")
            .bind(&default_agent)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!stored, "off is an explicit row");
    assert!(!picked(&f, &default_agent).await, "the sweep ignores it");
    assert!(listed(&f).await.is_empty());
    let (_, body) = f
        .send("GET", &setting_uri(&default_agent), &f.owner_token, None)
        .await;
    assert_eq!(body, json!({"proactive": false}), "off sticks");
}

#[tokio::test]
async fn turning_on_makes_the_session_ready_at_once() {
    let Some(f) = fixture().await else { return };
    assert!(binding(&f, &f.agent_id).await.is_none());
    f.set_proactive(&f.agent_id, true).await;
    let (first, session_id) = binding(&f, &f.agent_id).await.expect("created at once");
    store_message(&f, first, "Hello Scout").await;

    // Off and on again reuses it, with its history.
    f.set_proactive(&f.agent_id, false).await;
    f.set_proactive(&f.agent_id, true).await;
    assert_eq!(binding(&f, &f.agent_id).await.unwrap().0, first);
    assert_eq!(f.messages(first).await.len(), 1);

    // Hidden while off: shown again.
    f.set_proactive(&f.agent_id, false).await;
    let (status, _) = f
        .send(
            "PUT",
            &format!("{}/hidden", session_uri(&session_id)),
            &f.owner_token,
            None,
        )
        .await;
    assert!(status.is_success());
    f.set_proactive(&f.agent_id, true).await;
    assert_eq!(binding(&f, &f.agent_id).await.unwrap().0, first);
    let (hidden,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&f.owner)
    .bind(&session_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(hidden, 0, "unhidden");
    let unhidden = events(&f, "session.unhidden").await;
    assert_eq!(unhidden.last().unwrap()["sessionId"], session_id.as_str());

    // Deleted while off: a new conversation takes its place.
    f.set_proactive(&f.agent_id, false).await;
    let (status, _) = f
        .send("DELETE", &session_uri(&session_id), &f.owner_token, None)
        .await;
    assert!(status.is_success());
    f.set_proactive(&f.agent_id, true).await;
    let (replacement, replacement_session) = binding(&f, &f.agent_id).await.unwrap();
    assert_ne!(replacement, first);
    assert!(replacement_session.starts_with(&session_id));
    let created = events(&f, "conversation.created").await;
    let last = &created.last().unwrap()["conversation"];
    assert_eq!(last["id"], replacement.to_string());
    assert_eq!(last["personal_agent"], json!({"agent_id": f.agent_id}));
    assert_eq!(f.messages(first).await.len(), 1, "the old chat stays");
    let mut agents = listed(&f).await;
    agents.sort();
    let mut expected = vec![format!("cloud-agent:{}", f.owner), f.agent_id.clone()];
    expected.sort();
    assert_eq!(agents, expected);
}

#[tokio::test]
async fn a_definition_created_on_has_its_session_at_once() {
    let Some(f) = fixture().await else { return };
    let (status, body) = f
        .send(
            "POST",
            "/v1/cloud/agents",
            &f.owner_token,
            Some(json!({
                "name": "Herald", "role": "Helper", "systemPrompt": "Tell me.",
                "personalAgent": {"proactive": true},
            })),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let agent_id = body["agent"]["agentId"].as_str().unwrap().to_string();
    assert!(binding(&f, &agent_id).await.is_some());
    let (status, body) = f
        .send(
            "PUT",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            Some(json!({"personalAgent": {"proactive": true}})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(binding(&f, &f.agent_id).await.is_some(), "and on update");
}

/// Whether the next sweep would pick `agent_id`.
async fn picked(f: &Fixture, agent_id: &str) -> bool {
    for _ in 0..5 {
        let found = crate::personal_agent::sweep::select(&f.pool, &quick(), 10_000)
            .await
            .unwrap()
            .into_iter()
            .any(|candidate| candidate.agent_id == agent_id);
        if found {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
    false
}

async fn store_message(f: &Fixture, conversation_id: Uuid, text: &str) {
    crate::chat_sync::store::send_message(
        &f.pool,
        &f.owner,
        conversation_id,
        crate::chat_sync::models::SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".into(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}]}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap();
}
