//! Plan-card actions issued by the cloud runner on behalf of a leased System
//! agent run.
//!
//! The runner authenticates with its runner token; this module binds the
//! action to the run's owner (the System agent's account) and the run's own
//! conversation, so a run can never touch another chat's card.

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

use super::routes::{dispatch_row, Actor};
use super::wire::Request;

fn represented_accounts(prompt: &str) -> BTreeSet<String> {
    let Ok(input) = serde_json::from_str::<Value>(prompt) else {
        return BTreeSet::new();
    };
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["isNew"] == true)
        .filter(|message| {
            message["messageId"]
                .as_str()
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
    let Some(system_agent) = state.system_agent() else {
        return error(
            "plan_card_unavailable",
            "The System agent is not enabled on this server.",
            StatusCode::NOT_FOUND,
        );
    };
    let system_agent_account_id = system_agent.config().account_id.clone();
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
    // An ordinary agent run owned by the System agent's account is not one of
    // its sweeps.
    if owner_account_id != system_agent_account_id
        || !run_id.starts_with(crate::system_agent::RUN_PREFIX)
    {
        return error(
            "plan_card_forbidden",
            "Only System agent runs may manage plan cards through the runner.",
            StatusCode::FORBIDDEN,
        );
    }
    let conversation_id: Option<Uuid> = crate::chat_sync::store::conversation_id_for_session(
        state.db_pool(),
        &system_agent_account_id,
        &session_id,
    )
    .await
    .unwrap_or_default();
    let Some(conversation_id) = conversation_id else {
        return error(
            "plan_card_forbidden",
            "The System agent is not an active member of this conversation.",
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
        account_id: system_agent_account_id,
        on_behalf_of_conversation: Some(conversation_id),
        represented_accounts: represented_accounts(&prompt),
    };
    match dispatch_row(state.db_pool(), &actor, request).await {
        Ok(row) => {
            // Publish each successful tool mutation, even if a later model
            // step fails before the run completion callback.
            if let Err(error) = crate::system_agent::cards::sync_card_messages(
                state.db_pool(),
                &actor.account_id,
                &row,
            )
            .await
            {
                eprintln!(
                    "[system-agent] Could not refresh the plan card after its action: {error}"
                );
            }
            // The System agent knows the card as its own action left it, so
            // only later member responses wake the next sweep.
            if let Err(error) = crate::system_agent::cards::mark_card_seen(
                state.db_pool(),
                conversation_id,
                &row.event_id,
                row.revision,
            )
            .await
            {
                eprintln!("[system-agent] Could not record the card the System agent saw: {error}");
            }
            // The model gets the compact card: counts and the people it may
            // need to name, never every voter of a large group.
            Json(crate::system_agent::context::compact_card(&row)).into_response()
        }
        Err(response) => {
            eprintln!(
                "[system-agent] plan_card {action} rejected for run {run_id}: status {}",
                response.status()
            );
            *response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::represented_accounts;
    use crate::system_agent::context::{budget_messages, ContextMessage};
    use serde_json::json;

    #[test]
    fn represented_accounts_accept_the_system_agent_context_wire_shape() {
        let message = |id: &str, sequence, sender: &str| ContextMessage {
            id: id.to_string(),
            sequence,
            sender_id: sender.to_string(),
            sender_name: sender.to_string(),
            kind: "text".to_string(),
            text: "Lunch works for me".to_string(),
            created_at: "2026-11-01T12:00:00Z".to_string(),
        };
        let messages = budget_messages(
            vec![
                message("new", 2, "new-member"),
                message("old", 1, "old-member"),
            ],
            0,
            1,
            "system-agent",
        );
        assert_eq!(
            represented_accounts(&json!({"messages": messages}).to_string()),
            std::collections::BTreeSet::from(["new-member".to_string()])
        );
    }

    #[test]
    fn represented_accounts_require_new_message_provenance() {
        let prompt = json!({
            "messages": [
                {"messageId": "old", "senderId": "old-member", "isNew": false},
                {"messageId": "new", "senderId": "new-member", "isNew": true},
                {"messageId": "", "senderId": "empty-source", "isNew": true},
                {"senderId": "missing-source", "isNew": true},
                {"id": "wrong-key", "senderId": "wrong-source", "isNew": true}
            ]
        })
        .to_string();
        assert_eq!(
            represented_accounts(&prompt),
            std::collections::BTreeSet::from(["new-member".to_string()])
        );
        for prompt in ["not json", "{}", r#"{"messages":null}"#] {
            assert!(represented_accounts(prompt).is_empty());
        }
    }
}
