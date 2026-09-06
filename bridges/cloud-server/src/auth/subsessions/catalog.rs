//! Parent-scoped execution entries; never derived from message titles or forks.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListQuery {
    parent_session_id: String,
    after: Option<Uuid>,
}

pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(options): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let pool = state.db_pool();
    let parent = conversation_id_for_session(pool, &session.account_id, &options.parent_session_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "session_not_found"))?;
    let rows: Vec<(Uuid, Value)> = query_as(
        "SELECT s.subsession_id,jsonb_build_object(
            'sessionId',s.subsession_id,'parentSessionId',s.parent_session_id,'parentRequestId',s.parent_request_id,
            'agentId',s.agent_id,'ownerAccountId',s.owner_account_id,'ownerDisplayName',a.display_name,
            'agentDisplayName',CASE WHEN s.agent_id='cloud-agent:'||s.owner_account_id AND COALESCE(p.display_name,'Kordi') IN ('Kordi','My Kordi') THEN a.display_name||'''s Kordi' ELSE COALESCE(d.name,p.display_name,'Kordi') END,
            'agentAvatarUrl',CASE WHEN s.agent_id='cloud-agent:'||s.owner_account_id THEN p.avatar_url ELSE d.avatar_url END,
            'title',s.title,'status',s.status,'executionBackend',s.execution_backend,
            'startedAtMs',(extract(epoch FROM s.execution_started_at)*1000)::bigint,
            'finishedAtMs',(extract(epoch FROM s.execution_finished_at)*1000)::bigint,
            'heartbeatAtMs',(extract(epoch FROM s.heartbeat_at)*1000)::bigint,
            'queued',EXISTS(SELECT 1 FROM cloud_agent_fallback_runs r WHERE r.subsession_id=s.subsession_id AND r.status IN ('queued','leased')),
            'live',s.status='running' AND (s.execution_backend='desktop' AND s.heartbeat_at>now()-interval '45 seconds' OR EXISTS(SELECT 1 FROM cloud_agent_fallback_runs r WHERE r.subsession_id=s.subsession_id AND r.status='running' AND r.lease_expires_at::timestamptz>now())))
         FROM cloud_agent_subsessions s
         JOIN cloud_chat_conversation_members m ON m.conversation_id=s.parent_conversation_id AND m.account_id=$2 AND m.membership_state='active'
         JOIN cloud_accounts a ON a.account_id=s.owner_account_id
         LEFT JOIN cloud_default_agent_profiles p ON p.owner_account_id=s.owner_account_id
         LEFT JOIN cloud_agent_definitions d ON d.agent_id=s.agent_id AND d.owner_account_id=s.owner_account_id
         WHERE s.parent_conversation_id=$1 AND ($3::uuid IS NULL OR s.subsession_id>$3)
         ORDER BY s.subsession_id LIMIT 101"
    ).bind(parent).bind(&session.account_id).bind(options.after).fetch_all(pool).await.map_err(db_error)?;
    let next = (rows.len() > 100).then(|| rows[99].0);
    Ok(Json(
        json!({"sessions":rows.into_iter().take(100).map(|(_, row)|row).collect::<Vec<_>>(),"nextCursor":next}),
    ))
}
