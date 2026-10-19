use super::{models::*, store};
use crate::cloud_agent_runtime::provider_auth::newest_account_needing_reconnect;
use crate::{
    auth::routes::{cloud_session_middleware, CloudSession},
    server::ServerState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use std::sync::Arc;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/digest", get(read))
        .route("/v1/cloud/digest/refresh", post(refresh))
        .route(
            "/v1/cloud/digest/desktop/:run_id/observe",
            post(super::desktop::observe),
        )
        .route(
            "/v1/cloud/digest/desktop/:run_id/complete",
            post(super::desktop::complete),
        )
        .route(
            "/v1/cloud/digest/desktop/:run_id/release",
            post(super::desktop::release),
        )
        .route("/v1/cloud/digest/items/:id/feedback", put(feedback))
        .route(
            "/v1/cloud/digest/items/:id/task",
            post(super::task_routes::task),
        )
        .route(
            "/v1/cloud/digest/settings",
            get(super::settings_routes::read).put(super::settings_routes::save),
        )
        .route("/v1/cloud/calendar/events", get(events))
        .route("/v1/cloud/calendar/sync", post(super::sync_routes::sync))
        .route("/v1/cloud/calendar/read", post(super::chat_calendar::route))
        .route(
            "/v1/cloud/calendar/series/preview",
            post(super::series_routes::preview),
        )
        .route(
            "/v1/cloud/calendar/series/:id",
            put(super::series_routes::save).delete(super::series_routes::remove),
        )
        .route(
            "/v1/cloud/calendar/events/:id",
            put(save_event).delete(remove_event),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}
pub(super) fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode":code,"message":message}))).into_response()
}
pub(super) fn failed() -> Response {
    error(
        "digest_unavailable",
        "Could not load the digest. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}
#[derive(Default, Deserialize)]
struct Preferences {
    locale: Option<String>,
    timezone: Option<String>,
    /// On refresh: rebuild from the whole input instead of the changes.
    #[serde(default)]
    full: bool,
}
async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(prefs): Query<Preferences>,
) -> Response {
    let pool = state.db_pool();
    let locale = prefs.locale.unwrap_or_else(|| "en".into());
    let timezone = prefs.timezone.unwrap_or_else(|| "UTC".into());
    if locale.is_empty() || timezone.is_empty() || locale.len() > 64 || timezone.len() > 100 {
        return error(
            "invalid_preferences",
            "Invalid locale or timezone.",
            StatusCode::BAD_REQUEST,
        );
    }
    if !valid_timezone(pool, &timezone).await.unwrap_or(false) {
        return error(
            "invalid_timezone",
            "Choose a valid IANA timezone.",
            StatusCode::BAD_REQUEST,
        );
    }
    if store::initialize_preferences(pool, &session.account_id, &locale, &timezone)
        .await
        .is_err()
    {
        return failed();
    }
    type Row = (
        Option<Value>,
        Value,
        Option<String>,
        Option<String>,
        i64,
        chrono::DateTime<chrono::Utc>,
        String,
    );
    // Opening the digest shows the saved snapshot. It starts a run only for a
    // first build or a snapshot over 15 minutes old with changes pending, at
    // most once per 15 minutes, since clients poll this route while it is open.
    match super::cadence::claim_open_refresh(pool, &session.account_id).await {
        Ok(true) => {
            let pool = pool.clone();
            let account = session.account_id.clone();
            tokio::spawn(async move {
                if store::refresh_as(&pool, &account, store::Trigger::Automatic)
                    .await
                    .is_err()
                {
                    eprintln!("[digest] Refresh on open failed; the background check will retry.");
                }
            });
        }
        Ok(false) => {}
        Err(_) => return failed(),
    }
    let row=query_as::<_,Row>("SELECT snapshot_json,COALESCE(snapshot_input_json,'{}'),active_run_id,error_code,revision,updated_at,timezone FROM cloud_account_digests WHERE account_id=$1").bind(&session.account_id).fetch_one(pool).await;
    let Ok((mut snapshot, input, active, error_code, revision, updated_at, timezone)) = row else {
        return failed();
    };
    // Names the account to reconnect when the provider refused the sign-in.
    let error_provider = match error_code.as_deref() {
        Some("provider_auth_rejected") => {
            match newest_account_needing_reconnect(pool, &session.account_id).await {
                Ok(provider) => provider,
                Err(_) => return failed(),
            }
        }
        _ => None,
    };
    let input = serde_json::from_value::<Input>(input).ok();
    let mut refs = Vec::new();
    let mut partial = false;
    if let Some(input) = input {
        // Items whose sources changed since the run stay hidden until the
        // next run reconciles them.
        match super::evidence::current_input_sources(pool, &session.account_id, &input).await {
            Ok(Some(current)) => {
                if let Some(snapshot) = &mut snapshot {
                    super::evidence::retain_supported_json(snapshot, &current);
                }
                refs = current;
                partial = input.partial;
            }
            Ok(None) => snapshot = None,
            Err(_) => return failed(),
        }
    } else {
        snapshot = None;
    }
    let feedback: Vec<(String, String, Option<String>)> = match query_as(
        "SELECT item_id,status,task_id FROM cloud_digest_feedback WHERE account_id=$1",
    )
    .bind(&session.account_id)
    .fetch_all(pool)
    .await
    {
        Ok(v) => v,
        Err(_) => return failed(),
    };
    Json(json!({"accountId":session.account_id,"timezone":timezone,"snapshot":snapshot,"sources":if snapshot.is_some(){refs}else{vec![]},"partial":partial&&snapshot.is_some(),"revision":revision,"updatedAt":updated_at,"status":if active.is_some(){"updating"}else if error_code.is_some(){"error"}else if snapshot.is_some(){"ready"}else{"loading"},"errorCode":error_code,"errorProvider":error_provider,"feedback":feedback.into_iter().map(|(id,status,task_id)|json!({"id":id,"status":status,"taskId":task_id})).collect::<Vec<_>>()})).into_response()
}
async fn refresh(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(prefs): Query<Preferences>,
) -> Response {
    if prefs
        .locale
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > 64)
        || prefs
            .timezone
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 100)
    {
        return error(
            "invalid_preferences",
            "Invalid locale or timezone.",
            StatusCode::BAD_REQUEST,
        );
    }
    // Refresh is not a preference edit: another device must not reinterpret relative dates.
    if query("UPDATE cloud_account_digests SET retry_after=now() WHERE account_id=$1")
        .bind(&session.account_id)
        .execute(state.db_pool())
        .await
        .is_err()
    {
        return failed();
    }
    let trigger = if prefs.full {
        store::Trigger::Full
    } else {
        store::Trigger::Manual
    };
    match store::refresh_as(state.db_pool(), &session.account_id, trigger).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(_) => failed(),
    }
}
async fn events(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match store::calendar(state.db_pool(), &session.account_id).await {
        Ok(events) => {
            Json(json!({"events":events,"pushAvailable":state.notifications().is_some()}))
                .into_response()
        }
        Err(_) => failed(),
    }
}
pub(super) async fn save_event(
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
    if let Err(message) = normalize_event_times(&mut event).and_then(|()| validate_event(&event)) {
        return error("invalid_event", message, StatusCode::BAD_REQUEST);
    }
    if let Some(zone) = &event.timezone {
        if !valid_timezone(state.db_pool(), zone).await.unwrap_or(false) {
            return error(
                "invalid_timezone",
                "Choose a valid IANA timezone.",
                StatusCode::BAD_REQUEST,
            );
        }
    }
    // Older clients cannot interpret update/delete proposals. Never let them create a duplicate.
    if event.revision == 0 && event.id.starts_with("digest-") {
        let incompatible: Result<(bool,), _> = query_as("SELECT EXISTS(SELECT 1 FROM cloud_account_digests, jsonb_array_elements(snapshot_json->'calendarCandidates') item WHERE account_id=$1 AND item->>'id'=$2 AND (COALESCE(item->>'calendarAction','create')<>'create' OR (item->'recurrence' IS NOT NULL AND item->'recurrence'<>'null'::jsonb AND NOT $3)))")
            .bind(&session.account_id).bind(&event.id[7..]).bind(event.confirm_single_occurrence==Some(true)).fetch_one(state.db_pool()).await;
        match incompatible {
            Ok((false,)) => {}
            Ok((true,)) => {
                return error(
                    "review_required",
                    "Review this change in an updated app before saving.",
                    StatusCode::CONFLICT,
                )
            }
            Err(_) => return failed(),
        }
    }
    if event.revision == 0 && event.recurrence.is_some() {
        return error(
            "review_required",
            "Preview and confirm the series before saving.",
            StatusCode::CONFLICT,
        );
    }
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
    if event.revision == 0 {
        let count: Result<(i64,), _> =
            query_as("SELECT COUNT(*) FROM cloud_calendar_events WHERE account_id=$1")
                .bind(&session.account_id)
                .fetch_one(&mut *tx)
                .await;
        match count {
            Ok((count,)) if count >= super::sync_routes::CALENDAR_CAPACITY => {
                return error(
                    "calendar_full",
                    "Your Kordi calendar has 10,000 events. Turn off a calendar in Calendar settings or remove older events before adding more.",
                    StatusCode::UNPROCESSABLE_ENTITY,
                )
            }
            Err(_) => return failed(),
            _ => {}
        }
    }
    let row = store::upsert_event(&mut tx, &session.account_id, &event).await;
    match row {
        Ok(Some((mut value, revision))) => {
            if tx.commit().await.is_err() {
                return failed();
            }
            let _ = super::changes::mark_accounts(
                state.db_pool(),
                std::slice::from_ref(&session.account_id),
            )
            .await;
            value["revision"] = json!(revision);
            value["updatedAt"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            Json(value).into_response()
        }
        Ok(None) => error(
            "version_conflict",
            "This event changed. Reload before saving.",
            StatusCode::CONFLICT,
        ),
        Err(_) => failed(),
    }
}
pub(super) async fn valid_timezone(
    pool: &sqlx_postgres::PgPool,
    zone: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
        .bind(zone)
        .fetch_one(pool)
        .await
        .map(|row| row.0)
}
#[derive(Deserialize)]
struct ExpectedRevision {
    revision: i64,
}
async fn remove_event(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<String>,
    Query(expected): Query<ExpectedRevision>,
) -> Response {
    match query(
        "DELETE FROM cloud_calendar_events WHERE account_id=$1 AND event_id=$2 AND revision=$3",
    )
    .bind(&session.account_id)
    .bind(id)
    .bind(expected.revision)
    .execute(state.db_pool())
    .await
    {
        Ok(r) if r.rows_affected() == 1 => {
            let _ = super::changes::mark_accounts(
                state.db_pool(),
                std::slice::from_ref(&session.account_id),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => error(
            "version_conflict",
            "This event changed. Reload before removing it.",
            StatusCode::CONFLICT,
        ),
        Err(_) => failed(),
    }
}
#[derive(Deserialize)]
struct Feedback {
    dismissed: bool,
}
async fn feedback(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<String>,
    Json(input): Json<Feedback>,
) -> Response {
    if id.len() > 160 {
        return error("invalid_item", "Invalid item.", StatusCode::BAD_REQUEST);
    }
    let result = if input.dismissed {
        query("INSERT INTO cloud_digest_feedback(account_id,item_id,status) VALUES($1,$2,'dismissed') ON CONFLICT(account_id,item_id) DO UPDATE SET status='dismissed' WHERE cloud_digest_feedback.status<>'task'").bind(&session.account_id).bind(id).execute(state.db_pool()).await
    } else {
        query("DELETE FROM cloud_digest_feedback WHERE account_id=$1 AND item_id=$2 AND status='dismissed'").bind(&session.account_id).bind(id).execute(state.db_pool()).await
    };
    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => failed(),
    }
}
