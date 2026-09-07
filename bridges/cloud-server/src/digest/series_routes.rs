use super::{
    models::CalendarEvent,
    recurrence,
    routes::{error, failed},
    store,
};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct ExpectedEvent {
    pub id: String,
    pub revision: i64,
}
#[derive(Deserialize)]
pub(super) struct Removal {
    pub events: Vec<ExpectedEvent>,
}

pub(super) async fn remove(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<String>,
    Json(expected): Json<Removal>,
) -> Response {
    let ids: std::collections::HashSet<_> = expected
        .events
        .iter()
        .map(|event| event.id.as_str())
        .collect();
    if id.is_empty()
        || id.len() > 260
        || expected.events.is_empty()
        || expected.events.len() > 1000
        || ids.len() != expected.events.len()
        || expected
            .events
            .iter()
            .any(|event| event.revision < 1 || event.id.len() > 300)
    {
        return error(
            "invalid_series",
            "Review the events before removing this series.",
            StatusCode::BAD_REQUEST,
        );
    }
    let mut tx = match state.db_pool().begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("digest-calendar:{}", session.account_id))
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return failed();
    }
    let current: Vec<(String,i64)> = match query_as("SELECT event_id,revision FROM cloud_calendar_events WHERE account_id=$1 AND payload->>'seriesId'=$2 FOR UPDATE")
        .bind(&session.account_id).bind(&id).fetch_all(&mut *tx).await { Ok(rows) => rows, Err(_) => return failed() };
    if current.len() != expected.events.len()
        || !current.iter().all(|(id, revision)| {
            expected
                .events
                .iter()
                .any(|event| &event.id == id && event.revision == *revision)
        })
    {
        return error(
            "version_conflict",
            "This series changed. Reload and review the current dates before removing it.",
            StatusCode::CONFLICT,
        );
    }
    if query("DELETE FROM cloud_calendar_events WHERE account_id=$1 AND payload->>'seriesId'=$2")
        .bind(&session.account_id)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return failed();
    }
    if tx.commit().await.is_err() {
        return failed();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn preview(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(event): Json<CalendarEvent>,
) -> Response {
    if !store::authorized(state.db_pool(), &session.account_id, &event.source_ids)
        .await
        .unwrap_or(false)
    {
        return error(
            "source_unavailable",
            "A source is no longer accessible.",
            StatusCode::FORBIDDEN,
        );
    }
    match recurrence::expand(state.db_pool(), event).await {
        Ok(events) => Json(json!({"events":events,"pushAvailable":false})).into_response(),
        Err(message) => error(
            "invalid_recurrence",
            message,
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    }
}

pub(super) async fn save(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<String>,
    Json(mut event): Json<CalendarEvent>,
) -> Response {
    if event.id != id {
        return error(
            "invalid_event",
            "Event identity does not match.",
            StatusCode::BAD_REQUEST,
        );
    }
    event.series_id = None;
    event.series_fingerprint = None;
    if let Err(message) = super::models::normalize_event_times(&mut event) {
        return error("invalid_event", message, StatusCode::BAD_REQUEST);
    }
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&event).unwrap()));
    let mut events = match recurrence::expand(state.db_pool(), event).await {
        Ok(events) => events,
        Err(message) => {
            return error(
                "invalid_recurrence",
                message,
                StatusCode::UNPROCESSABLE_ENTITY,
            )
        }
    };
    if !store::authorized(state.db_pool(), &session.account_id, &events[0].source_ids)
        .await
        .unwrap_or(false)
    {
        return error(
            "source_unavailable",
            "A source is no longer accessible.",
            StatusCode::FORBIDDEN,
        );
    }
    let mut tx = match state.db_pool().begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("digest-calendar:{}", session.account_id))
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return failed();
    }
    let ids: Vec<_> = events.iter().map(|event| event.id.clone()).collect();
    let saved: Vec<(Value,i64)> = match query_as("SELECT payload,revision FROM cloud_calendar_events WHERE account_id=$1 AND (payload->>'seriesId'=$2 OR event_id=ANY($3)) ORDER BY (payload->>'startAt')::timestamptz,event_id")
        .bind(&session.account_id).bind(&id).bind(ids).fetch_all(&mut *tx).await { Ok(rows) => rows, Err(_) => return failed() };
    if !saved.is_empty() {
        if saved
            .iter()
            .any(|(value, _)| value["seriesFingerprint"].as_str() != Some(&fingerprint))
        {
            return error(
                "version_conflict",
                "This series already exists. Reload before making changes.",
                StatusCode::CONFLICT,
            );
        }
        // Idempotent retry never overwrites edits or recreates individually removed occurrences.
        let values: Vec<_> = saved
            .into_iter()
            .map(|(mut value, revision)| {
                value["revision"] = json!(revision);
                value
            })
            .collect();
        return Json(json!({"events":values,"pushAvailable":false})).into_response();
    }
    let count: (i64,) =
        match query_as("SELECT count(*) FROM cloud_calendar_events WHERE account_id=$1")
            .bind(&session.account_id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(row) => row,
            Err(_) => return failed(),
        };
    if count.0 + events.len() as i64 > 1000 {
        return error(
            "calendar_full",
            "This series exceeds your calendar's 1,000-event capacity. Choose fewer occurrences.",
            StatusCode::UNPROCESSABLE_ENTITY,
        );
    }
    for event in &mut events {
        event.series_fingerprint = Some(fingerprint.clone());
        event.revision = 1;
    }
    if query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) SELECT $1,item->>'id',item FROM jsonb_array_elements($2::jsonb) item")
        .bind(&session.account_id).bind(json!(events)).execute(&mut *tx).await.is_err() { return failed(); }
    if tx.commit().await.is_err() {
        return failed();
    }
    Json(json!({"events":events,"pushAvailable":false})).into_response()
}
