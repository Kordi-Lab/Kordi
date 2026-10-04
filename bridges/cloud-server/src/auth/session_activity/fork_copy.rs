//! Copies a parent session's task and artifact activity into a new fork.
//!
//! The fork route copies only into an id that is the forker's own
//! (`auth/routes/session_forks/target.rs`). A fork id that already holds
//! activity keeps it as it is: copying never adds rows next to rows that are
//! already there.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{
    artifact_summary_from_row, task_summary_from_row, ArtifactRow, CloudArtifactActivitySummary,
    CloudTaskActivitySummary, TaskRow,
};

pub async fn copy_cloud_session_activity_to_fork(
    pool: &PgPool,
    parent_session_id: &str,
    fork_session_id: &str,
    updated_at: &str,
) -> Result<(), sqlx_core::error::Error> {
    let (occupied,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_session_tasks WHERE session_id = $1) \
             OR EXISTS (SELECT 1 FROM cloud_session_artifacts WHERE session_id = $1)",
    )
    .bind(fork_session_id)
    .fetch_one(pool)
    .await?;
    if occupied {
        return Ok(());
    }
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
