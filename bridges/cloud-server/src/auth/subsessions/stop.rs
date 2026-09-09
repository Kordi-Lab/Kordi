use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StopRequest {
    // Match the execution the user saw, not a follow-up that started later.
    expected_started_at_ms: Option<i64>,
}

pub(super) async fn stop(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Json(request): Json<StopRequest>,
) -> Result<Json<Snapshot>, ApiError> {
    let pool = state.db_pool();
    let mut tx = pool.begin().await.map_err(db_error)?;
    // Share the admission/publishing lock so Stop cannot race a new execution.
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let current: Option<(String, Option<i64>)> = query_as(
        "SELECT s.status,(extract(epoch FROM s.execution_started_at)*1000)::bigint \
         FROM cloud_agent_subsessions s JOIN cloud_chat_conversation_members m \
         ON m.conversation_id=s.parent_conversation_id AND m.account_id=$2 AND m.membership_state='active' \
         WHERE s.subsession_id=$1 AND s.owner_account_id=$2 FOR UPDATE OF s"
    ).bind(id).bind(&session.account_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let (status, started) =
        current.ok_or_else(|| error(StatusCode::NOT_FOUND, "subsession_not_found"))?;
    if status == "running" {
        if started != request.expected_started_at_ms {
            return Err(error(StatusCode::CONFLICT, "subsession_execution_changed"));
        }
        // Revoke current and already queued work. A later explicit follow-up
        // can still start a new execution; old workers cannot renew or publish.
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled',completed_at=now()::text,updated_at=now()::text \
               WHERE status IN ('queued','leased','running') AND (subsession_id=$1 OR run_id IN \
               (SELECT run_id FROM cloud_agent_subsession_chat WHERE subsession_id=$1))")
            .bind(id).execute(&mut *tx).await.map_err(db_error)?;
        query("UPDATE cloud_agent_subsessions SET status='stopped',execution_finished_at=now(),version=version+1,updated_at=now() WHERE subsession_id=$1")
            .bind(id).execute(&mut *tx).await.map_err(db_error)?;
    }
    tx.commit().await.map_err(db_error)?;
    snapshot(pool, id, &session.account_id, true)
        .await
        .map(Json)
}
