//! Which agents are personal agents: none without a live connector granted
//! to it; with one, the default agent is on until turned off, a definition
//! is off until turned on, and turning one on makes its session ready at once
//! (new, reused, unhidden, or replaced after a delete). Losing the last
//! grant turns it off.

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
async fn the_default_agent_is_on_with_a_connector_until_turned_off_and_definitions_are_off() {
    let Some(f) = fixture().await else { return };
    let default_agent = format!("cloud-agent:{}", f.owner);
    let (_, body) = f
        .send("GET", &setting_uri(&default_agent), &f.owner_token, None)
        .await;
    assert_eq!(
        (body["proactive"].clone(), body["connected"].clone()),
        (json!(false), json!(false)),
        "nothing to watch: {body}"
    );
    assert!(
        listed(&f).await.is_empty(),
        "no session without a connector"
    );
    let (status, body) = f.set_proactive(&default_agent, true).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "personal_agent_needs_connector");
    let (_, body) = f
        .send("GET", &setting_uri(&f.agent_id), &f.owner_token, None)
        .await;
    assert_eq!(body["proactive"], false, "a definition starts off");
    assert_eq!(body["connected"], true);

    // The default agent with no row is on once it has a granted connector;
    // the sweep watches it, and stops once it is turned off.
    let mail = connector(&f.pool, &f.owner, "google_calendar").await;
    grant(&f.pool, &mail, &default_agent).await;
    let (_, body) = f
        .send("GET", &setting_uri(&default_agent), &f.owner_token, None)
        .await;
    assert_eq!(body["proactive"], true, "no row is on: {body}");
    assert_eq!(body["sources"][0]["provider"], "google_calendar");
    assert_eq!(listed(&f).await, vec![default_agent.clone()]);
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
    assert_eq!(
        (status.as_u16(), body["proactive"].clone()),
        (200, json!(false))
    );
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
    assert_eq!(body["proactive"], false, "off sticks");
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
    assert_eq!(
        agents,
        vec![f.agent_id.clone()],
        "the default agent has no connector"
    );
}

#[tokio::test]
async fn a_definition_needs_a_connector_before_it_is_turned_on() {
    let Some(f) = fixture().await else { return };
    let herald = json!({"name": "Herald", "role": "Helper", "systemPrompt": "Tell me."});
    let mut created_on = herald.clone();
    created_on["personalAgent"] = json!({"proactive": true});
    let (status, body) = f
        .send("POST", "/v1/cloud/agents", &f.owner_token, Some(created_on))
        .await;
    assert_eq!(status, 409, "a new agent has no connector: {body}");
    assert_eq!(body["errorCode"], "personal_agent_needs_connector");
    let (status, body) = f
        .send("POST", "/v1/cloud/agents", &f.owner_token, Some(herald))
        .await;
    assert_eq!(status, 201, "{body}");
    let agent_id = body["agent"]["agentId"].as_str().unwrap().to_string();
    assert!(binding(&f, &agent_id).await.is_none());
    let (status, body) = f
        .send(
            "PUT",
            &format!("/v1/cloud/agents/{agent_id}"),
            &f.owner_token,
            Some(json!({"personalAgent": {"proactive": true}})),
        )
        .await;
    assert_eq!(status, 409, "{body}");
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

#[tokio::test]
async fn losing_the_last_grant_turns_it_off() {
    let Some(f) = fixture().await else { return };
    f.set_proactive(&f.agent_id, true).await;
    let (conversation_id, _) = binding(&f, &f.agent_id).await.expect("on");
    // Another connector keeps it on while the first one is taken away.
    let calendar = connector(&f.pool, &f.owner, "google_calendar").await;
    grant(&f.pool, &calendar, &f.agent_id).await;
    crate::connectors::store::replace_agent_grants(&f.pool, &f.connector_id, &[])
        .await
        .unwrap();
    assert_eq!(listed(&f).await, vec![f.agent_id.clone()]);

    // Disconnecting the last one turns it off as an explicit row, and the
    // owner's devices drop the marker.
    let record = crate::connectors::store::load_account_connector(&f.pool, &f.owner, &calendar)
        .await
        .unwrap()
        .unwrap();
    crate::connectors::store::disconnect(&f.pool, &record)
        .await
        .unwrap();
    assert!(listed(&f).await.is_empty());
    let (stored,): (bool,) =
        query_as("SELECT proactive FROM cloud_personal_agent_settings WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!stored);
    let updated = events(&f, "conversation.updated").await;
    let last = updated
        .iter()
        .rev()
        .find(|payload| payload["conversation"]["id"] == conversation_id.to_string())
        .expect("the session was announced");
    assert!(
        last["conversation"].get("personal_agent").is_none(),
        "{last}"
    );

    // A new connector shows it off, ready to be turned on again.
    let github = connector(&f.pool, &f.owner, "github").await;
    grant(&f.pool, &github, &f.agent_id).await;
    let (_, body) = f
        .send("GET", &setting_uri(&f.agent_id), &f.owner_token, None)
        .await;
    assert_eq!(
        (body["proactive"].clone(), body["connected"].clone()),
        (json!(false), json!(true)),
        "{body}"
    );
}
