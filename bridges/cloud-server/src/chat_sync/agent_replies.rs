//! What the chat store does to an agent's reply before storing it: keep the
//! owner's local paths out of replies other people read, and let a background
//! task's follow-up reply carry the documents its task created (issue 1808).

use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;

pub(crate) async fn prepare_agent_reply(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    request: &mut SendMessageRequest,
) -> Result<(), sqlx_core::Error> {
    super::local_paths::strip_shared_agent_reply(
        transaction,
        conversation_id,
        &mut request.content,
    )
    .await?;
    crate::document_shares::agents::create::reply::attach_follow_up_documents(
        transaction,
        account_id,
        conversation_id,
        request,
    )
    .await
}
