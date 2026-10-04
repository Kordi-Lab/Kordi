//! Attachment rows a message may link.

use super::*;

/// Fails unless every id names a finalized attachment owned by the account
/// whose stored file has not been queued for deletion. The rows stay share
/// locked until the transaction ends, so a concurrent file removal waits for
/// this message's links before it checks what still references the file.
pub(super) async fn require_linkable_attachments(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    attachment_ids: &[String],
) -> Result<(), StoreError> {
    if attachment_ids.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String,)> = query_as(
        "SELECT attachment_id FROM cloud_attachments \
         WHERE attachment_id = ANY($1) AND owner_account_id = $2 \
           AND finalized_at IS NOT NULL AND purge_requested_at IS NULL \
         ORDER BY attachment_id FOR SHARE",
    )
    .bind(attachment_ids)
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != attachment_ids.len() {
        return Err(StoreError::InvalidInput(
            "one or more attachments are unavailable",
        ));
    }
    Ok(())
}
