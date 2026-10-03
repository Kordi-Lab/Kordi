//! `POST /v1/cloud/agent-actions/:action_id/decision`.
//!
//! The decider must still see the action (an active member who is its
//! approver, or a plan manager for a plan decision). Repeating the same
//! decision returns the current action; any other decision on a closed or
//! expired action is refused. An approved plan suggestion is applied as the
//! decider, with the plan revision it was made at.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use uuid::Uuid;

use super::{action_select_sql, error, visible_to_sql, ActionRow, ActionTuple};
use crate::auth::routes::CloudSession;
use crate::plan_cards::suggestions::{self, ApplyError};
use crate::server::ServerState;

#[derive(Deserialize)]
pub(super) struct DecisionInput {
    decision: String,
}

fn not_found() -> Response {
    error(
        "agent_action_not_found",
        "This request was not found.",
        StatusCode::NOT_FOUND,
    )
}

fn closed() -> Response {
    error(
        "agent_action_closed",
        "This request is no longer waiting.",
        StatusCode::CONFLICT,
    )
}

fn unavailable(err: impl std::fmt::Display) -> Response {
    eprintln!("[agent_actions] decide: {err}");
    error(
        "agent_actions_unavailable",
        "Could not save your answer. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

pub(super) async fn decide(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(action_id): Path<String>,
    Json(input): Json<DecisionInput>,
) -> Response {
    let approve = match input.decision.trim() {
        "approve" => true,
        "decline" => false,
        _ => {
            return error(
                "invalid_decision",
                "decision must be approve or decline.",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let Ok(action_id) = Uuid::parse_str(action_id.trim()) else {
        return not_found();
    };
    match decide_action(&state, &session.account_id, action_id, approve).await {
        Ok(body) => Json(body).into_response(),
        Err(response) => response,
    }
}

async fn current_card(state: &ServerState, row: &ActionRow) -> Value {
    let Some(event_id) = &row.event_id else {
        return Value::Null;
    };
    match crate::plan_cards::store::load(state.db_pool(), event_id).await {
        Ok(Some(card)) => json!(card),
        _ => Value::Null,
    }
}

/// Decides one action as `account`: the decision route's logic, returning the
/// response body or the error response.
pub(crate) async fn decide_action(
    state: &ServerState,
    account: &str,
    action_id: Uuid,
    approve: bool,
) -> Result<Value, Response> {
    let pool = state.db_pool();
    let mut tx = pool.begin().await.map_err(unavailable)?;
    // The row lock serializes decisions on one action.
    let row: Option<ActionTuple> = query_as(concat!(
        action_select_sql!(),
        " WHERE a.action_id = $2 AND ",
        visible_to_sql!(),
        " FOR UPDATE OF a"
    ))
    .bind(account)
    .bind(action_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    let Some(row) = row.map(ActionRow::from) else {
        return Err(not_found());
    };
    if row.status != "pending" {
        let repeated = row.decided_by.as_deref() == Some(account)
            && matches!(
                (approve, row.status.as_str()),
                (true, "approved" | "applied") | (false, "declined")
            );
        if !repeated {
            return Err(closed());
        }
        let card = if approve {
            current_card(state, &row).await
        } else {
            Value::Null
        };
        return Ok(json!({"action": row.to_json(), "planCard": card}));
    }
    if row.expired {
        set_status(&mut tx, &row, "expired", None).await?;
        tx.commit().await.map_err(unavailable)?;
        return Err(closed());
    }
    if !approve {
        set_status(&mut tx, &row, "declined", Some(account)).await?;
        let action = super::load_in_transaction(&mut tx, row.action_id)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        return Ok(json!({"action": action.to_json(), "planCard": null}));
    }
    if row.kind == "calendar_disclosure" {
        super::calendar::approve(&mut tx, &row, account)
            .await
            .map_err(unavailable)?;
        super::publish(&mut tx, row.action_id)
            .await
            .map_err(unavailable)?;
        let action = super::load_in_transaction(&mut tx, row.action_id)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        return Ok(json!({"action": action.to_json(), "planCard": null}));
    }

    // A plan suggestion: apply it as the decider while this row stays locked.
    let card = match suggestions::apply_approval(pool, &row, account).await {
        Ok(card) => card,
        Err(ApplyError::PlanChanged) => {
            set_status(&mut tx, &row, "superseded", None).await?;
            tx.commit().await.map_err(unavailable)?;
            return Err(error(
                "plan_changed",
                "This plan changed. Check the card and try again.",
                StatusCode::CONFLICT,
            ));
        }
        Err(ApplyError::Forbidden) => {
            return Err(error(
                "plan_card_forbidden",
                "Only the plan's organizer or a chat admin can decide this plan.",
                StatusCode::FORBIDDEN,
            ))
        }
        Err(ApplyError::Failed(response)) => return Err(response),
    };
    set_status(&mut tx, &row, "applied", Some(account)).await?;
    let superseded = suggestions::supersede_after_apply(&mut tx, &row)
        .await
        .map_err(unavailable)?;
    super::publish_all(&mut tx, &superseded)
        .await
        .map_err(unavailable)?;
    let action = super::load_in_transaction(&mut tx, row.action_id)
        .await
        .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    // Refresh the card PiP posted, as a member's own card action does.
    if let Some(pip) = state.pip() {
        if let Err(err) =
            crate::pip::cards::sync_card_messages(pool, &pip.config().account_id, &card).await
        {
            eprintln!("[pip] Could not update the plan card messages: {err}");
        }
    }
    Ok(json!({"action": action.to_json(), "planCard": card}))
}

/// Moves the locked row to `status` and tells its deciders.
async fn set_status(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    row: &ActionRow,
    status: &str,
    decider: Option<&str>,
) -> Result<(), Response> {
    query(
        "UPDATE cloud_agent_pending_actions
         SET status = $2,
             decided_at = CASE WHEN $3::text IS NULL THEN decided_at ELSE now() END,
             decided_by_account_id = COALESCE($3, decided_by_account_id)
         WHERE action_id = $1",
    )
    .bind(row.action_id)
    .bind(status)
    .bind(decider)
    .execute(&mut **tx)
    .await
    .map_err(unavailable)?;
    super::publish(tx, row.action_id).await.map_err(unavailable)
}
