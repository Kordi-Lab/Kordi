//! The GitHub webhook (`X-Hub-Signature-256`).
//!
//! The signature covers the body only. The `X-GitHub-Event` and
//! `X-GitHub-Delivery` headers are not signed, so a captured body could be
//! replayed with any headers: the event name is accepted only when the
//! payload has that event's shape, and an event is recorded once per body
//! hash as well as once per delivery id.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{header, record_for_account, reply, stored, verify, Incoming};
use crate::connectors::providers::http::text_at;
use crate::server::ServerState;

const MAX_REPOSITORY_CHARS: usize = 200;
const MAX_SENDER_CHARS: usize = 100;
const MAX_URL_CHARS: usize = 500;
const MAX_ACTION_CHARS: usize = 40;

/// Events recorded, with the payload keys each must have and must not have.
/// Anything else is acknowledged and not stored.
const SHAPES: &[(&str, &[&str], &[&str])] = &[
    ("pull_request", &["pull_request"], &["review", "comment"]),
    ("pull_request_review", &["pull_request", "review"], &[]),
    (
        "pull_request_review_comment",
        &["pull_request", "comment"],
        &[],
    ),
    ("issues", &["issue"], &["comment"]),
    ("issue_comment", &["issue", "comment"], &[]),
];

/// The event name, when the untrusted header names a known event and the
/// payload has its shape.
pub fn checked_event(header: &str, payload: &Value) -> Option<&'static str> {
    let has = |key: &str| payload.get(key).is_some_and(Value::is_object);
    SHAPES
        .iter()
        .find(|(name, required, forbidden)| {
            *name == header
                && required.iter().all(|key| has(key))
                && !forbidden.iter().any(|key| has(key))
        })
        .map(|(name, _, _)| *name)
}

/// The payload `action`, when it is a short lowercase word.
fn checked_action(payload: &Value) -> Option<&str> {
    payload
        .get("action")
        .and_then(Value::as_str)
        .filter(|action| {
            !action.is_empty()
                && action.len() <= MAX_ACTION_CHARS
                && action.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        })
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

/// The compact, capped summary stored for one event.
pub fn github_summary(event: &str, action: Option<&str>, delivery: &str, payload: &Value) -> Value {
    let item = payload
        .get("pull_request")
        .or_else(|| payload.get("issue"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "event": event,
        "action": action,
        "delivery": delivery,
        "repository": text_at(payload, "/repository/full_name", MAX_REPOSITORY_CHARS),
        "number": item.get("number").and_then(Value::as_u64),
        "title": text_at(&item, "/title", 300),
        "url": text_at(&item, "/html_url", MAX_URL_CHARS),
        "sender": text_at(payload, "/sender/login", MAX_SENDER_CHARS),
    })
}

pub(super) async fn github_webhook(
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
    let Some(delivery) = header(&headers, "x-github-delivery")
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)
    else {
        return reply(StatusCode::BAD_REQUEST, "missing_delivery");
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return reply(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let claimed = header(&headers, "x-github-event").unwrap_or_default();
    let Some(event) = checked_event(claimed, &payload) else {
        // Pings, events Kordi does not record, and headers that do not
        // match the payload are acknowledged and not stored.
        return (StatusCode::OK, Json(json!({ "recorded": 0 }))).into_response();
    };
    let action = checked_action(&payload);
    let kind = match action {
        Some(action) => format!("{event}.{action}"),
        None => event.to_string(),
    };
    let summary = github_summary(event, action, delivery, &payload);
    let external_id = format!("body:{}", hex::encode(Sha256::digest(&body)));
    let pool = state.db_pool();
    let mut total = 0;
    for account in github_recipients(&payload) {
        let incoming = Incoming {
            provider: "github",
            provider_account_id: &account,
            kind: &kind,
            external_id: &external_id,
            delivery: Some(delivery),
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
