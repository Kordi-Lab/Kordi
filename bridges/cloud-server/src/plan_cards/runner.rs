//! Plan-card actions issued by the cloud runner on behalf of a leased PiP run.
//!
//! The runner authenticates with its runner token; this module binds the
//! action to the run's owner (PiP's system account) and the run's own
//! conversation, so a run can never touch another chat's card. PiP proposes
//! cards; its answers, votes, and plan decisions come back as
//! `{"status": "suggested", ...}` until a person confirms them.

use std::{collections::BTreeSet, sync::Arc};

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use crate::server::ServerState;

use super::routes::{dispatch, Actor};
use super::suggestions::Dispatched;
use super::wire::Request;

/// Members PiP may suggest an answer or vote for: those who wrote one of the
/// run's new messages themselves. A reply a member's agent wrote is not that
/// member's word.
fn represented_accounts(prompt: &str) -> BTreeSet<String> {
    let Ok(input) = serde_json::from_str::<Value>(prompt) else {
        return BTreeSet::new();
    };
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["isNew"] == true && message["fromAgent"] != true)
        .filter(|message| {
            // The run input names messages `messageId`; `id` is the older name.
            message["messageId"]
                .as_str()
                .or_else(|| message["id"].as_str())
                .is_some_and(|message_id| !message_id.is_empty())
        })
        .filter_map(|message| message["senderId"].as_str().map(str::to_string))
        .collect()
}

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

pub async fn runner_action(
    state: &Arc<ServerState>,
    run_id: &str,
    runner_id: &str,
    request: Value,
) -> Response {
    let Some(pip) = state.pip() else {
        return error(
            "plan_card_unavailable",
            "PiP is not enabled on this server.",
            StatusCode::NOT_FOUND,
        );
    };
    let pip_account_id = pip.config().account_id.clone();
    let run: Option<(String, String, String)> = match query_as(
        "SELECT owner_account_id, session_id, prompt FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')
           AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(run) => run,
        Err(_) => {
            return error(
                "plan_card_unavailable",
                "Could not verify this run.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let Some((owner_account_id, session_id, prompt)) = run else {
        return error(
            "run_not_found",
            "This run is not leased by the caller.",
            StatusCode::NOT_FOUND,
        );
    };
    // An ordinary agent run owned by PiP's account is not one of PiP's sweeps.
    if owner_account_id != pip_account_id || !run_id.starts_with(crate::pip::RUN_PREFIX) {
        return error(
            "plan_card_forbidden",
            "Only PiP runs may manage plan cards through the runner.",
            StatusCode::FORBIDDEN,
        );
    }
    let conversation_id: Option<Uuid> = crate::chat_sync::store::conversation_id_for_session(
        state.db_pool(),
        &pip_account_id,
        &session_id,
    )
    .await
    .unwrap_or_default();
    let Some(conversation_id) = conversation_id else {
        return error(
            "plan_card_forbidden",
            "PiP is not an active member of this conversation.",
            StatusCode::FORBIDDEN,
        );
    };
    let request: Request = match serde_json::from_value(request) {
        Ok(request) => request,
        Err(err) => {
            return error(
                "invalid_plan_card_request",
                &format!("Plan card request is invalid: {err}"),
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let action = request.action();
    let actor = Actor {
        account_id: pip_account_id,
        on_behalf_of_conversation: Some(conversation_id),
        represented_accounts: represented_accounts(&prompt),
    };
    match dispatch(state.db_pool(), &actor, request).await {
        Ok(Dispatched::Suggested {
            row,
            action_id,
            awaiting,
        }) => {
            // The card did not change, so there is nothing to refresh or mark
            // seen. The model learns that a person still has to confirm.
            Json(json!({
                "status": "suggested",
                "pendingActionId": action_id,
                "awaiting": awaiting,
                "card": crate::pip::context::compact_card(&row),
            }))
            .into_response()
        }
        Ok(Dispatched::Applied(row)) => {
            // Publish each successful tool mutation, even if a later model
            // step fails before the run completion callback.
            if let Err(error) =
                crate::pip::cards::sync_card_messages(state.db_pool(), &actor.account_id, &row)
                    .await
            {
                eprintln!("[pip] Could not refresh the plan card after its action: {error}");
            }
            // PiP knows the card as its own action left it, so only later
            // member responses wake the next sweep.
            if let Err(error) = crate::pip::cards::mark_card_seen(
                state.db_pool(),
                conversation_id,
                &row.event_id,
                row.revision,
            )
            .await
            {
                eprintln!("[pip] Could not record the card PiP saw: {error}");
            }
            // The model gets the compact card: counts and the people it may
            // need to name, never every voter of a large group.
            Json(crate::pip::context::compact_card(&row)).into_response()
        }
        Err(response) => {
            eprintln!(
                "[pip] plan_card {action} rejected for run {run_id}: status {}",
                response.status()
            );
            *response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::represented_accounts;
    use serde_json::json;

    #[test]
    fn represented_accounts_require_new_message_provenance() {
        let prompt = json!({
            "messages": [
                {"id": "old", "senderId": "old-member", "isNew": false},
                {"id": "new", "senderId": "new-member", "isNew": true},
                {"id": "", "senderId": "missing-source", "isNew": true}
            ]
        })
        .to_string();
        assert_eq!(
            represented_accounts(&prompt),
            std::collections::BTreeSet::from(["new-member".to_string()])
        );
    }

    #[test]
    fn represented_accounts_read_the_run_input_and_skip_agent_replies() {
        let messages = crate::pip::context::budget_messages(
            ["writer", "agent-owner"]
                .into_iter()
                .enumerate()
                .map(|(index, sender)| crate::pip::context::ContextMessage {
                    id: format!("m{index}"),
                    sequence: 10 + index as i64,
                    sender_id: sender.to_string(),
                    sender_name: sender.to_string(),
                    kind: "text".to_string(),
                    text: "Saturday works".to_string(),
                    created_at: String::new(),
                    from_agent: sender == "agent-owner",
                })
                .rev()
                .collect(),
            0,
            5,
            "acct_pip",
        );
        let prompt = json!({ "messages": messages }).to_string();
        assert_eq!(
            represented_accounts(&prompt),
            std::collections::BTreeSet::from(["writer".to_string()])
        );
    }
}
