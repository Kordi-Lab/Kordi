use sqlx_core::query::query;
use sqlx_postgres::PgPool;

pub(super) struct CloudAgentResponseSyncEvent<'a> {
    pub account_id: &'a str,
    pub peer_account_id: &'a str,
    pub message_id: &'a str,
    pub from_account_id: &'a str,
    pub to_account_id: &'a str,
    pub body: &'a str,
    pub session_id: &'a str,
    pub created_at: &'a str,
    pub direction: &'a str,
}

pub(super) async fn append_cloud_agent_response_sync_event(
    pool: &PgPool,
    event: CloudAgentResponseSyncEvent<'_>,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_sync_events \
         (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
         VALUES ($1, 'message.upsert', $2, $3, $4, $5)",
    )
    .bind(event.account_id)
    .bind(event.peer_account_id)
    .bind(event.message_id)
    .bind(serde_json::json!({
        "sessionId": event.session_id,
        "message": {
            "messageId": event.message_id,
            "fromAccountId": event.from_account_id,
            "toAccountId": event.to_account_id,
            "body": event.body,
            "sessionId": event.session_id,
            "createdAt": event.created_at,
            "deliveredAt": event.created_at,
            "readAt": null,
            "direction": event.direction,
            "attachments": [],
        }
    }))
    .bind(event.created_at)
    .execute(pool)
    .await?;
    Ok(())
}
