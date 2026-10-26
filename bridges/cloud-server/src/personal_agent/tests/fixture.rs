//! An owner with a definition, a Gmail connector granted to it, and a
//! collaborator account, all with uuid-suffixed ids.

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

use crate::events::EventBus;
use crate::personal_agent::sweep::{select, Candidate};
use crate::personal_agent::PersonalAgentConfig;
use crate::server::ServerState;

pub(super) async fn pool() -> Option<PgPool> {
    let skip_requested = std::env::var("KORDI_CONNECTOR_DB_TESTS").as_deref() == Ok("skip");
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ if skip_requested => return None,
        _ if std::env::var_os("CI").is_some() => panic!(
            "personal agent database tests need DATABASE_URL in CI. Run them through \
             scripts/test-cloud-migrations.sh, or set KORDI_CONNECTOR_DB_TESTS=skip \
             in a job that has no database."
        ),
        _ => return None,
    };
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// Creates an account with a device and returns (account_id, device_id,
/// session token).
pub(super) async fn signed_in_account(pool: &PgPool, name: &str) -> (String, String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_pa_{}_{suffix}", name.to_lowercase());
    let device_id = format!("dev_pa_{suffix}");
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
         created_at, last_seen_at, device_platform) VALUES ($1, $2, 'Mac', $3, $4, $4, 'macos')",
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
    (account_id, device_id, session.plaintext_token)
}

pub(super) struct Fixture {
    pub pool: PgPool,
    pub app: Router,
    pub owner: String,
    pub owner_device: String,
    pub owner_token: String,
    pub other_token: String,
    /// Scout, the owner's definition.
    pub agent_id: String,
    /// The owner's Gmail connector, granted to Scout.
    pub connector_id: String,
}

/// The documented defaults with no waiting, so tests need not sleep.
pub(super) fn quick() -> PersonalAgentConfig {
    PersonalAgentConfig {
        quiet_seconds: 0,
        ..PersonalAgentConfig::default()
    }
}

/// Mina owns Scout and a Gmail connector granted to Scout; Riya is another
/// account. Scout's Proactive setting starts off.
pub(super) async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let (owner, owner_device, owner_token) = signed_in_account(&pool, "Mina").await;
    let (_, _, other_token) = signed_in_account(&pool, "Riya").await;
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    let request = serde_json::from_value(json!({
        "name": "Scout",
        "role": "Helper",
        "systemPrompt": "Be precise and kind.",
        "modelRouting": {"defaultModel": "gpt-test"},
    }))
    .unwrap();
    crate::cloud_agents::store::create_agent_definition(
        &pool,
        &owner,
        agent_id.clone(),
        request,
        Utc::now(),
    )
    .await
    .expect("create agent");
    let connector_id = connector(&pool, &owner, "gmail").await;
    grant(&pool, &connector_id, &agent_id).await;
    let app = crate::server::router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    Some(Fixture {
        pool,
        app,
        owner,
        owner_device,
        owner_token,
        other_token,
        agent_id,
        connector_id,
    })
}

/// A live connector of `account` for `provider`.
pub(super) async fn connector(pool: &PgPool, account: &str, provider: &str) -> String {
    let connector_id = format!("cnr_pa_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_connectors (connector_id, account_id, provider, status) \
         VALUES ($1, $2, $3, 'connected')",
    )
    .bind(&connector_id)
    .bind(account)
    .bind(provider)
    .execute(pool)
    .await
    .unwrap();
    connector_id
}

pub(super) async fn grant(pool: &PgPool, connector_id: &str, agent_id: &str) {
    query("INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) VALUES ($1, $2)")
        .bind(connector_id)
        .bind(agent_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Stores an event the server received `seconds_ago`; returns its id.
pub(super) async fn event_on(
    pool: &PgPool,
    connector_id: &str,
    kind: &str,
    payload: Value,
    seconds_ago: i64,
) -> String {
    event_at(pool, connector_id, kind, payload, seconds_ago, seconds_ago).await
}

/// Stores an event that happened `occurred_ago` seconds ago and that the
/// server received `received_ago` seconds ago; returns its id.
pub(super) async fn event_at(
    pool: &PgPool,
    connector_id: &str,
    kind: &str,
    payload: Value,
    received_ago: i64,
    occurred_ago: i64,
) -> String {
    let event_id = format!("cnevt_pa_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_connector_events \
         (event_id, connector_id, provider, kind, external_id, occurred_at, payload, \
          received_at, expires_at) \
         SELECT $1, connector_id, provider, $2, $1, now() - make_interval(secs => $6), $3, \
                now() - make_interval(secs => $4), now() + interval '30 days' \
         FROM cloud_connectors WHERE connector_id = $5",
    )
    .bind(&event_id)
    .bind(kind)
    .bind(payload)
    .bind(received_ago as f64)
    .bind(connector_id)
    .bind(occurred_ago as f64)
    .execute(pool)
    .await
    .unwrap();
    event_id
}

impl Fixture {
    /// A Gmail message from `from` that the server received `seconds_ago`.
    pub async fn mail(&self, from: &str, subject: &str, seconds_ago: i64) -> String {
        let payload = json!({"from": from, "subject": subject, "snippet": "Are you free?"});
        event_on(
            &self.pool,
            &self.connector_id,
            "message.received",
            payload,
            seconds_ago,
        )
        .await
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

    pub async fn set_proactive(&self, agent_id: &str, on: bool) -> (StatusCode, Value) {
        let uri = format!("/v1/cloud/agents/{agent_id}/personal-agent");
        self.send(
            "PUT",
            &uri,
            &self.owner_token,
            Some(json!({"proactive": on})),
        )
        .await
    }

    /// Turns Scout's setting on and moves its cursor an hour back, so events
    /// from the last hour count as new.
    pub async fn watching(&self) {
        let (status, body) = self.set_proactive(&self.agent_id, true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        self.rewind().await;
    }

    /// Moves the cursor and the time the setting was turned on an hour back.
    pub async fn rewind(&self) {
        query(
            "UPDATE cloud_personal_agent_state SET cursor_received_at = now() - interval '1 hour', \
             cursor_event_id = '', enabled_at = now() - interval '1 hour' WHERE agent_id = $1",
        )
        .bind(&self.agent_id)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// The candidate the next sweep would pick for Scout under `config`.
    pub async fn candidate(&self, config: &PersonalAgentConfig) -> Option<Candidate> {
        query(
            "UPDATE cloud_personal_agent_state SET checked_at = now() - interval '10 years' \
             WHERE agent_id = $1",
        )
        .bind(&self.agent_id)
        .execute(&self.pool)
        .await
        .unwrap();
        // A parallel test's sweep may hold the row for a moment.
        for _ in 0..5 {
            let found = select(&self.pool, config, 10_000)
                .await
                .expect("sweep query")
                .into_iter()
                .find(|candidate| candidate.agent_id == self.agent_id);
            if found.is_some() {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        None
    }

    /// (cursor is older than an hour ago + 1 minute, active run, cooldown in
    /// the future, attempts)
    pub async fn state(&self) -> (chrono::DateTime<Utc>, Option<String>, bool, i32) {
        query_as(
            "SELECT cursor_received_at, active_run_id, cooldown_until > now(), attempts \
             FROM cloud_personal_agent_state WHERE agent_id = $1",
        )
        .bind(&self.agent_id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// Queues one evaluation for a fresh mail and returns (run id, event id).
    pub async fn queue_evaluation(&self) -> (String, String) {
        self.watching().await;
        let event_id = self
            .mail("Sam <sam@example.com>", "Dinner tonight?", 120)
            .await;
        let candidate = self.candidate(&quick()).await.expect("a candidate");
        // A parallel test's full sweep may queue it first; either run will do.
        crate::personal_agent::sweep::evaluate(&self.pool, &candidate)
            .await
            .unwrap();
        let run_id = self.state().await.1.expect("an active evaluation");
        (run_id, event_id)
    }

    /// Leases `run_id` as a runner and completes it with `reply`.
    pub async fn finish(&self, run_id: &str, reply: &str) {
        let runner = format!("runner-pa-{}", Uuid::new_v4().simple());
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

    /// The personal session of `agent_id`: (conversation id, session id).
    pub async fn personal_session(&self, agent_id: &str) -> (Uuid, String) {
        let session = crate::personal_agent::sessions::ensure(&self.pool, &self.owner, agent_id)
            .await
            .expect("personal session");
        (session.conversation_id, session.session_id)
    }

    /// The text blocks of every message in `conversation_id`, oldest first.
    pub async fn messages(&self, conversation_id: Uuid) -> Vec<String> {
        let rows: Vec<(Option<String>,)> = query_as(
            "SELECT content #>> '{blocks,0,text}' FROM cloud_chat_messages \
             WHERE conversation_id = $1 ORDER BY conversation_sequence",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter().filter_map(|(text,)| text).collect()
    }
}

/// A share reply that cites `event_id`.
pub(super) fn share(event_id: &str) -> String {
    json!({
        "decision": "share",
        "message": "Sam asked about dinner tonight and is waiting for your answer.",
        "eventIds": [event_id],
    })
    .to_string()
}

/// The decoded JSON of an `agent-response` body.
pub(super) fn envelope(body: &str) -> Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let encoded = body
        .strip_prefix("kordi-cloud-agent-response:")
        .expect("an agent response");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}
