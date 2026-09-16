use super::{
    models::{normalize_event_times, validate_event, CalendarEvent},
    routes::{error, failed, valid_timezone},
    series_routes::ExpectedEvent,
    store,
};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use std::{
    collections::{BTreeSet, HashSet},
    sync::Arc,
};

pub const MAX_SYNC_ITEMS: usize = 500;
pub const CALENDAR_CAPACITY: i64 = 1000;

/// One reconciliation batch from a device calendar. Every upsert carries the
/// device identity (`externalUid`); Kordi-only events keep using the single-event routes.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncRequest {
    #[serde(default)]
    pub upserts: Vec<CalendarEvent>,
    #[serde(default)]
    pub deletes: Vec<ExpectedEvent>,
}

pub(super) fn validate_sync_request(request: &mut SyncRequest) -> Result<(), &'static str> {
    if request.upserts.is_empty() && request.deletes.is_empty() {
        return Err("Nothing to sync.");
    }
    if request.upserts.len() > MAX_SYNC_ITEMS || request.deletes.len() > MAX_SYNC_ITEMS {
        return Err("Sync at most 500 changes per request.");
    }
    let mut ids = HashSet::new();
    for event in &mut request.upserts {
        normalize_event_times(event)?;
        validate_event(event)?;
        if event.recurrence.is_some() {
            return Err("Series are saved through the series route.");
        }
        if event
            .external_uid
            .as_deref()
            .is_none_or(|uid| uid.trim().is_empty())
        {
            return Err("Synced events need a device identity.");
        }
        if !ids.insert(event.id.clone()) {
            return Err("Duplicate event in sync request.");
        }
    }
    for expected in &request.deletes {
        if expected.revision < 1 || expected.id.is_empty() || expected.id.len() > 300 {
            return Err("Review the events before removing them.");
        }
        if !ids.insert(expected.id.clone()) {
            return Err("Duplicate event in sync request.");
        }
    }
    Ok(())
}

pub(super) async fn sync(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(mut request): Json<SyncRequest>,
) -> Response {
    if let Err(message) = validate_sync_request(&mut request) {
        return error("invalid_sync", message, StatusCode::BAD_REQUEST);
    }
    let pool = state.db_pool();
    let zones: BTreeSet<&str> = request
        .upserts
        .iter()
        .filter_map(|event| event.timezone.as_deref())
        .collect();
    for zone in zones {
        if !valid_timezone(pool, zone).await.unwrap_or(false) {
            return error(
                "invalid_timezone",
                "Choose a valid IANA timezone.",
                StatusCode::BAD_REQUEST,
            );
        }
    }
    let source_ids: Vec<String> = request
        .upserts
        .iter()
        .flat_map(|event| event.source_ids.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !store::authorized(pool, &session.account_id, &source_ids)
        .await
        .unwrap_or(false)
    {
        return error(
            "source_unavailable",
            "A source is no longer accessible.",
            StatusCode::FORBIDDEN,
        );
    }
    let mut tx = match pool.begin().await {
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
    let count: (i64,) =
        match query_as("SELECT COUNT(*) FROM cloud_calendar_events WHERE account_id=$1")
            .bind(&session.account_id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(count) => count,
            Err(_) => return failed(),
        };
    let mut capacity = CALENDAR_CAPACITY - count.0;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut saved: Vec<Value> = Vec::new();
    let mut conflicts = Vec::new();
    let mut skipped = Vec::new();
    for event in &request.upserts {
        if event.revision == 0 && capacity <= 0 {
            skipped.push(event.id.clone());
            continue;
        }
        match store::upsert_event(&mut tx, &session.account_id, event).await {
            Ok(Some((mut value, revision))) => {
                if event.revision == 0 {
                    capacity -= 1;
                }
                value["revision"] = json!(revision);
                value["updatedAt"] = json!(now);
                saved.push(value);
            }
            Ok(None) => conflicts.push(event.id.clone()),
            Err(_) => return failed(),
        }
    }
    let mut deleted = Vec::new();
    let mut delete_conflicts = Vec::new();
    for expected in &request.deletes {
        match query(
            "DELETE FROM cloud_calendar_events WHERE account_id=$1 AND event_id=$2 AND revision=$3",
        )
        .bind(&session.account_id)
        .bind(&expected.id)
        .bind(expected.revision)
        .execute(&mut *tx)
        .await
        {
            Ok(result) if result.rows_affected() == 1 => deleted.push(expected.id.clone()),
            Ok(_) => delete_conflicts.push(expected.id.clone()),
            Err(_) => return failed(),
        }
    }
    if tx.commit().await.is_err() {
        return failed();
    }
    Json(json!({
        "saved": saved,
        "conflicts": conflicts,
        "skipped": skipped,
        "deleted": deleted,
        "deleteConflicts": delete_conflicts,
        "capacity": capacity.max(0),
    }))
    .into_response()
}
