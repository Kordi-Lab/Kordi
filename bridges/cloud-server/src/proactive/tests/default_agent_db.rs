//! The owner's default agent (`cloud-agent:<account_id>`), which has no
//! definition row: its setting, sweep, card, and approved run.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::decision_db::say_in_group;
use super::fixture::*;
use super::offer_db::{card, offer};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};

fn setting_uri(agent_id: &str) -> String {
    format!("/v1/cloud/agents/{agent_id}/proactive")
}

/// The fixture with Scout off and the owner's default agent as `agent_id`,
/// its setting `enabled` through the route.
async fn default_fixture(enabled: bool) -> Option<Fixture> {
    let mut f = fixture().await?;
    query("UPDATE cloud_agent_definitions SET proactive_json = '{\"enabled\":false}' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    f.agent_id = format!("cloud-agent:{}", f.owner);
    let (status, body) = f
        .send(
            "PUT",
            &setting_uri(&f.agent_id),
            &f.owner_token,
            Some(json!({"enabled": enabled})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, json!({"enabled": enabled}));
    Some(f)
}

async fn run_row(f: &Fixture, run_id: &str) -> (String, String, String, String, String, String) {
    query_as(
        "SELECT execution_agent_id, owner_account_id, requester_account_id, run_trigger, \
                system_prompt, prompt FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn the_sweep_watches_the_default_agent_only_while_it_is_on() {
    let Some(f) = default_fixture(false).await else {
        return;
    };
    f.seed().await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "The deploy keeps failing, can anyone help?",
        5,
    )
    .await;
    assert!(f.candidate(&config()).await.is_none(), "off by default");

    let (status, _) = f
        .send(
            "PUT",
            &setting_uri(&f.agent_id),
            &f.owner_token,
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!(status, 200);
    let run_id = f.queue_evaluation().await;
    let (agent, owner, requester, trigger, system_prompt, prompt) = run_row(&f, &run_id).await;
    assert_eq!(agent, f.agent_id, "the synthetic id");
    assert_eq!(
        (owner.as_str(), requester.as_str()),
        (f.owner.as_str(), f.owner.as_str())
    );
    assert_eq!(trigger, "background");
    assert!(
        system_prompt.starts_with("You are Mina's Kordi, Mina's agent."),
        "{system_prompt}"
    );
    assert!(system_prompt.contains("Silence is the default."));
    let snapshot: Value = serde_json::from_str(&prompt).unwrap();
    assert_eq!(
        snapshot["agent"],
        json!({"agentId": f.agent_id, "name": "Mina's Kordi", "skills": []})
    );

    // The daily cap counts the synthetic id's evaluations.
    f.finish(&run_id, "{\"decision\": \"silence\"}").await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "Still broken, can anyone help?",
        5,
    )
    .await;
    let capped = crate::proactive::ProactiveConfig {
        daily_cap: 1,
        ..config()
    };
    assert!(f.candidate(&capped).await.is_none(), "capped");
    assert!(f.candidate(&config()).await.is_some());
}

#[tokio::test]
async fn an_offer_lands_in_the_owners_chat_with_their_kordi() {
    let Some(f) = default_fixture(true).await else {
        return;
    };
    // The owner already asked their Kordi something in this chat.
    let session = format!("session:self-agent:{}", Uuid::new_v4());
    let request = CreateConversationRequest {
        client_operation_id: Uuid::new_v4(),
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id: session.clone(),
        member_account_ids: vec![f.owner.clone()],
    };
    crate::chat_sync::store::create_conversation(&f.pool, &f.owner, request)
        .await
        .unwrap();
    let asked = format!("car_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, system_prompt, \
         runtime_route_json, created_at, updated_at, execution_backend, execution_agent_id, \
         run_trigger, connector_audience) \
         VALUES ($1, $1, $1, $2, $3, $3, 'completed', 'hi', '', '{}', $4, $4, 'cloud', $5, \
                 'person_started', 'shared')",
    )
    .bind(&asked)
    .bind(&session)
    .bind(&f.owner)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&f.agent_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let (proposal_id, _) = offer(&f).await;
    let (kind, card_session, _, content) = card(&f, &proposal_id).await;
    assert_eq!(
        (kind.as_str(), card_session.as_str()),
        ("ai", session.as_str())
    );
    assert_eq!(content["blocks"][1]["agentId"], f.agent_id);
    assert_eq!(content["blocks"][1]["agentName"], "Mina's Kordi");
    assert!(f.state().await.2, "the cooldown follows the synthetic id");
}

#[tokio::test]
async fn without_a_chat_the_card_opens_a_normal_agent_chat() {
    let Some(f) = default_fixture(true).await else {
        return;
    };
    let (proposal_id, _) = offer(&f).await;
    let (kind, session, _, _) = card(&f, &proposal_id).await;
    assert_eq!(kind, "ai");
    let id = session
        .strip_prefix("session:self-agent:")
        .expect("a self-agent chat");
    assert!(
        Uuid::parse_str(id).is_ok(),
        "the desktop's own id shape: {session}"
    );
}

#[tokio::test]
async fn allow_answers_in_the_group_as_the_owners_kordi() {
    let Some(f) = default_fixture(true).await else {
        return;
    };
    f.seed().await;
    let trigger = say_in_group(&f, "The pager is broken, can anyone help?").await;
    let candidate = f.candidate(&config()).await.expect("a candidate");
    crate::proactive::sweep::evaluate(&f.pool, &candidate)
        .await
        .unwrap();
    let run_id = f.state().await.1.expect("an evaluation");
    f.finish(&run_id, &offer_reply(&trigger)).await;
    let (proposal_id,): (String,) = query_as(
        "SELECT proposal_id FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let uri = format!(
        "{}/proposals/{proposal_id}/decision",
        setting_uri(&f.agent_id)
    );
    let allow = Some(json!({"decision": "allow"}));
    let (status, _) = f.send("POST", &uri, &f.member_token, allow.clone()).await;
    assert_eq!(status, 403, "only the owner decides");
    let (status, body) = f.send("POST", &uri, &f.owner_token, allow).await;
    assert_eq!(status, 200, "{body}");
    let approved = format!("proactive_run_{proposal_id}");
    let (agent, owner, requester, trigger_kind, system_prompt, _) = run_row(&f, &approved).await;
    assert_eq!(agent, f.agent_id);
    assert_eq!(
        (owner.as_str(), requester.as_str()),
        (f.owner.as_str(), f.owner.as_str())
    );
    assert_eq!(trigger_kind, "person_started");
    assert!(system_prompt.contains(&format!("Current shared session: {}.", f.session_id)));
    assert!(
        !system_prompt.contains("Cloud Agent"),
        "the default Kordi prompt"
    );

    f.finish(&approved, "Riya, the pager needs its token renewed.")
        .await;
    let (reply,): (Value,) = query_as(
        "SELECT m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1",
    )
    .bind(&approved)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let text = reply["blocks"][0]["text"].as_str().unwrap();
    let encoded = text
        .strip_prefix("kordi-cloud-group:")
        .expect("a group reply");
    let envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], f.agent_id);
    assert_eq!(message["senderOwnerAccountId"], f.owner);
    assert_eq!(message["senderOwnerName"], "Mina");
    // Group storage names every default agent reply by its profile, as it
    // does for a mention of the owner's Kordi.
    let (profile_name,): (String,) = query_as(
        "SELECT display_name FROM cloud_default_agent_profiles WHERE owner_account_id = $1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(message["senderDisplayName"], profile_name);
    assert_eq!(message["replyToMessageId"], trigger);
}

#[tokio::test]
async fn the_setting_routes_cover_both_kinds_for_the_owner_only() {
    let Some(f) = fixture().await else { return };
    let default_id = format!("cloud-agent:{}", f.owner);
    let (status, body) = f
        .send("GET", &setting_uri(&default_id), &f.owner_token, None)
        .await;
    assert_eq!(
        (status.as_u16(), body),
        (200, json!({"enabled": false})),
        "no row is off"
    );
    let (status, body) = f
        .send(
            "PUT",
            &setting_uri(&default_id),
            &f.owner_token,
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": true})));
    let (status, body) = f
        .send("GET", &setting_uri(&default_id), &f.owner_token, None)
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": true})));
    let (status, _) = f
        .send(
            "PUT",
            &setting_uri(&default_id),
            &f.owner_token,
            Some(json!({"enabled": "yes"})),
        )
        .await;
    assert_eq!(status, 400);

    let definition = setting_uri(&f.agent_id);
    let (status, body) = f.send("GET", &definition, &f.owner_token, None).await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": true})));
    let (status, body) = f
        .send(
            "PUT",
            &definition,
            &f.owner_token,
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": false})));
    let (_, list) = f
        .send("GET", "/v1/cloud/agents", &f.owner_token, None)
        .await;
    let listed = list["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == f.agent_id)
        .unwrap();
    assert_eq!(
        listed["proactive"],
        json!({"enabled": false}),
        "the definition API agrees"
    );

    for uri in [setting_uri(&default_id), definition.clone()] {
        let (status, _) = f.send("GET", &uri, &f.member_token, None).await;
        assert_eq!(status, 403, "{uri}");
        let (status, _) = f
            .send("PUT", &uri, &f.member_token, Some(json!({"enabled": true})))
            .await;
        assert_eq!(status, 403, "{uri}");
    }
    let (status, body) = f
        .send("GET", &setting_uri(&default_id), &f.owner_token, None)
        .await;
    assert_eq!(
        body,
        json!({"enabled": true}),
        "{status}: a stranger changed nothing"
    );
    let missing = setting_uri("cloud_agent_missing");
    let (status, _) = f.send("GET", &missing, &f.owner_token, None).await;
    assert_eq!(status, 404);
    let (status, _) = f
        .send(
            "PUT",
            &missing,
            &f.owner_token,
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn turning_the_default_agent_off_stops_everything() {
    let Some(f) = default_fixture(true).await else {
        return;
    };
    let (proposal_id, _) = offer(&f).await;
    // A second group with a queued evaluation.
    let other = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id) VALUES ($1, 'group', 'Ops', $2, $3, 'fixture', $4)")
        .bind(other)
        .bind(&f.owner)
        .bind(Uuid::new_v4())
        .bind(format!("session:group:{}", Uuid::new_v4().simple()))
        .execute(&f.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2), ($1, $3)")
        .bind(other)
        .bind(&f.owner)
        .bind(&f.member)
        .execute(&f.pool)
        .await
        .unwrap();
    f.seed().await;
    say(
        &f.pool,
        &f.member,
        other,
        "The pager is broken, can anyone help?",
        5,
    )
    .await;
    query("UPDATE cloud_agent_proactive_state SET checked_at = now() - interval '1 hour' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let candidate = crate::proactive::sweep::select(&f.pool, &config(), 10_000)
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.agent_id == f.agent_id && c.conversation_id == other)
        .expect("the second group");
    crate::proactive::sweep::evaluate(&f.pool, &candidate)
        .await
        .unwrap();
    let (queued,): (String,) = query_as(
        "SELECT active_run_id FROM cloud_agent_proactive_state WHERE agent_id = $1 AND conversation_id = $2",
    )
    .bind(&f.agent_id)
    .bind(other)
    .fetch_one(&f.pool)
    .await
    .unwrap();

    let (status, body) = f
        .send(
            "PUT",
            &setting_uri(&f.agent_id),
            &f.owner_token,
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": false})));
    let (run_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&queued)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(run_status, "cancelled");
    let (proposal_status,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&proposal_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(proposal_status, "expired");
    let (_, _, _, content) = card(&f, &proposal_id).await;
    assert_eq!(content["blocks"][1]["status"], "expired");
    f.seed().await;
    let (rows,): (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_proactive_state WHERE agent_id = $1")
            .bind(&f.agent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0, "the sweep stops watching");
}
