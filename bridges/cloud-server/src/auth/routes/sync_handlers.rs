use super::*;

pub(super) async fn append_cloud_sync_event(
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

pub(super) async fn upsert_cloud_read_cursor(
    pool: &PgPool,
    account_id: &str,
    scope_kind: &str,
    scope_id: &str,
    read_at: &str,
) -> Result<(), sqlx_core::error::Error> {
    query(
        "INSERT INTO cloud_read_cursors \
         (account_id, scope_kind, scope_id, read_at, updated_at) \
         VALUES ($1, $2, $3, $4, $4) \
         ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET \
             read_at = CASE \
                 WHEN cloud_read_cursors.read_at < EXCLUDED.read_at THEN EXCLUDED.read_at \
                 ELSE cloud_read_cursors.read_at \
             END, \
             updated_at = EXCLUDED.updated_at",
    )
    .bind(account_id)
    .bind(scope_kind)
    .bind(scope_id)
    .bind(read_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// `GET /v1/cloud/sync?cursor=...&limit=...` — return account-scoped
/// ordered Cloud changes after the caller's last successfully applied cursor.
pub(super) async fn sync_cloud_events(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Query(q): axum::extract::Query<CloudSyncQuery>,
) -> Response {
    let cursor = q.cursor.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let fetch_limit = limit + 1;
    let rows: Vec<CloudSyncEventRow> = match query_as(
        "SELECT event_id, event_type, peer_account_id, message_id, payload_json, occurred_at \
             FROM cloud_sync_events \
             WHERE account_id = $1 AND event_id > $2 \
             ORDER BY event_id ASC \
             LIMIT $3",
    )
    .bind(&session.account_id)
    .bind(cursor)
    .bind(fetch_limit)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let has_more = rows.len() as i64 > limit;
    let events: Vec<CloudSyncEventSummary> = rows
        .into_iter()
        .take(limit as usize)
        .map(
            |(event_id, event_type, peer_account_id, message_id, payload, occurred_at)| {
                CloudSyncEventSummary {
                    event_id: event_id.to_string(),
                    event_type,
                    peer_account_id,
                    message_id,
                    payload,
                    occurred_at,
                }
            },
        )
        .collect();
    let next_cursor = events
        .last()
        .map(|event| event.event_id.clone())
        .unwrap_or_else(|| cursor.to_string());

    Json(CloudSyncResponse {
        cursor: next_cursor,
        has_more,
        events,
    })
    .into_response()
}
