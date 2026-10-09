//! Release of a request whose desktop turn ended without its lease.
//!
//! A desktop execution lease lives in the app's memory, so a reload or crash
//! loses it, and a network failure can lapse it mid-turn. The app reports each
//! such request, with the reply it ended with when it has one; the server ends
//! this device's run for it and publishes the terminal reply, so other devices
//! leave the `processing` state.
use super::*;
use crate::cloud_agent_runtime::runs::{self, terminal_backfill};

/// Bounds the partial text a desktop reports, as the progress route bounds
/// the whole reply.
const MAX_REPLY_TEXT_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::cloud_agent_runtime) struct InterruptedInput {
    session_id: String,
    request_message_id: String,
    /// How the run ended: `cancelled` (default), `failed`, or `completed`.
    #[serde(default)]
    state: Option<String>,
    /// The terminal reply, such as the text streamed before the turn ended.
    #[serde(default)]
    text: Option<String>,
    /// `stopped` or `interrupted` when `text` is a partial answer.
    #[serde(default)]
    ending: Option<String>,
}

fn bounded_text(text: &str) -> &str {
    if text.len() <= MAX_REPLY_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_REPLY_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Ends this device's run for a request and publishes its terminal reply
/// when the request has none. It needs no execution lease: a desktop that
/// lost its turn or its lease still closes the run at once.
pub(in crate::cloud_agent_runtime) async fn interrupted(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<InterruptedInput>,
) -> Response {
    let session_id = input.session_id.trim();
    let request_id = input.request_message_id.trim();
    let status = input.state.as_deref().map(str::trim).unwrap_or("cancelled");
    let ending = input
        .ending
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if session_id.is_empty()
        || request_id.is_empty()
        || !matches!(status, "cancelled" | "failed" | "completed")
        || !matches!(ending, None | Some("stopped" | "interrupted"))
    {
        return denied();
    }
    let text = input
        .text
        .as_deref()
        .map(bounded_text)
        .filter(|text| !text.trim().is_empty());
    let stopped = status == "cancelled"
        && (ending == Some("stopped") || text == Some(runs::stop::STOPPED_TEXT));
    let result = async {
        let request_id = match runs::request_identity(state.db_pool(), session_id, request_id).await? {
            Some((canonical, _)) => canonical,
            None => request_id.to_string(),
        };
        let run: Option<(String,)> = query_as(
            "SELECT run_id FROM cloud_agent_fallback_runs \
             WHERE owner_account_id = $1 AND session_id = $2 AND request_message_id = $3 \
               AND execution_backend = 'desktop' AND claimed_by LIKE $4 AND NOT legacy_duplicate \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&session.account_id)
        .bind(session_id)
        .bind(&request_id)
        .bind(format!("desktop:{}:%", session.device_id))
        .fetch_optional(state.db_pool())
        .await?;
        let Some((run_id,)) = run else {
            return Ok::<_, runs::RunError>(None);
        };
        // A user stop records the request, so the short notice reads as a stop.
        let closed = query(
            "UPDATE cloud_agent_fallback_runs SET status = $3, \
               error_code = CASE WHEN $4 OR $3 = 'completed' THEN error_code ELSE 'desktop_interrupted' END, \
               cancel_requested_at = CASE WHEN $4 THEN COALESCE(cancel_requested_at, now()) ELSE cancel_requested_at END, \
               completed_at = $2, updated_at = $2 WHERE run_id = $1 AND status IN ('leased', 'running')",
        )
        .bind(&run_id)
        .bind(Utc::now().to_rfc3339())
        .bind(status)
        .bind(stopped)
        .execute(state.db_pool())
        .await?
        .rows_affected()
            == 1;
        let reply = text.map(|text| terminal_backfill::TerminalReply { text, ending });
        let message_id =
            terminal_backfill::publish_terminal_response(state.db_pool(), &run_id, reply).await?;
        Ok(Some((closed, message_id)))
    }
    .await;
    match result {
        Ok(Some((closed, message_id))) => {
            if message_id.is_some() {
                crate::cloud_agent_runtime::routes::notify_run_response(
                    &state,
                    message_id.as_deref(),
                )
                .await;
            }
            Json(json!({ "released": true, "closed": closed, "published": message_id.is_some() }))
                .into_response()
        }
        Ok(None) => {
            Json(json!({ "released": false, "closed": false, "published": false })).into_response()
        }
        Err(error) => run_error_response(
            "release interrupted desktop run",
            "Could not release the interrupted request.",
            error,
        ),
    }
}
