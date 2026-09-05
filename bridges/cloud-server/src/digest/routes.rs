use super::{models::*, store};
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
        .route("/v1/cloud/digest/items/:id/feedback", put(feedback))
        .route("/v1/cloud/digest/items/:id/task", post(task))
        .route("/v1/cloud/calendar/events", get(events))
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
fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode":code,"message":message}))).into_response()
}
fn failed() -> Response {
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
    );
    let row=query_as::<_,Row>("SELECT snapshot_json,COALESCE(snapshot_input_json,'{}'),active_run_id,error_code,revision,updated_at FROM cloud_account_digests WHERE account_id=$1").bind(&session.account_id).fetch_one(pool).await;
    let Ok((mut snapshot, input, active, error_code, revision, updated_at)) = row else {
        return failed();
    };
    let input = serde_json::from_value::<Input>(input).ok();
    let mut refs = Vec::new();
    let mut partial = false;
    if let Some(input) = input {
        match store::input_is_currently_authorized(pool, &session.account_id, &input).await {
            Ok(true) => {
                refs = input.sources;
                partial = input.partial;
            }
            Ok(false) => snapshot = None,
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
    Json(json!({"accountId":session.account_id,"snapshot":snapshot,"sources":if snapshot.is_some(){refs}else{vec![]},"partial":partial&&snapshot.is_some(),"revision":revision,"updatedAt":updated_at,"status":if active.is_some(){"updating"}else if error_code.is_some(){"error"}else if snapshot.is_some(){"ready"}else{"loading"},"errorCode":error_code,"feedback":feedback.into_iter().map(|(id,status,task_id)|json!({"id":id,"status":status,"taskId":task_id})).collect::<Vec<_>>()})).into_response()
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
    if query("UPDATE cloud_account_digests SET retry_after=now(),locale=COALESCE($2,locale),timezone=COALESCE($3,timezone) WHERE account_id=$1")
        .bind(&session.account_id).bind(prefs.locale).bind(prefs.timezone)
        .execute(state.db_pool())
        .await
        .is_err()
    {
        return failed();
    }
    match store::refresh(state.db_pool(), &session.account_id, true).await {
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
    Json(event): Json<CalendarEvent>,
) -> Response {
    if event.id != id {
        return error(
            "invalid_event",
            "Event identity does not match.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let Err(message) = validate_event(&event) {
        return error("invalid_event", message, StatusCode::BAD_REQUEST);
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
            Ok((count,)) if count >= 1000 => {
                return error(
                    "calendar_full",
                    "Your Kordi calendar has 1,000 events. Remove older events before adding more.",
                    StatusCode::UNPROCESSABLE_ENTITY,
                )
            }
            Err(_) => return failed(),
            _ => {}
        }
    }
    let row:Result<Option<(Value,i64)>,_>=query_as("INSERT INTO cloud_calendar_events(account_id,event_id,payload) SELECT $1,$2,$3 WHERE $4=0 ON CONFLICT(account_id,event_id) DO UPDATE SET payload=$3,revision=cloud_calendar_events.revision+1,updated_at=now() WHERE cloud_calendar_events.revision=$4 RETURNING payload,revision")
        .bind(&session.account_id).bind(&id).bind(serde_json::to_value(&event).unwrap()).bind(event.revision).fetch_optional(&mut *tx).await;
    // Existing rows with an expected revision use an explicit update.
    let row=match row {Ok(None) if event.revision>0=>query_as("UPDATE cloud_calendar_events SET payload=$3,revision=revision+1,updated_at=now() WHERE account_id=$1 AND event_id=$2 AND revision=$4 RETURNING payload,revision").bind(&session.account_id).bind(&id).bind(serde_json::to_value(&event).unwrap()).bind(event.revision).fetch_optional(&mut *tx).await,other=>other};
    match row {
        Ok(Some((mut value, revision))) => {
            if tx.commit().await.is_err() {
                return failed();
            }
            value["revision"] = json!(revision);
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
        Ok(r) if r.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInput {
    title: String,
    owner_account_id: Option<String>,
    due_at: Option<String>,
}
async fn task(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<String>,
    Json(request): Json<TaskInput>,
) -> Response {
    let pool = state.db_pool();
    if request.title.trim().is_empty()
        || request.title.len() > 500
        || request
            .due_at
            .as_ref()
            .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_err())
    {
        return error(
            "invalid_task",
            "Review the task title and date.",
            StatusCode::BAD_REQUEST,
        );
    }
    let row:Option<(Value,Value)>=match query_as("SELECT snapshot_json,snapshot_input_json FROM cloud_account_digests WHERE account_id=$1 AND snapshot_json IS NOT NULL").bind(&session.account_id).fetch_optional(pool).await{Ok(v)=>v,Err(_)=>return failed()};
    let Some((snapshot, input)) = row else {
        return error("not_found", "Digest item not found.", StatusCode::NOT_FOUND);
    };
    let (Ok(output), Ok(input)) = (
        serde_json::from_value::<Output>(snapshot),
        serde_json::from_value::<Input>(input),
    ) else {
        return failed();
    };
    let Some(item) = output.commitments.iter().find(|i| i.id == id) else {
        return error("not_found", "Commitment not found.", StatusCode::NOT_FOUND);
    };
    if !store::input_is_currently_authorized(pool, &session.account_id, &input)
        .await
        .unwrap_or(false)
    {
        return error(
            "source_unavailable",
            "Sources changed. Refresh before creating a task.",
            StatusCode::FORBIDDEN,
        );
    }
    if request.owner_account_id.as_ref().is_some_and(|owner| {
        owner != &session.account_id
            && !input.sources.iter().any(|s| {
                !s.is_agent && &s.sender_account_id == owner && item.source_ids.contains(&s.id)
            })
    }) {
        return error(
            "invalid_owner",
            "Choose a related contact.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(source) = input
        .sources
        .iter()
        .find(|s| item.source_ids.contains(&s.id))
    else {
        return failed();
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(),
    };
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "digest-task:{}:{}",
            session.account_id, source.session_id
        ))
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return failed();
    }
    let existing:Option<(String,)>=match query_as("SELECT task_id FROM cloud_session_tasks WHERE session_id=$1 AND archived_at IS NULL AND (task_id=$2 OR LOWER(TRIM(title))=LOWER(TRIM($3))) LIMIT 1").bind(&source.session_id).bind(&item.existing_task_id).bind(&request.title).fetch_optional(&mut *tx).await{Ok(v)=>v,Err(_)=>return failed()};
    let task_id = existing
        .map(|v| v.0)
        .unwrap_or_else(|| format!("digest-task:{}:{}", session.account_id, id));
    if query("INSERT INTO cloud_session_tasks(task_activity_id,session_id,task_id,title,status,created_by_account_id,target_account_id,participants_json,created_at,updated_at,summary) VALUES($1,$2,$1,$3,'pending',$4,$5,'[]',$6,$6,$7) ON CONFLICT DO NOTHING").bind(&task_id).bind(&source.session_id).bind(request.title.trim()).bind(&session.account_id).bind(&request.owner_account_id).bind(chrono::Utc::now().to_rfc3339()).bind(request.due_at.as_ref().map(|date|format!("Due {date}"))).execute(&mut *tx).await.is_err(){return failed();}
    if query("INSERT INTO cloud_digest_feedback(account_id,item_id,status,task_id) VALUES($1,$2,'task',$3) ON CONFLICT(account_id,item_id) DO UPDATE SET status='task',task_id=$3").bind(&session.account_id).bind(id).bind(&task_id).execute(&mut *tx).await.is_err(){return failed();}
    match tx.commit().await {
        Ok(()) => Json(json!({"taskId":task_id})).into_response(),
        Err(_) => failed(),
    }
}
