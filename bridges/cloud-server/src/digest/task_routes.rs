//! Creating a task from a digest commitment.

use super::{models::*, routes::failed, store};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use sqlx_core::{query::query, query_as::query_as};
use std::sync::Arc;

use super::routes::error;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskInput {
    title: String,
    owner_account_id: Option<String>,
    due_at: Option<String>,
}
pub(super) async fn task(
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
