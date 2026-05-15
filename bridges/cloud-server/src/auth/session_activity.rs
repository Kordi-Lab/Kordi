use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const CLOUD_ACTIVITY_CLIENT_UPDATED_AT_FUTURE_SKEW_SECONDS: i64 = 300;

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v1/cloud/session-activity", get(list_cloud_session_activity))
        .route("/v1/cloud/session-activity/tasks", post(upsert_cloud_task_activity))
        .route(
            "/v1/cloud/session-activity/artifacts",
            post(upsert_cloud_artifact_activity),
        )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskActivitySummary {
    task_activity_id: String,
    session_id: String,
    task_id: String,
    title: String,
    summary: Option<String>,
    status: String,
    created_by_account_id: String,
    target_account_id: Option<String>,
    participants: Vec<serde_json::Value>,
    artifact_ids: Vec<String>,
    response_message_id: Option<String>,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudArtifactActivitySummary {
    artifact_activity_id: String,
    session_id: String,
    artifact_id: String,
    name: String,
    path: String,
    kind: String,
    category: String,
    summary: Option<String>,
    created_by_account_id: String,
    source_message_id: Option<String>,
    attachment_id: Option<String>,
    content_type: Option<String>,
    size_bytes: Option<i64>,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertCloudTaskActivityRequest {
    session_id: String,
    task_id: String,
    title: String,
    summary: Option<String>,
    status: String,
    target_account_id: Option<String>,
    #[serde(default)]
    participant_account_ids: Vec<String>,
    #[serde(default)]
    participants: Vec<serde_json::Value>,
    #[serde(default)]
    artifact_ids: Vec<String>,
    response_message_id: Option<String>,
    client_updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertCloudArtifactActivityRequest {
    session_id: String,
    artifact_id: String,
    name: String,
    path: String,
    kind: String,
    category: String,
    summary: Option<String>,
    #[serde(default)]
    participant_account_ids: Vec<String>,
    source_message_id: Option<String>,
    attachment_id: Option<String>,
    content_type: Option<String>,
    size_bytes: Option<i64>,
    client_updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCloudSessionActivityQuery {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskActivityResponse {
    task: CloudTaskActivitySummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudArtifactActivityResponse {
    artifact: CloudArtifactActivitySummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudSessionActivityResponse {
    tasks: Vec<CloudTaskActivitySummary>,
    artifacts: Vec<CloudArtifactActivitySummary>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: String,
}

fn err(code: &'static str, message: impl Into<String>, status: StatusCode) -> Response {
    let body = ErrorBody {
        error_code: code,
        message: message.into(),
    };
    (status, Json(body)).into_response()
}

async fn append_cloud_sync_event(
    pool: &PgPool,
    account_id: &str,
    event_type: &str,
    peer_account_id: Option<&str>,
    message_id: Option<&str>,
    payload: serde_json::Value,
    occurred_at: &str,
) -> Result<(), sqlx_core::error::Error> {
    query(
        "INSERT INTO cloud_sync_events \
         (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(account_id)
    .bind(event_type)
    .bind(peer_account_id)
    .bind(message_id)
    .bind(payload)
    .bind(occurred_at)
    .execute(pool)
    .await?;
    Ok(())
}

fn task_activity_sync_payload(task: &CloudTaskActivitySummary) -> serde_json::Value {
    serde_json::json!({ "task": task })
}

fn artifact_activity_sync_payload(artifact: &CloudArtifactActivitySummary) -> serde_json::Value {
    serde_json::json!({ "artifact": artifact })
}

fn cloud_activity_recipient_ids(owner_account_id: &str, participant_account_ids: &[String]) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for value in participant_account_ids {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            ids.insert(trimmed.to_string());
        }
    }
    let owner = owner_account_id.trim();
    if !owner.is_empty() {
        ids.insert(owner.to_string());
    }
    ids.into_iter().collect()
}

fn clean_optional_activity_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(512).collect::<String>())
}

fn clean_required_activity_text(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect::<String>())
}

fn cloud_activity_effective_updated_at(client_updated_at: Option<&str>, now: DateTime<Utc>) -> String {
    let Some(raw) = client_updated_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return now.to_rfc3339();
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(raw) else {
        return now.to_rfc3339();
    };
    let parsed_utc = parsed.with_timezone(&Utc);
    if parsed_utc > now + ChronoDuration::seconds(CLOUD_ACTIVITY_CLIENT_UPDATED_AT_FUTURE_SKEW_SECONDS) {
        return now.to_rfc3339();
    }
    parsed_utc.to_rfc3339()
}

fn json_string_array(value: serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn json_array(value: serde_json::Value) -> Vec<serde_json::Value> {
    value.as_array().cloned().unwrap_or_default()
}

type TaskRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    serde_json::Value,
    serde_json::Value,
    Option<String>,
    String,
    String,
    Option<String>,
);

type ArtifactRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    String,
    String,
    Option<String>,
);

fn task_summary_from_row(row: TaskRow) -> CloudTaskActivitySummary {
    let (
        task_activity_id,
        session_id,
        task_id,
        title,
        summary,
        status,
        created_by_account_id,
        target_account_id,
        participants_json,
        artifact_ids_json,
        response_message_id,
        created_at,
        updated_at,
        archived_at,
    ) = row;
    CloudTaskActivitySummary {
        task_activity_id,
        session_id,
        task_id,
        title,
        summary,
        status,
        created_by_account_id,
        target_account_id,
        participants: json_array(participants_json),
        artifact_ids: json_string_array(artifact_ids_json),
        response_message_id,
        created_at,
        updated_at,
        archived_at,
    }
}

fn artifact_summary_from_row(row: ArtifactRow) -> CloudArtifactActivitySummary {
    let (
        artifact_activity_id,
        session_id,
        artifact_id,
        name,
        path,
        kind,
        category,
        summary,
        created_by_account_id,
        source_message_id,
        attachment_id,
        content_type,
        size_bytes,
        created_at,
        updated_at,
        archived_at,
    ) = row;
    CloudArtifactActivitySummary {
        artifact_activity_id,
        session_id,
        artifact_id,
        name,
        path,
        kind,
        category,
        summary,
        created_by_account_id,
        source_message_id,
        attachment_id,
        content_type,
        size_bytes,
        created_at,
        updated_at,
        archived_at,
    }
}

async fn fetch_cloud_task_activity(
    pool: &PgPool,
    session_id: &str,
    task_id: &str,
) -> Result<Option<CloudTaskActivitySummary>, sqlx_core::error::Error> {
    let row: Option<TaskRow> = query_as(
        "SELECT task_activity_id, session_id, task_id, title, summary, status, \
                created_by_account_id, target_account_id, participants_json, artifact_ids_json, \
                response_message_id, created_at, updated_at, archived_at \
         FROM cloud_session_tasks WHERE session_id = $1 AND task_id = $2",
    )
    .bind(session_id)
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(task_summary_from_row))
}

async fn fetch_cloud_artifact_activity(
    pool: &PgPool,
    session_id: &str,
    artifact_id: &str,
) -> Result<Option<CloudArtifactActivitySummary>, sqlx_core::error::Error> {
    let row: Option<ArtifactRow> = query_as(
        "SELECT artifact_activity_id, session_id, artifact_id, name, path, kind, category, \
                summary, created_by_account_id, source_message_id, attachment_id, content_type, \
                size_bytes, created_at, updated_at, archived_at \
         FROM cloud_session_artifacts WHERE session_id = $1 AND artifact_id = $2",
    )
    .bind(session_id)
    .bind(artifact_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(artifact_summary_from_row))
}

async fn upsert_cloud_task_activity(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpsertCloudTaskActivityRequest>,
) -> Response {
    let Some(session_id) = clean_required_activity_text(&req.session_id, 256) else {
        return err("invalid_session_activity", "sessionId is required.", StatusCode::BAD_REQUEST);
    };
    let Some(task_id) = clean_required_activity_text(&req.task_id, 256) else {
        return err("invalid_session_activity", "taskId is required.", StatusCode::BAD_REQUEST);
    };
    let Some(title) = clean_required_activity_text(&req.title, 512) else {
        return err("invalid_session_activity", "title is required.", StatusCode::BAD_REQUEST);
    };
    let Some(status) = clean_required_activity_text(&req.status, 64) else {
        return err("invalid_session_activity", "status is required.", StatusCode::BAD_REQUEST);
    };

    let updated_at = cloud_activity_effective_updated_at(req.client_updated_at.as_deref(), Utc::now());
    let task_activity_id = format!("taskact_{}", uuid::Uuid::new_v4().simple());
    let participants_json = serde_json::Value::Array(req.participants.clone());
    let artifact_ids_json = serde_json::Value::Array(
        req.artifact_ids
            .iter()
            .map(|value| serde_json::Value::String(value.trim().to_string()))
            .collect(),
    );
    let pool = state.db_pool();
    if query(
        "INSERT INTO cloud_session_tasks \
         (task_activity_id, session_id, task_id, title, summary, status, created_by_account_id, \
          target_account_id, participants_json, artifact_ids_json, response_message_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) \
         ON CONFLICT (session_id, task_id) DO UPDATE SET \
           title = EXCLUDED.title, summary = EXCLUDED.summary, status = EXCLUDED.status, \
           target_account_id = EXCLUDED.target_account_id, participants_json = EXCLUDED.participants_json, \
           artifact_ids_json = EXCLUDED.artifact_ids_json, response_message_id = EXCLUDED.response_message_id, \
           updated_at = EXCLUDED.updated_at, archived_at = NULL \
         WHERE cloud_session_tasks.updated_at <= EXCLUDED.updated_at",
    )
    .bind(&task_activity_id)
    .bind(&session_id)
    .bind(&task_id)
    .bind(&title)
    .bind(clean_optional_activity_text(req.summary.as_deref()))
    .bind(&status)
    .bind(&session.account_id)
    .bind(clean_optional_activity_text(req.target_account_id.as_deref()))
    .bind(participants_json)
    .bind(artifact_ids_json)
    .bind(clean_optional_activity_text(req.response_message_id.as_deref()))
    .bind(&updated_at)
    .execute(pool)
    .await
    .is_err()
    {
        return err("server_error", "Could not record task activity.", StatusCode::INTERNAL_SERVER_ERROR);
    }

    let task = match fetch_cloud_task_activity(pool, &session_id, &task_id).await {
        Ok(Some(task)) => task,
        _ => return err("server_error", "Could not fetch task activity.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    for recipient in cloud_activity_recipient_ids(&session.account_id, &req.participant_account_ids) {
        let _ = append_cloud_sync_event(
            pool,
            &recipient,
            "task.upsert",
            None,
            None,
            task_activity_sync_payload(&task),
            &updated_at,
        )
        .await;
    }

    (StatusCode::OK, Json(CloudTaskActivityResponse { task })).into_response()
}

async fn upsert_cloud_artifact_activity(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpsertCloudArtifactActivityRequest>,
) -> Response {
    let Some(session_id) = clean_required_activity_text(&req.session_id, 256) else {
        return err("invalid_session_activity", "sessionId is required.", StatusCode::BAD_REQUEST);
    };
    let Some(artifact_id) = clean_required_activity_text(&req.artifact_id, 512) else {
        return err("invalid_session_activity", "artifactId is required.", StatusCode::BAD_REQUEST);
    };
    let Some(name) = clean_required_activity_text(&req.name, 255) else {
        return err("invalid_session_activity", "name is required.", StatusCode::BAD_REQUEST);
    };
    let Some(path) = clean_required_activity_text(&req.path, 1024) else {
        return err("invalid_session_activity", "path is required.", StatusCode::BAD_REQUEST);
    };
    let Some(kind) = clean_required_activity_text(&req.kind, 64) else {
        return err("invalid_session_activity", "kind is required.", StatusCode::BAD_REQUEST);
    };
    let Some(category) = clean_required_activity_text(&req.category, 64) else {
        return err("invalid_session_activity", "category is required.", StatusCode::BAD_REQUEST);
    };

    let updated_at = cloud_activity_effective_updated_at(req.client_updated_at.as_deref(), Utc::now());
    let artifact_activity_id = format!("artifactact_{}", uuid::Uuid::new_v4().simple());
    let pool = state.db_pool();
    if query(
        "INSERT INTO cloud_session_artifacts \
         (artifact_activity_id, session_id, artifact_id, name, path, kind, category, summary, \
          created_by_account_id, source_message_id, attachment_id, content_type, size_bytes, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) \
         ON CONFLICT (session_id, artifact_id) DO UPDATE SET \
           name = EXCLUDED.name, path = EXCLUDED.path, kind = EXCLUDED.kind, category = EXCLUDED.category, \
           summary = EXCLUDED.summary, source_message_id = EXCLUDED.source_message_id, \
           attachment_id = EXCLUDED.attachment_id, content_type = EXCLUDED.content_type, \
           size_bytes = EXCLUDED.size_bytes, updated_at = EXCLUDED.updated_at, archived_at = NULL \
         WHERE cloud_session_artifacts.updated_at <= EXCLUDED.updated_at",
    )
    .bind(&artifact_activity_id)
    .bind(&session_id)
    .bind(&artifact_id)
    .bind(&name)
    .bind(&path)
    .bind(&kind)
    .bind(&category)
    .bind(clean_optional_activity_text(req.summary.as_deref()))
    .bind(&session.account_id)
    .bind(clean_optional_activity_text(req.source_message_id.as_deref()))
    .bind(clean_optional_activity_text(req.attachment_id.as_deref()))
    .bind(clean_optional_activity_text(req.content_type.as_deref()))
    .bind(req.size_bytes)
    .bind(&updated_at)
    .execute(pool)
    .await
    .is_err()
    {
        return err("server_error", "Could not record artifact activity.", StatusCode::INTERNAL_SERVER_ERROR);
    }

    let artifact = match fetch_cloud_artifact_activity(pool, &session_id, &artifact_id).await {
        Ok(Some(artifact)) => artifact,
        _ => return err("server_error", "Could not fetch artifact activity.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    for recipient in cloud_activity_recipient_ids(&session.account_id, &req.participant_account_ids) {
        let _ = append_cloud_sync_event(
            pool,
            &recipient,
            "artifact.upsert",
            None,
            None,
            artifact_activity_sync_payload(&artifact),
            &updated_at,
        )
        .await;
    }

    (StatusCode::OK, Json(CloudArtifactActivityResponse { artifact })).into_response()
}

async fn list_cloud_session_activity(
    State(state): State<Arc<ServerState>>,
    Extension(_session): Extension<CloudSession>,
    Query(q): Query<ListCloudSessionActivityQuery>,
) -> Response {
    let Some(session_id) = clean_required_activity_text(&q.session_id, 256) else {
        return err("invalid_session_activity", "sessionId is required.", StatusCode::BAD_REQUEST);
    };
    let pool = state.db_pool();
    let task_rows: Vec<TaskRow> = match query_as(
        "SELECT task_activity_id, session_id, task_id, title, summary, status, \
                created_by_account_id, target_account_id, participants_json, artifact_ids_json, \
                response_message_id, created_at, updated_at, archived_at \
         FROM cloud_session_tasks WHERE session_id = $1 AND archived_at IS NULL \
         ORDER BY updated_at ASC, task_id ASC",
    )
    .bind(&session_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return err("server_error", "Could not list task activity.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let artifact_rows: Vec<ArtifactRow> = match query_as(
        "SELECT artifact_activity_id, session_id, artifact_id, name, path, kind, category, \
                summary, created_by_account_id, source_message_id, attachment_id, content_type, \
                size_bytes, created_at, updated_at, archived_at \
         FROM cloud_session_artifacts WHERE session_id = $1 AND archived_at IS NULL \
         ORDER BY updated_at ASC, artifact_id ASC",
    )
    .bind(&session_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return err("server_error", "Could not list artifact activity.", StatusCode::INTERNAL_SERVER_ERROR),
    };

    Json(CloudSessionActivityResponse {
        tasks: task_rows.into_iter().map(task_summary_from_row).collect(),
        artifacts: artifact_rows.into_iter().map(artifact_summary_from_row).collect(),
    })
    .into_response()
}

pub async fn copy_cloud_session_activity_to_fork(
    pool: &PgPool,
    parent_session_id: &str,
    fork_session_id: &str,
    updated_at: &str,
) -> Result<(), sqlx_core::error::Error> {
    let task_rows: Vec<CloudTaskActivitySummary> = query_as::<_, TaskRow>(
        "SELECT task_activity_id, session_id, task_id, title, summary, status, \
                created_by_account_id, target_account_id, participants_json, artifact_ids_json, \
                response_message_id, created_at, updated_at, archived_at \
         FROM cloud_session_tasks WHERE session_id = $1 AND archived_at IS NULL",
    )
    .bind(parent_session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(task_summary_from_row)
    .collect();
    for task in task_rows {
        query(
            "INSERT INTO cloud_session_tasks \
             (task_activity_id, session_id, task_id, title, summary, status, created_by_account_id, \
              target_account_id, participants_json, artifact_ids_json, response_message_id, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             ON CONFLICT (session_id, task_id) DO NOTHING",
        )
        .bind(format!("taskact_{}", uuid::Uuid::new_v4().simple()))
        .bind(fork_session_id)
        .bind(&task.task_id)
        .bind(&task.title)
        .bind(&task.summary)
        .bind(&task.status)
        .bind(&task.created_by_account_id)
        .bind(&task.target_account_id)
        .bind(serde_json::Value::Array(task.participants.clone()))
        .bind(serde_json::Value::Array(task.artifact_ids.iter().cloned().map(serde_json::Value::String).collect()))
        .bind(&task.response_message_id)
        .bind(&task.created_at)
        .bind(updated_at)
        .execute(pool)
        .await?;
    }

    let artifact_rows: Vec<CloudArtifactActivitySummary> = query_as::<_, ArtifactRow>(
        "SELECT artifact_activity_id, session_id, artifact_id, name, path, kind, category, \
                summary, created_by_account_id, source_message_id, attachment_id, content_type, \
                size_bytes, created_at, updated_at, archived_at \
         FROM cloud_session_artifacts WHERE session_id = $1 AND archived_at IS NULL",
    )
    .bind(parent_session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(artifact_summary_from_row)
    .collect();
    for artifact in artifact_rows {
        query(
            "INSERT INTO cloud_session_artifacts \
             (artifact_activity_id, session_id, artifact_id, name, path, kind, category, summary, \
              created_by_account_id, source_message_id, attachment_id, content_type, size_bytes, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
             ON CONFLICT (session_id, artifact_id) DO NOTHING",
        )
        .bind(format!("artifactact_{}", uuid::Uuid::new_v4().simple()))
        .bind(fork_session_id)
        .bind(&artifact.artifact_id)
        .bind(&artifact.name)
        .bind(&artifact.path)
        .bind(&artifact.kind)
        .bind(&artifact.category)
        .bind(&artifact.summary)
        .bind(&artifact.created_by_account_id)
        .bind(&artifact.source_message_id)
        .bind(&artifact.attachment_id)
        .bind(&artifact.content_type)
        .bind(artifact.size_bytes)
        .bind(&artifact.created_at)
        .bind(updated_at)
        .execute(pool)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_activity_sync_payload_keeps_session_and_task_identity() {
        let task = CloudTaskActivitySummary {
            task_activity_id: "taskact_1".to_string(),
            session_id: "session:group:one".to_string(),
            task_id: "task_1".to_string(),
            title: "Review launch plan".to_string(),
            summary: Some("Check risks".to_string()),
            status: "active".to_string(),
            created_by_account_id: "acct_a".to_string(),
            target_account_id: Some("acct_b".to_string()),
            participants: vec![serde_json::json!({"accountId":"acct_a","displayName":"Alice"})],
            artifact_ids: vec!["docs/plan.md".to_string()],
            response_message_id: Some("msg_response".to_string()),
            created_at: "2026-05-15T10:00:00Z".to_string(),
            updated_at: "2026-05-15T10:01:00Z".to_string(),
            archived_at: None,
        };

        let payload = task_activity_sync_payload(&task);

        assert_eq!(payload["task"]["sessionId"], "session:group:one");
        assert_eq!(payload["task"]["taskId"], "task_1");
        assert_eq!(payload["task"]["artifactIds"][0], "docs/plan.md");
    }

    #[test]
    fn artifact_activity_sync_payload_keeps_attachment_reference() {
        let artifact = CloudArtifactActivitySummary {
            artifact_activity_id: "artifactact_1".to_string(),
            session_id: "session:group:one".to_string(),
            artifact_id: "docs/plan.md".to_string(),
            name: "plan.md".to_string(),
            path: "docs/plan.md".to_string(),
            kind: "document".to_string(),
            category: "artifact".to_string(),
            summary: Some("Generated plan".to_string()),
            created_by_account_id: "acct_a".to_string(),
            source_message_id: Some("msg_response".to_string()),
            attachment_id: Some("att_1".to_string()),
            content_type: Some("text/markdown".to_string()),
            size_bytes: Some(42),
            created_at: "2026-05-15T10:00:00Z".to_string(),
            updated_at: "2026-05-15T10:01:00Z".to_string(),
            archived_at: None,
        };

        let payload = artifact_activity_sync_payload(&artifact);

        assert_eq!(payload["artifact"]["sessionId"], "session:group:one");
        assert_eq!(payload["artifact"]["artifactId"], "docs/plan.md");
        assert_eq!(payload["artifact"]["attachmentId"], "att_1");
    }

    #[test]
    fn cloud_activity_recipient_ids_exclude_duplicates_and_empty_values() {
        let recipients = cloud_activity_recipient_ids(
            "acct_owner",
            &["acct_b".to_string(), "acct_owner".to_string(), " ".to_string(), "acct_b".to_string()],
        );

        assert_eq!(recipients, vec!["acct_b".to_string(), "acct_owner".to_string()]);
    }
}
