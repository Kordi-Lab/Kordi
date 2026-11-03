//! Exercise leased System runs with the context serializer used by real sweeps.

use std::sync::Arc;

use axum::response::Response;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::tests::{seed_account, seed_conversation};
use crate::events::EventBus;
use crate::server::ServerState;
use crate::system_agent::context::{budget_messages, ContextMessage};
use crate::system_agent::{bootstrap_system_agent, PendingSystemAgentConfig, SystemAgentService};

struct Fixture {
    pool: PgPool,
    state: Arc<ServerState>,
    run: String,
    chat: Uuid,
    owner: String,
    attendee: String,
    peer: String,
}

impl Fixture {
    async fn new() -> Self {
        let pool = sqlx_postgres::PgPoolOptions::new()
            .connect(&std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated database"))
            .await
            .unwrap();
        crate::pg::pool::apply_migrations(&pool).await.unwrap();
        let suffix = Uuid::new_v4().simple();
        let owner = format!("owner-{suffix}");
        let attendee = format!("attendee-{suffix}");
        let peer = format!("peer-{suffix}");
        for account in [&owner, &attendee, &peer] {
            seed_account(&pool, account).await;
        }
        let pending = PendingSystemAgentConfig::from_lookup(|key| match key {
            "KORDI_SYSTEM_AGENT_OPENAI_API_KEY" => Some("synthetic-test-key".to_string()),
            _ => None,
        })
        .unwrap()
        .unwrap();
        let config = bootstrap_system_agent(&pool, pending).await.unwrap();
        let chat = Uuid::new_v4();
        seed_conversation(
            &pool,
            chat,
            &owner,
            &[&owner, &attendee, &peer, &config.account_id],
        )
        .await;
        let session = format!("group:{chat}");
        query("UPDATE cloud_chat_conversations SET legacy_session_id=$2 WHERE conversation_id=$1")
            .bind(chat)
            .bind(&session)
            .execute(&pool)
            .await
            .unwrap();
        let run = format!("pip_{}", Uuid::new_v4().simple());
        let now = chrono::Utc::now();
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,claimed_by,lease_expires_at,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$3,'running','{}','test-runner',$4,$5,$5)")
            .bind(&run).bind(session).bind(&config.account_id)
            .bind((now + chrono::Duration::minutes(5)).to_rfc3339()).bind(now.to_rfc3339())
            .execute(&pool).await.unwrap();
        let state = Arc::new(
            ServerState::new(pool.clone(), EventBus::noop())
                .with_system_agent(SystemAgentService::new(config)),
        );
        Self {
            pool,
            state,
            run,
            chat,
            owner,
            attendee,
            peer,
        }
    }

    async fn messages(&self, speakers: &[(&str, &str)], seen_sequence: i64) {
        let messages = budget_messages(
            speakers
                .iter()
                .enumerate()
                .rev()
                .map(|(index, (sender, text))| ContextMessage {
                    id: Uuid::new_v4().to_string(),
                    sequence: index as i64 + 1,
                    sender_id: sender.to_string(),
                    sender_name: sender.to_string(),
                    kind: "text".to_string(),
                    text: text.to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                })
                .collect(),
            0,
            seen_sequence,
            &self.state.system_agent().unwrap().config().account_id,
        );
        query("UPDATE cloud_agent_fallback_runs SET prompt=$2 WHERE run_id=$1")
            .bind(&self.run)
            .bind(json!({"messages": messages}).to_string())
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn call(&self, request: Value) -> Response {
        super::runner_action(&self.state, &self.run, "test-runner", request).await
    }

    async fn ok(&self, request: Value) -> Value {
        let response = self.call(request).await;
        assert_eq!(response.status(), 200);
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    async fn propose(&self) -> Value {
        self.ok(json!({
            "action":"propose", "conversationId":self.chat, "title":"Lunch",
            "state":"polling", "unresolvedFields":[],
            "participants":[
                {"participantId":self.owner,"displayName":"Owner","organizer":true},
                {"participantId":self.attendee,"displayName":"Attendee"},
                {"participantId":self.peer,"displayName":"Peer"}
            ],
            "options":[
                {"id":"first","label":"First slot","startAt":(chrono::Utc::now()+chrono::Duration::days(2)).to_rfc3339()},
                {"id":"second","label":"Second slot","startAt":(chrono::Utc::now()+chrono::Duration::days(3)).to_rfc3339()}
            ]
        })).await
    }

    async fn calendar_members(&self, event_id: &str) -> Vec<String> {
        assert!(super::projection::drain(&self.pool, 100)
            .await
            .unwrap()
            .is_complete());
        let rows: Vec<(String,)> = query_as(
            "SELECT account_id FROM cloud_calendar_events WHERE event_id=$1 ORDER BY account_id",
        )
        .bind(format!("plan:{event_id}"))
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter().map(|row| row.0).collect()
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn leased_system_actions_confirm_decline_and_cancel_with_matching_calendars() {
    let f = Fixture::new().await;
    let card = f.propose().await;
    let event = card["eventId"].as_str().unwrap();
    f.messages(
        &[
            (&f.owner, "Confirm the first slot"),
            (&f.attendee, "First slot works"),
            (&f.peer, "I'm in"),
        ],
        0,
    )
    .await;
    for member in [&f.owner, &f.attendee, &f.peer] {
        f.ok(json!({"action":"vote","eventId":event,"participantId":member,"optionId":"first"}))
            .await;
        f.ok(json!({"action":"rsvp","eventId":event,"participantId":member,"rsvp":"yes"}))
            .await;
    }
    let current = super::store::load(&f.pool, event).await.unwrap().unwrap();
    let confirmed = f.ok(json!({"action":"confirm","eventId":event,"revision":current.revision,"confirmedBy":f.owner,"optionId":"first"})).await;
    assert_eq!(confirmed["state"], "confirmed");
    let mut all = vec![f.owner.clone(), f.attendee.clone(), f.peer.clone()];
    all.sort();
    assert_eq!(f.calendar_members(event).await, all);

    f.messages(&[(&f.attendee, "I can't make it")], 0).await;
    let declined = f
        .ok(json!({"action":"rsvp","eventId":event,"participantId":f.attendee,"rsvp":"no"}))
        .await;
    assert_eq!(declined["state"], "confirmed");
    let row = super::store::load(&f.pool, event).await.unwrap().unwrap();
    for participant in &row.participants {
        assert_eq!(
            participant.rsvp,
            if participant.account_id == f.attendee {
                super::models::PlanCardRsvp::No
            } else {
                super::models::PlanCardRsvp::Yes
            }
        );
    }
    all.retain(|member| member != &f.attendee);
    assert_eq!(f.calendar_members(event).await, all);

    f.messages(&[(&f.owner, "Cancel lunch for everyone")], 0)
        .await;
    let canceled = f
        .ok(json!({"action":"cancel","eventId":event,"revision":row.revision,"canceledBy":f.owner}))
        .await;
    assert_eq!(canceled["state"], "canceled");
    assert!(f.calendar_members(event).await.is_empty());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn leased_system_actions_preserve_authorization_boundaries() {
    let f = Fixture::new().await;
    let card = f.propose().await;
    let event = card["eventId"].as_str().unwrap();
    let confirm = |member: &str| json!({"action":"confirm","eventId":event,"revision":card["revision"],"confirmedBy":member,"optionId":"first"});
    let cancel = |member: &str| json!({"action":"cancel","eventId":event,"revision":card["revision"],"canceledBy":member});
    let rsvp =
        |member: &str| json!({"action":"rsvp","eventId":event,"participantId":member,"rsvp":"no"});

    // An old organizer message does not authorize a new run to act for them.
    f.messages(
        &[
            (&f.owner, "Confirm lunch"),
            (&f.attendee, "I can't make it"),
        ],
        1,
    )
    .await;
    for request in [
        confirm(&f.owner),
        cancel(&f.owner),
        rsvp(&f.owner),
        rsvp(&f.peer),
        confirm(&f.attendee),
        cancel(&f.attendee),
    ] {
        assert_eq!(f.call(request).await.status(), 403);
    }
    // Current provenance does not grant organizer authority or membership.
    f.messages(&[(&f.attendee, "I'm in")], 0).await;
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(f.chat).bind(&f.attendee).execute(&f.pool).await.unwrap();
    assert_eq!(f.call(rsvp(&f.attendee)).await.status(), 403);

    // Even a represented organizer cannot mutate another conversation's card.
    let other = Fixture::new().await;
    let other_card = other.propose().await;
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)")
        .bind(f.chat)
        .bind(&other.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    f.messages(&[(&other.owner, "Cancel lunch")], 0).await;
    assert_eq!(f.call(json!({"action":"cancel","eventId":other_card["eventId"],"revision":other_card["revision"],"canceledBy":other.owner})).await.status(), 403);

    f.messages(&[(&f.owner, "Confirm lunch")], 0).await;
    assert_eq!(
        super::runner_action(&f.state, &f.run, "wrong-runner", confirm(&f.owner))
            .await
            .status(),
        404
    );
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&f.run).execute(&f.pool).await.unwrap();
    assert_eq!(f.call(confirm(&f.owner)).await.status(), 404);
    let unchanged = super::store::load(&f.pool, event).await.unwrap().unwrap();
    assert_eq!(unchanged.revision, card["revision"].as_i64().unwrap());
    assert_eq!(unchanged.state, super::models::PlanCardState::Polling);
    assert!(f.calendar_members(event).await.is_empty());
}
