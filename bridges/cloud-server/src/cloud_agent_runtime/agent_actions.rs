//! Actions that need a person.
//!
//! An agent that wants to share its owner's saved calendar in a shared chat,
//! and PiP when it notices an answer, a vote, or a plan decision, only create
//! a pending action. The person it concerns decides it in Kordi: the approver
//! for calendar sharing, RSVPs, and votes, or any organizer or chat owner or
//! admin for confirming, canceling, or reopening a plan.
//!
//! Pending actions expire lazily: every read filters `expires_at > now()`, and
//! a row is marked expired when someone tries to decide it or when a new row
//! needs its place.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};
use crate::server::ServerState;

mod calendar;
mod decision;
#[cfg(test)]
mod tests;

pub(crate) use calendar::{calendar_gate, CalendarGate};
#[cfg(test)]
pub(crate) use decision::decide_action;

/// Plan decisions any organizer or chat owner or admin may make. They have no
/// single approver.
pub(crate) const MANAGER_KINDS: [&str; 3] = ["plan_confirm", "plan_cancel", "plan_reopen"];
const LIST_LIMIT: i64 = 50;

/// Selects one pending action with its proposer's name and whether it has
/// expired by the database clock. Binds nothing.
macro_rules! action_select_sql {
    () => {
        "SELECT a.action_id, a.kind, a.conversation_id, a.session_id, a.approver_account_id,
                a.proposed_by_account_id, proposer.display_name, a.event_id, a.subject,
                a.status, a.created_at, a.expires_at, a.decided_by_account_id,
                a.expires_at <= now()
         FROM cloud_agent_pending_actions a
         LEFT JOIN cloud_accounts proposer ON proposer.account_id = a.proposed_by_account_id"
    };
}
pub(super) use action_select_sql;

/// Whether the account bound to `$1` may see and decide the action aliased
/// `a`: an active member of its conversation who is its approver, or, for a
/// plan decision, an organizer of the plan or a chat owner or admin.
macro_rules! visible_to_sql {
    () => {
        "EXISTS (SELECT 1 FROM cloud_chat_conversation_members me
                 WHERE me.conversation_id = a.conversation_id AND me.account_id = $1
                   AND me.membership_state = 'active')
         AND (a.approver_account_id = $1
              OR (a.approver_account_id IS NULL
                  AND a.kind IN ('plan_confirm', 'plan_cancel', 'plan_reopen')
                  AND (EXISTS (SELECT 1 FROM cloud_plan_card_participants p
                               WHERE p.event_id = a.event_id AND p.account_id = $1
                                 AND p.organizer)
                       OR EXISTS (SELECT 1 FROM cloud_plan_cards card
                                  JOIN cloud_chat_conversation_members m
                                    ON m.conversation_id = card.conversation_id
                                  WHERE card.event_id = a.event_id AND m.account_id = $1
                                    AND m.membership_state = 'active'
                                    AND m.role IN ('owner', 'admin')))))"
    };
}
pub(super) use visible_to_sql;

type ActionTuple = (
    Uuid,
    String,
    Uuid,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Value,
    String,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<String>,
    bool,
);

/// One pending action as stored.
#[derive(Clone, Debug)]
pub(crate) struct ActionRow {
    pub action_id: Uuid,
    pub kind: String,
    pub conversation_id: Uuid,
    pub session_id: String,
    pub approver: Option<String>,
    pub proposed_by: String,
    pub proposer_name: Option<String>,
    pub event_id: Option<String>,
    pub subject: Value,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub decided_by: Option<String>,
    pub expired: bool,
}

impl From<ActionTuple> for ActionRow {
    fn from(row: ActionTuple) -> Self {
        Self {
            action_id: row.0,
            kind: row.1,
            conversation_id: row.2,
            session_id: row.3,
            approver: row.4,
            proposed_by: row.5,
            proposer_name: row.6,
            event_id: row.7,
            subject: row.8,
            status: row.9,
            created_at: row.10,
            expires_at: row.11,
            decided_by: row.12,
            expired: row.13,
        }
    }
}

impl ActionRow {
    pub(crate) fn is_manager_kind(&self) -> bool {
        MANAGER_KINDS.contains(&self.kind.as_str())
    }

    /// The `PendingAction` shape clients read.
    pub(crate) fn to_json(&self) -> Value {
        let pip = self.kind.starts_with("plan_");
        let display_name = if pip {
            self.proposer_name.clone()
        } else {
            self.subject["agentName"]
                .as_str()
                .map(str::to_string)
                .or_else(|| self.proposer_name.clone())
        };
        json!({
            "actionId": self.action_id,
            "kind": self.kind,
            "sessionId": self.session_id,
            "conversationId": self.conversation_id,
            "status": self.status,
            "createdAt": self.created_at.to_rfc3339(),
            "expiresAt": self.expires_at.to_rfc3339(),
            "proposedBy": {
                "accountId": self.proposed_by,
                "displayName": display_name,
                "kind": if pip { "pip" } else { "agent" },
            },
            "subject": self.subject,
        })
    }
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/agent-actions", get(list))
        .route(
            "/v1/cloud/agent-actions/:action_id/decision",
            post(decision::decide),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

pub(super) fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
}

async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(input): Query<ListQuery>,
) -> Response {
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match list_for(state.db_pool(), &session.account_id, session_id).await {
        Ok(actions) => Json(json!({
            "actions": actions.iter().map(ActionRow::to_json).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(err) => {
            eprintln!("[agent_actions] list pending actions: {err}");
            error(
                "agent_actions_unavailable",
                "Could not load what is waiting for you. Try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

/// Up to 50 pending, unexpired actions the account may decide, newest first,
/// optionally for one conversation (legacy session id or conversation id).
pub(crate) async fn list_for(
    pool: &PgPool,
    account_id: &str,
    session_id: Option<&str>,
) -> Result<Vec<ActionRow>, sqlx_core::Error> {
    let rows: Vec<ActionTuple> = query_as(concat!(
        action_select_sql!(),
        " WHERE a.status = 'pending' AND a.expires_at > now()
           AND ($2::text IS NULL OR a.session_id = $2 OR a.conversation_id::text = $2)
           AND ",
        visible_to_sql!(),
        " ORDER BY a.created_at DESC, a.action_id DESC LIMIT $3"
    ))
    .bind(account_id)
    .bind(session_id)
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(ActionRow::from).collect())
}

pub(crate) async fn load_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    action_id: Uuid,
) -> Result<ActionRow, sqlx_core::Error> {
    let row: ActionTuple = query_as(concat!(action_select_sql!(), " WHERE a.action_id = $1"))
        .bind(action_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(row.into())
}

/// Who hears about an action: its approver, or every current manager of the
/// plan for a plan decision.
async fn recipients(
    tx: &mut Transaction<'_, Postgres>,
    row: &ActionRow,
) -> Result<Vec<String>, sqlx_core::Error> {
    if let Some(approver) = &row.approver {
        return Ok(vec![approver.clone()]);
    }
    let Some(event_id) = &row.event_id else {
        return Ok(Vec::new());
    };
    let managers: Vec<(String,)> = query_as(
        "SELECT m.account_id FROM cloud_chat_conversation_members m
         WHERE m.conversation_id = $1 AND m.membership_state = 'active'
           AND (m.role IN ('owner', 'admin')
                OR EXISTS (SELECT 1 FROM cloud_plan_card_participants p
                           WHERE p.event_id = $2 AND p.account_id = m.account_id
                             AND p.organizer))",
    )
    .bind(row.conversation_id)
    .bind(event_id)
    .fetch_all(&mut **tx)
    .await?;
    let pip = crate::pip::service_account_id();
    Ok(managers
        .into_iter()
        .map(|(account_id,)| account_id)
        .filter(|account_id| Some(account_id.as_str()) != pip)
        .collect())
}

/// Sends `agent_action.updated` with the action's current state to the people
/// who may decide it, in the transaction that changed it. Older apps ignore
/// the unknown event type.
pub(crate) async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    action_id: Uuid,
) -> Result<(), sqlx_core::Error> {
    let row = load_in_transaction(tx, action_id).await?;
    let recipients = recipients(tx, &row).await?;
    append_user_sync_events_in_transaction(
        tx,
        &recipients,
        "agent_action.updated",
        Some(row.conversation_id),
        &json!({"agentAction": row.to_json()}),
    )
    .await
    .map_err(|error| match error {
        StoreError::Database(error) => error,
        other => sqlx_core::Error::Protocol(other.to_string()),
    })
}

/// Publishes each id. Used after a statement that changed several rows.
pub(crate) async fn publish_all(
    tx: &mut Transaction<'_, Postgres>,
    action_ids: &[(Uuid,)],
) -> Result<(), sqlx_core::Error> {
    for (action_id,) in action_ids {
        publish(tx, *action_id).await?;
    }
    Ok(())
}
