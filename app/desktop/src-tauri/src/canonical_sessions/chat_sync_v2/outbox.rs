use super::*;

pub(super) fn clean_outbox_key(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 {
        return Err(format!("Chat sync v2 {label} is invalid"));
    }
    Ok(value.to_string())
}

pub(super) fn enqueue_outbox(request: ChatSyncV2OutboxEnqueueRequest) -> Result<(), String> {
    let account_id = clean_outbox_key(&request.account_id, "account id")?;
    let operation_id = clean_outbox_key(&request.operation_id, "operation id")?;
    let payload_json =
        serde_json::to_string(&request.payload).map_err(|error| error.to_string())?;
    if payload_json.len() > 2 * 1024 * 1024 {
        return Err("Chat sync v2 pending operation is too large".to_string());
    }
    let conn = open_db()?;
    let existing: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM chat_sync_v2_pending_operations
             WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing) = existing {
        if existing != payload_json {
            return Err("IDEMPOTENCY_KEY_REUSED: pending operation payload changed".to_string());
        }
        return Ok(());
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO chat_sync_v2_pending_operations
         (account_id, operation_id, operation_kind, payload_json, status,
          attempt_count, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, 'send_message', ?3, 'pending', 0, 0, ?4, ?4)",
        params![account_id, operation_id, payload_json, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn list_due_outbox(account_id: &str) -> Result<Vec<ChatSyncV2PendingOperation>, String> {
    let account_id = clean_outbox_key(account_id, "account id")?;
    let conn = open_db()?;
    let mut statement = conn
        .prepare(
            "SELECT operation_id, payload_json, attempt_count, next_attempt_at_ms, last_error
             FROM chat_sync_v2_pending_operations
             WHERE account_id = ?1 AND status = 'pending' AND next_attempt_at_ms <= ?2
             ORDER BY created_at_ms ASC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id, now_ms()], |row| {
            let payload_json: String = row.get(1)?;
            let payload = serde_json::from_str(&payload_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    payload_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(ChatSyncV2PendingOperation {
                account_id: account_id.clone(),
                operation_id: row.get(0)?,
                payload,
                attempt_count: row.get(2)?,
                next_attempt_at_ms: row.get(3)?,
                last_error: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub(super) fn record_outbox_failure(request: ChatSyncV2OutboxFailureRequest) -> Result<(), String> {
    let account_id = clean_outbox_key(&request.account_id, "account id")?;
    let operation_id = clean_outbox_key(&request.operation_id, "operation id")?;
    let conn = open_db()?;
    let attempts: i64 = conn
        .query_row(
            "SELECT attempt_count FROM chat_sync_v2_pending_operations
             WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    let delay_ms = [1_000_i64, 2_000, 5_000, 15_000, 30_000, 60_000]
        .get(attempts.min(5) as usize)
        .copied()
        .unwrap_or(60_000);
    conn.execute(
        "UPDATE chat_sync_v2_pending_operations
         SET status = ?1, attempt_count = attempt_count + 1,
             next_attempt_at_ms = ?2, last_error = ?3, updated_at_ms = ?4
         WHERE account_id = ?5 AND operation_id = ?6",
        params![
            if request.retryable {
                "pending"
            } else {
                "failed"
            },
            now_ms() + delay_ms,
            request.error.chars().take(1_000).collect::<String>(),
            now_ms(),
            account_id,
            operation_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
