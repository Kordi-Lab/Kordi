//! Release of a request whose desktop turn this device lost.
//!
//! A desktop execution lease lives in the app's memory, so a reload or crash
//! loses it. On restart the app reports each request it was still running;
//! the server stops this device's run for it and publishes the terminal
//! reply, so other devices leave the `processing` state.
use super::*;
use crate::cloud_agent_runtime::runs::{self, terminal_backfill};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::cloud_agent_runtime) struct InterruptedInput {
    session_id: String,
    request_message_id: String,
}

pub(in crate::cloud_agent_runtime) async fn interrupted(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<InterruptedInput>,
) -> Response {
    let session_id = input.session_id.trim();
    let request_id = input.request_message_id.trim();
    if session_id.is_empty() || request_id.is_empty() {
        return denied();
    }
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
        query(
            "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', error_code = 'desktop_interrupted', \
             completed_at = $2, updated_at = $2 WHERE run_id = $1 AND status IN ('leased', 'running')",
        )
        .bind(&run_id)
        .bind(Utc::now().to_rfc3339())
        .execute(state.db_pool())
        .await?;
        let message_id =
            terminal_backfill::publish_missing_terminal_response(state.db_pool(), &run_id).await?;
        Ok(Some(message_id))
    }
    .await;
    match result {
        Ok(Some(message_id)) => {
            if message_id.is_some() {
                crate::cloud_agent_runtime::routes::notify_run_response(
                    &state,
                    message_id.as_deref(),
                )
                .await;
            }
            Json(json!({ "released": true, "published": message_id.is_some() })).into_response()
        }
        Ok(None) => Json(json!({ "released": false, "published": false })).into_response(),
        Err(error) => run_error_response(
            "release interrupted desktop run",
            "Could not release the interrupted request.",
            error,
        ),
    }
}
