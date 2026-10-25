//! Accounts, a group with its owner and a collaborator, and a watching agent.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::events::EventBus;
use crate::proactive::snapshot::Candidate;
use crate::proactive::ProactiveConfig;
use crate::server::ServerState;

pub(super) async fn pool() -> Option<PgPool> {
    let skip_requested = std::env::var("KORDI_CONNECTOR_DB_TESTS").as_deref() == Ok("skip");
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ if skip_requested => return None,
        _ if std::env::var_os("CI").is_some() => panic!(
            "proactive agent database tests need DATABASE_URL in CI. Run them through \
             scripts/test-cloud-migrations.sh, or set KORDI_CONNECTOR_DB_TESTS=skip \
             in a job that has no database."
        ),
        _ => return None,
    };
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// Creates an account with a device and returns (account_id, session token).
pub(super) async fn signed_in_account(pool: &PgPool, name: &str) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_pro_{}_{suffix}", name.to_lowercase());
    let device_id = format!("dev_pro_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
    )
    .bind(&account_id)
    .bind(name)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Proactive device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    (account_id, session.plaintext_token)
}

pub(super) struct Fixture {
    pub pool: PgPool,
    pub app: Router,
    pub owner: String,
    pub owner_token: String,
    pub member: String,
    pub member_token: String,
    pub agent_id: String,
    pub group: Uuid,
    pub session_id: String,
}

/// Defaults from the document, with no wait so tests need not sleep.
pub(super) fn config() -> ProactiveConfig {
    ProactiveConfig::default()
}

pub(super) async fn create_agent(pool: &PgPool, owner: &str, body: Value) -> String {
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    let request = serde_json::from_value(body).expect("agent request");
    crate::cloud_agents::store::create_agent_definition(
        pool,
        owner,
        agent_id.clone(),
        request,
        Utc::now(),
    )
    .await
    .expect("create agent");
    agent_id
}

pub(super) fn agent_body(enabled: bool) -> Value {
    json!({
        "name": "Scout",
        "role": "Helper",
        "systemPrompt": "Be precise and kind.",
        "skills": [{"name": "Build doctor", "description": "Fixes broken builds"}],
        "modelRouting": {"defaultModel": "gpt-test"},
        "proactive": {"enabled": enabled},
    })
}

/// Mina owns Scout and is in "Launch" with Riya. Mina's earlier messages are
/// history the agent never evaluates.
pub(super) async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let (owner, owner_token) = signed_in_account(&pool, "Mina").await;
    let (member, member_token) = signed_in_account(&pool, "Riya").await;
    let group = Uuid::new_v4();
    let session_id = format!("session:group:{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, \
         created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'group', 'Launch', $2, $3, 'fixture', $4)",
    )
    .bind(group)
    .bind(&owner)
    .bind(Uuid::new_v4())
    .bind(&session_id)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) \
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    )
    .bind(group)
    .bind(&owner)
    .bind(&member)
    .execute(&pool)
    .await
    .unwrap();
    say(
        &pool,
        &member,
        group,
        "Is the build broken again? I need help",
        30,
    )
    .await;
    let agent_id = create_agent(&pool, &owner, agent_body(true)).await;
    let app = crate::server::router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    Some(Fixture {
        pool,
        app,
        owner,
        owner_token,
        member,
        member_token,
        agent_id,
        group,
        session_id,
    })
}

/// Sends `text` as `sender` and dates it `minutes_ago`. Returns its id.
pub(super) async fn say(
    pool: &PgPool,
    sender: &str,
    conversation_id: Uuid,
    text: &str,
    minutes_ago: i64,
) -> String {
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let message = crate::chat_sync::store::send_message(pool, sender, conversation_id, request)
        .await
        .expect("send message")
        .value;
    query(
        "UPDATE cloud_chat_messages SET created_at = now() - make_interval(mins => $2) \
         WHERE message_id = $1",
    )
    .bind(message.id)
    .bind(minutes_ago as i32)
    .execute(pool)
    .await
    .unwrap();
    message.id.to_string()
}

impl Fixture {
    /// The candidate the sweep would pick for this fixture's agent and group.
    pub async fn candidate(&self, config: &ProactiveConfig) -> Option<Candidate> {
        query("UPDATE cloud_agent_proactive_state SET checked_at = now() - interval '1 hour' WHERE agent_id = $1")
            .bind(&self.agent_id)
            .execute(&self.pool)
            .await
            .unwrap();
        crate::proactive::sweep::select(&self.pool, config, 10_000)
            .await
            .expect("sweep query")
            .into_iter()
            .find(|candidate| {
                candidate.agent_id == self.agent_id && candidate.conversation_id == self.group
            })
    }

    pub async fn seed(&self) {
        crate::proactive::sweep::seed(&self.pool).await.unwrap();
    }

    /// (seen_sequence, active_run_id, cooldown in the future)
    pub async fn state(&self) -> (i64, Option<String>, bool) {
        query_as(
            "SELECT seen_sequence, active_run_id, cooldown_until > now() \
             FROM cloud_agent_proactive_state WHERE agent_id = $1 AND conversation_id = $2",
        )
        .bind(&self.agent_id)
        .bind(self.group)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    pub async fn latest_sequence(&self) -> i64 {
        let (latest,): (i64,) = query_as(
            "SELECT latest_message_sequence FROM cloud_chat_conversations WHERE conversation_id = $1",
        )
        .bind(self.group)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        latest
    }

    /// Queues an evaluation from a collaborator's request and returns its run id.
    pub async fn queue_evaluation(&self) -> String {
        self.seed().await;
        say(
            &self.pool,
            &self.member,
            self.group,
            "The deploy keeps failing, can anyone help?",
            5,
        )
        .await;
        let candidate = self.candidate(&config()).await.expect("a candidate");
        let outcome = crate::proactive::sweep::evaluate(&self.pool, &candidate)
            .await
            .unwrap();
        assert_eq!(outcome, crate::proactive::sweep::Outcome::Queued);
        self.state().await.1.expect("an active evaluation")
    }

    /// Leases `run_id` as a runner and completes it with `reply`.
    pub async fn finish(&self, run_id: &str, reply: &str) {
        let runner = format!("runner-pro-{}", Uuid::new_v4().simple());
        let leased =
            crate::cloud_agent_runtime::runs::lease_canary_run(&self.pool, &runner, run_id)
                .await
                .unwrap()
                .expect("the queued run is leased");
        assert_eq!(leased.run_id, run_id);
        crate::cloud_agent_runtime::runs::complete_run(&self.pool, run_id, &runner, reply)
            .await
            .expect("complete run");
    }

    pub async fn send(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

/// An offer that cites `evidence`.
pub(super) fn offer_reply(evidence: &str) -> String {
    json!({
        "decision": "offer",
        "problem": "The deploy fails on every push",
        "offer": "Riya, I can read the deploy log and point at the failing step.",
        "plan": "Read the latest deploy log\nFind the failing step\nSuggest the fix",
        "evidence": [evidence, "not-a-message"],
    })
    .to_string()
}
