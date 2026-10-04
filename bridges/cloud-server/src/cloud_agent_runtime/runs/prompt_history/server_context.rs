//! Server-built history for desktop executors that implement context
//! contract 2. It is the same admitted, bounded history the cloud prompt uses,
//! so a run sees the same messages wherever it executes.

use serde::Serialize;

use super::super::speakers::{visible_message, SpeakerDirectory};
use super::{action_context_suffix, claim_context, history_payload};
use crate::cloud_agent_runtime::runs::{ClaimRunRequest, RunResult};

/// The longest history line handed to a desktop executor, in characters.
const MAX_SERVER_CONTEXT_TEXT_CHARS: usize = 800;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerContextMessage {
    pub(crate) id: String,
    pub(crate) author_name: String,
    /// `human` or `agent`, from the stored sender.
    pub(crate) author_kind: String,
    pub(crate) text: String,
    pub(crate) created_at_ms: i64,
}

/// The history, oldest first, that a claimed run may use. The current
/// request itself is not included; the executor already holds it.
pub(crate) async fn context_history_for_claim(
    pool: &sqlx_postgres::PgPool,
    input: &ClaimRunRequest,
) -> RunResult<Vec<ServerContextMessage>> {
    let context = claim_context(pool, input).await?;
    let speakers = SpeakerDirectory::load(
        pool,
        context.history.iter().map(|&index| {
            let row = &context.rows[index];
            (row.2.as_str(), row.3.as_str())
        }),
    )
    .await?;
    let preview_allowed = |id: &str| context.preview_allowed(id);
    Ok(context
        .history
        .iter()
        .filter_map(|&index| {
            let (id, _, sender, body) = &context.rows[index];
            let (author_name, author_kind, text) = visible_message(&speakers, sender, body)?;
            let action =
                history_payload(body).and_then(|value| value.get("messageAction").cloned());
            let suffix = action_context_suffix(action.as_ref(), &preview_allowed);
            let text = format!("{}{suffix}", text.trim());
            if text.is_empty() {
                return None;
            }
            Some(ServerContextMessage {
                id: id.clone(),
                author_name,
                author_kind,
                text: text.chars().take(MAX_SERVER_CONTEXT_TEXT_CHARS).collect(),
                created_at_ms: context.created_at_ms[index],
            })
        })
        .collect())
}
