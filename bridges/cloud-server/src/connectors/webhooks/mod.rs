//! Webhook and push endpoints that turn provider events into connector
//! events: GitHub (`X-Hub-Signature-256`), Slack (signing secret and URL
//! verification), and Google Pub/Sub push for Gmail (OIDC bearer).
//!
//! Each event is keyed to connectors by the provider account stored at
//! grant time and recorded once per `external_id`, so retries and replays
//! of a signed request store nothing new.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_postgres::PgPool;

use super::events::{record_event, NewConnectorEvent};
use super::providers::http::{cap_text, text_at};
use super::providers::slack::{chosen_channels, ts_time};
use super::store;
use crate::server::ServerState;

pub mod verify;

pub const GITHUB_PATH: &str = "/v1/cloud/connectors/webhooks/github";
pub const SLACK_PATH: &str = "/v1/cloud/connectors/webhooks/slack";
pub const GOOGLE_PATH: &str = "/v1/cloud/connectors/webhooks/google";

/// Unauthenticated by session: each endpoint verifies its provider's
/// signature or token before reading the body.
pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(GITHUB_PATH, post(github_webhook))
        .route(SLACK_PATH, post(slack_webhook))
        .route(GOOGLE_PATH, post(google_push))
}

fn reply(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "errorCode": code }))).into_response()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

struct Incoming<'a> {
    provider: &'a str,
    provider_account_id: &'a str,
    kind: &'a str,
    external_id: &'a str,
    occurred_at: DateTime<Utc>,
    payload: &'a Value,
}

/// Records the event for every live connector of the provider account that
/// `accept` allows. Returns how many new events were stored.
async fn record_for_account(
    pool: &PgPool,
    event: Incoming<'_>,
    accept: impl Fn(&super::models::ConnectorRecord) -> bool,
) -> Result<usize, sqlx_core::Error> {
    let connectors =
        store::live_connectors_for_account_id(pool, event.provider, event.provider_account_id)
            .await?;
    let mut recorded = 0;
    for connector in connectors.iter().filter(|connector| accept(connector)) {
        let stored = record_event(
            pool,
            NewConnectorEvent {
                connector_id: &connector.connector_id,
                provider: event.provider,
                kind: event.kind,
                external_id: Some(event.external_id),
                occurred_at: event.occurred_at,
                payload: event.payload,
            },
        )
        .await?;
        recorded += usize::from(stored.is_some());
    }
    Ok(recorded)
}

fn stored(result: Result<usize, sqlx_core::Error>) -> Response {
    match result {
        Ok(recorded) => (StatusCode::OK, Json(json!({ "recorded": recorded }))).into_response(),
        Err(error) => {
            eprintln!("[connectors] record webhook event: {error}");
            reply(StatusCode::INTERNAL_SERVER_ERROR, "server_error")
        }
    }
}

/// GitHub user ids the event is about (reviewer, assignee, author), not the
/// person who caused it.
fn github_recipients(payload: &Value) -> Vec<String> {
    let sender = payload
        .pointer("/sender/id")
        .and_then(Value::as_u64)
        .map(|id| id.to_string());
    let mut ids = Vec::new();
    for pointer in [
        "/requested_reviewer/id",
        "/assignee/id",
        "/pull_request/user/id",
        "/issue/user/id",
    ] {
        if let Some(id) = payload.pointer(pointer).and_then(Value::as_u64) {
            let id = id.to_string();
            if sender.as_ref() != Some(&id) && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

async fn github_webhook(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(secret) = state.connectors().hooks.github_webhook_secret.as_deref() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, "webhook_not_configured");
    };
    if !verify::github_signature_valid(secret, &body, header(&headers, "x-hub-signature-256")) {
        return reply(StatusCode::UNAUTHORIZED, "invalid_signature");
    }
    let event = header(&headers, "x-github-event").unwrap_or("unknown");
    let Some(delivery) = header(&headers, "x-github-delivery").filter(|id| id.len() <= 128) else {
        return reply(StatusCode::BAD_REQUEST, "missing_delivery");
    };
    if event == "ping" {
        return (StatusCode::OK, Json(json!({ "recorded": 0 }))).into_response();
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return reply(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let action = payload.get("action").and_then(Value::as_str);
    let kind = match action {
        Some(action) => format!("{}.{}", cap_text(event, 60), cap_text(action, 60)),
        None => cap_text(event, 60),
    };
    let item = payload
        .get("pull_request")
        .or_else(|| payload.get("issue"))
        .cloned()
        .unwrap_or(Value::Null);
    let summary = json!({
        "event": event,
        "action": action,
        "repository": payload.pointer("/repository/full_name"),
        "number": item.get("number"),
        "title": text_at(&item, "/title", 300),
        "url": item.get("html_url"),
        "sender": payload.pointer("/sender/login"),
    });
    let external_id = format!("delivery:{delivery}");
    let pool = state.db_pool();
    let mut total = 0;
    for account in github_recipients(&payload) {
        let incoming = Incoming {
            provider: "github",
            provider_account_id: &account,
            kind: &kind,
            external_id: &external_id,
            occurred_at: Utc::now(),
            payload: &summary,
        };
        match record_for_account(pool, incoming, |_| true).await {
            Ok(recorded) => total += recorded,
            Err(error) => return stored(Err(error)),
        }
    }
    stored(Ok(total))
}

async fn slack_webhook(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(secret) = state.connectors().hooks.slack_signing_secret.as_deref() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, "webhook_not_configured");
    };
    let checked = verify::slack_signature_check(
        secret,
        header(&headers, "x-slack-request-timestamp"),
        header(&headers, "x-slack-signature"),
        &body,
        Utc::now(),
    );
    if checked.is_err() {
        return reply(StatusCode::UNAUTHORIZED, "invalid_signature");
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return reply(StatusCode::BAD_REQUEST, "invalid_body");
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("url_verification") => {
            let challenge = payload.get("challenge").cloned().unwrap_or(Value::Null);
            return (StatusCode::OK, Json(json!({ "challenge": challenge }))).into_response();
        }
        Some("event_callback") => {}
        _ => return stored(Ok(0)),
    }
    let event = payload.get("event").cloned().unwrap_or(Value::Null);
    let (Some(team), Some(channel)) = (
        payload.get("team_id").and_then(Value::as_str),
        event.get("channel").and_then(Value::as_str),
    ) else {
        return stored(Ok(0));
    };
    let ts = event.get("ts").and_then(Value::as_str);
    let external_id = match (ts, payload.get("event_id").and_then(Value::as_str)) {
        (Some(ts), _) => format!("message:{channel}:{ts}"),
        (None, Some(event_id)) => format!("event:{event_id}"),
        (None, None) => return reply(StatusCode::BAD_REQUEST, "missing_event_id"),
    };
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .map(|kind| cap_text(kind, 60))
        .unwrap_or_else(|| "event".into());
    let summary = json!({
        "channel": channel,
        "ts": ts,
        "user": event.get("user"),
        "text": text_at(&event, "/text", 2000),
        "threadTs": event.get("thread_ts"),
    });
    let occurred_at = ts.and_then(ts_time).unwrap_or_else(Utc::now);
    let users = payload
        .get("authorizations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("user_id").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pool = state.db_pool();
    let mut total = 0;
    for user in users.iter().take(10) {
        let account = format!("{team}:{user}");
        let incoming = Incoming {
            provider: "slack",
            provider_account_id: &account,
            kind: &kind,
            external_id: &external_id,
            occurred_at,
            payload: &summary,
        };
        // Only channels the person chose for Kordi become events.
        let chosen = |connector: &super::models::ConnectorRecord| {
            chosen_channels(&connector.settings)
                .iter()
                .any(|id| id == channel)
        };
        match record_for_account(pool, incoming, chosen).await {
            Ok(recorded) => total += recorded,
            Err(error) => return stored(Err(error)),
        }
    }
    stored(Ok(total))
}

async fn google_push(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let hooks = &state.connectors().hooks;
    if hooks.google_push_audience.is_none() || hooks.google_push_service_account.is_none() {
        return reply(StatusCode::FORBIDDEN, "push_not_configured");
    }
    if !verify::google_push_authorized(hooks, header(&headers, "authorization")).await {
        return reply(StatusCode::UNAUTHORIZED, "invalid_push_token");
    }
    let Ok(envelope) = serde_json::from_slice::<Value>(&body) else {
        return reply(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let data = envelope
        .pointer("/message/data")
        .and_then(Value::as_str)
        .and_then(|data| STANDARD.decode(data).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let email = data.get("emailAddress").and_then(Value::as_str);
    let history = match data.get("historyId") {
        Some(Value::String(id)) => Some(id.clone()),
        Some(Value::Number(id)) => Some(id.to_string()),
        _ => None,
    };
    // Unknown or malformed pushes are acknowledged so Pub/Sub stops
    // retrying them; nothing is stored.
    let (Some(email), Some(history)) = (email, history) else {
        return stored(Ok(0));
    };
    let account = email.trim().to_ascii_lowercase();
    let external_id = format!("push:{}", cap_text(&history, 40));
    let summary = json!({ "historyId": history });
    let incoming = Incoming {
        provider: "gmail",
        provider_account_id: &account,
        kind: "mailbox.changed",
        external_id: &external_id,
        occurred_at: Utc::now(),
        payload: &summary,
    };
    stored(record_for_account(state.db_pool(), incoming, |_| true).await)
}
