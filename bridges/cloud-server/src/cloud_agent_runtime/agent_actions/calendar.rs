//! The owner's approval before an agent shares their saved calendar in a
//! shared chat.
//!
//! An approval is a grant for 10 minutes per owner, conversation, and exact
//! window, so paging through the same window, or asking again soon, does not
//! ask again. A decline applies only to the request that asked. A request
//! that is still waiting expires after 10 minutes.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

/// What the calendar read does next.
#[derive(Debug, PartialEq)]
pub(crate) enum CalendarGate {
    /// The owner approved this window recently: read as usual.
    Granted,
    /// Answer with this body instead of calendar data (status
    /// `approval_required` or `declined`).
    Respond(Value),
}

/// How long a waiting request, and an approval, last.
const WINDOW_MINUTES: i32 = 10;

pub(crate) fn subject_key(start_at: Option<&str>, end_at: Option<&str>) -> String {
    format!(
        "calendar:{}:{}",
        start_at.unwrap_or_default(),
        end_at.unwrap_or_default()
    )
}

pub(crate) fn waiting_text(owner: &str) -> String {
    format!(
        "Waiting for {owner} to approve sharing their calendar in this chat. \
         Do not share or guess calendar details."
    )
}

pub(crate) fn timeout_text(owner: &str) -> String {
    format!(
        "{owner} has not approved sharing their calendar in this chat. Do not share or guess \
         calendar details. Tell them they can approve the request in Kordi (an app update may \
         be needed) and ask again, or ask in a private chat."
    )
}

pub(crate) fn declined_text(owner: &str) -> String {
    format!(
        "{owner} chose not to share their calendar in this chat. \
         Do not share or guess calendar details."
    )
}

/// Decides whether a shared calendar read may return data. `request_ids` are
/// the request id the tool sent and its server wire id; the wire id (first)
/// binds a decline and a waiting request to that one request.
pub(crate) async fn calendar_gate(
    pool: &PgPool,
    owner: &str,
    session_id: &str,
    request_ids: [&str; 2],
    start_at: Option<&str>,
    end_at: Option<&str>,
) -> Result<CalendarGate, sqlx_core::Error> {
    let key = subject_key(start_at, end_at);
    let [wire, requested] = request_ids;
    let (granted, declined, owner_name): (bool, bool, Option<String>) = query_as(
        "SELECT
             EXISTS (SELECT 1 FROM cloud_agent_pending_actions
                     WHERE kind = 'calendar_disclosure' AND approver_account_id = $1
                       AND session_id = $2 AND subject_key = $3 AND status = 'approved'
                       AND grant_expires_at > now()),
             EXISTS (SELECT 1 FROM cloud_agent_pending_actions
                     WHERE kind = 'calendar_disclosure' AND approver_account_id = $1
                       AND session_id = $2 AND subject_key = $3 AND status = 'declined'
                       AND request_message_id = $4 AND expires_at > now()),
             (SELECT display_name FROM cloud_accounts WHERE account_id = $1)",
    )
    .bind(owner)
    .bind(session_id)
    .bind(&key)
    .bind(wire)
    .fetch_one(pool)
    .await?;
    if granted {
        return Ok(CalendarGate::Granted);
    }
    let owner_name = owner_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "The owner".to_string());
    if declined {
        return Ok(CalendarGate::Respond(json!({
            "status": "declined",
            "message": declined_text(&owner_name),
        })));
    }

    let mut tx = pool.begin().await?;
    let (conversation_id, title): (Uuid, Option<String>) = query_as(
        "SELECT conversation_id, shared_title FROM cloud_chat_conversations
         WHERE legacy_session_id = $1",
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(sqlx_core::Error::RowNotFound)?;
    // An expired request must not hold the place of a new one.
    let expired: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_agent_pending_actions SET status = 'expired'
         WHERE kind = 'calendar_disclosure' AND conversation_id = $1
           AND approver_account_id = $2 AND request_message_id = $3 AND subject_key = $4
           AND status = 'pending' AND expires_at <= now()
         RETURNING action_id",
    )
    .bind(conversation_id)
    .bind(owner)
    .bind(wire)
    .bind(&key)
    .fetch_all(&mut *tx)
    .await?;
    super::publish_all(&mut tx, &expired).await?;

    let action_id = match waiting_action(&mut tx, conversation_id, owner, wire, &key).await? {
        Some(action_id) => action_id,
        None => {
            let run: Option<(Option<String>, Option<String>, Option<String>)> = query_as(
                "SELECT run_id, execution_agent_id, turn_identity->>'agentName'
                 FROM cloud_agent_fallback_runs
                 WHERE owner_account_id = $1 AND session_id = $2
                   AND request_message_id IN ($3, $4)
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(owner)
            .bind(session_id)
            .bind(wire)
            .bind(requested)
            .fetch_optional(&mut *tx)
            .await?;
            let (run_id, agent_id, agent_name) = run.unwrap_or_default();
            let subject = json!({
                "agentId": agent_id.unwrap_or_else(|| format!("cloud-agent:{owner}")),
                "agentName": agent_name
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "Your agent".to_string()),
                "startAt": start_at,
                "endAt": end_at,
                "conversationTitle": title
                    .map(|title| title.trim().to_string())
                    .filter(|title| !title.is_empty()),
            });
            let inserted: Option<(Uuid,)> = query_as(
                "INSERT INTO cloud_agent_pending_actions (
                     action_id, kind, conversation_id, session_id, approver_account_id,
                     proposed_by_account_id, run_id, request_message_id, subject, subject_key,
                     expires_at
                 ) VALUES ($1, 'calendar_disclosure', $2, $3, $4, $4, $5, $6, $7, $8,
                           now() + make_interval(mins => $9))
                 ON CONFLICT DO NOTHING
                 RETURNING action_id",
            )
            .bind(Uuid::new_v4())
            .bind(conversation_id)
            .bind(session_id)
            .bind(owner)
            .bind(run_id)
            .bind(wire)
            .bind(&subject)
            .bind(&key)
            .bind(WINDOW_MINUTES)
            .fetch_optional(&mut *tx)
            .await?;
            match inserted {
                Some((action_id,)) => {
                    super::publish(&mut tx, action_id).await?;
                    action_id
                }
                // Another read of the same request created it first.
                None => waiting_action(&mut tx, conversation_id, owner, wire, &key)
                    .await?
                    .ok_or(sqlx_core::Error::RowNotFound)?,
            }
        }
    };
    tx.commit().await?;
    Ok(CalendarGate::Respond(json!({
        "status": "approval_required",
        "pendingActionId": action_id,
        "message": waiting_text(&owner_name),
        "timeoutMessage": timeout_text(&owner_name),
    })))
}

/// The request's waiting action for this window, if any.
async fn waiting_action(
    tx: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    owner: &str,
    wire: &str,
    key: &str,
) -> Result<Option<Uuid>, sqlx_core::Error> {
    let row: Option<(Uuid,)> = query_as(
        "SELECT action_id FROM cloud_agent_pending_actions
         WHERE kind = 'calendar_disclosure' AND conversation_id = $1
           AND approver_account_id = $2 AND request_message_id = $3
           AND subject_key = $4 AND status = 'pending'",
    )
    .bind(conversation_id)
    .bind(owner)
    .bind(wire)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|(action_id,)| action_id))
}

/// Records the owner's approval as a 10-minute grant for this window, and
/// retires other requests for the same window, which the grant now covers.
pub(super) async fn approve(
    tx: &mut Transaction<'_, Postgres>,
    row: &super::ActionRow,
    decider: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_agent_pending_actions
         SET status = 'approved', decided_at = now(), decided_by_account_id = $2,
             grant_expires_at = now() + make_interval(mins => $3)
         WHERE action_id = $1",
    )
    .bind(row.action_id)
    .bind(decider)
    .bind(WINDOW_MINUTES)
    .execute(&mut **tx)
    .await?;
    let covered: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_agent_pending_actions SET status = 'superseded'
         WHERE kind = 'calendar_disclosure' AND status = 'pending' AND action_id <> $1
           AND approver_account_id = $2 AND session_id = $3
           AND subject_key = (SELECT subject_key FROM cloud_agent_pending_actions
                              WHERE action_id = $1)
         RETURNING action_id",
    )
    .bind(row.action_id)
    .bind(decider)
    .bind(&row.session_id)
    .fetch_all(&mut **tx)
    .await?;
    super::publish_all(tx, &covered).await
}
