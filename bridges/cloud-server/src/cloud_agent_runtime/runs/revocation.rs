//! Runs stop when their requester loses access to the agent, or when the chat
//! they answer in stops accepting the owner's messages.
//!
//! A run is admitted when it is claimed, but the requester and the agent's
//! owner can stop being contacts, or block each other, while it waits or
//! works. The same can happen between the owner and the other person in the
//! direct or AI chat the run answers in, even for a run the owner asked for
//! (a scheduled task in a direct chat, for example). Leasing, renewing, and
//! finishing a run check again; a revoked run is cancelled instead of being
//! delivered, so it never retries a delivery that can no longer succeed.

use chrono::Utc;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{ClaimRunRequest, RunResult};

/// The error code a run cancelled for lost access carries.
pub const RELATIONSHIP_REVOKED: &str = "relationship_revoked";
const REVOKED_MESSAGE: &str =
    "This run stopped because the people in its chat are no longer contacts.";

/// Whether the run may still use its agent and answer in its chat. Digest and
/// PiP runs always may. Subsession turns follow their own rules
/// (`subsession_execution::revalidate`), and so do runs the owner asked for,
/// apart from where they answer.
pub(super) async fn run_still_allowed(pool: &PgPool, run_id: &str) -> RunResult<bool> {
    if run_id.starts_with(crate::digest::RUN_PREFIX) || run_id.starts_with(crate::pip::RUN_PREFIX) {
        return Ok(true);
    }
    let row: Option<(String, String, String, String, bool)> = query_as(
        "SELECT session_id, request_message_id, owner_account_id, requester_account_id, \
                subsession_id IS NOT NULL \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((session_id, request_message_id, owner, requester, subsession)) = row else {
        return Ok(true);
    };
    if subsession {
        return Ok(true);
    }
    if !destination_accepts_owner(pool, &session_id, &owner).await? {
        return Ok(false);
    }
    if requester == owner {
        return Ok(true);
    }
    super::requester_may_invoke(
        pool,
        &ClaimRunRequest {
            session_id,
            request_message_id,
            owner_account_id: owner,
            requester_account_id: requester,
            prompt: String::new(),
            runtime_route: None,
            idempotency_key: String::new(),
        },
    )
    .await
}

/// Rechecks a run its executor still holds, for the owner's desktop as for
/// the cloud runner. A subsession turn follows
/// `subsession_execution::revalidate`; any other run that lost access is
/// cancelled. Returns whether the run may continue. A run that already
/// finished has nothing left to stop, so this leaves it to the caller, which
/// still answers a retry of its final update with the answer already posted.
pub(crate) async fn recheck_held_run(pool: &PgPool, run_id: &str) -> RunResult<bool> {
    let unfinished: Option<(bool,)> = query_as(
        "SELECT status IN ('queued', 'leased', 'running') \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    if !matches!(unfinished, Some((true,))) {
        return Ok(true);
    }
    if !crate::cloud_agent_runtime::subsession_execution::revalidate(pool, run_id).await? {
        return Ok(false);
    }
    if run_still_allowed(pool, run_id).await? {
        return Ok(true);
    }
    cancel_revoked_run(pool, run_id).await?;
    Ok(false)
}

/// Whether the agent's owner may still write in the chat `session_id` names,
/// where the run's answer is delivered as the owner's message. A direct or AI
/// chat with another person needs a contact, as every chat message does
/// (Kordi service accounts excepted). A direct chat with a person that does
/// not exist yet is created on delivery, which needs the same contact. Groups,
/// private sessions, and sessions without a chat accept the owner.
pub async fn destination_accepts_owner(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
) -> RunResult<bool> {
    let session = session_id.trim();
    let conversation: Option<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations \
         WHERE legacy_session_id IN ($1, $2) OR conversation_id = $3 \
         ORDER BY conversation_id LIMIT 1",
    )
    .bind(session_id)
    .bind(session)
    .bind(Uuid::parse_str(session).ok())
    .fetch_optional(pool)
    .await?;
    if let Some((conversation_id,)) = conversation {
        return Ok(crate::relationships::may_write_outside_groups(
            pool,
            conversation_id,
            owner_account_id,
        )
        .await?);
    }
    match super::delivery::direct_person_peer_account_id(session, owner_account_id) {
        Some(peer) => Ok(crate::relationships::are_contacts(pool, owner_account_id, &peer).await?),
        None => Ok(true),
    }
}

/// Cancels a run that has not finished because it lost access. A scheduled
/// task run is recorded as failed too, so the task shows why it stopped.
pub(super) async fn cancel_revoked_run(pool: &PgPool, run_id: &str) -> RunResult<()> {
    let now = Utc::now();
    let cancelled: Option<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'cancelled', error_code = $2, completed_at = $3, updated_at = $3 \
         WHERE run_id = $1 AND status IN ('queued', 'leased', 'running') \
         RETURNING request_message_id",
    )
    .bind(run_id)
    .bind(RELATIONSHIP_REVOKED)
    .bind(now.to_rfc3339())
    .fetch_optional(pool)
    .await?;
    if let Some((request_message_id,)) = cancelled {
        crate::scheduled_tasks::store::mark_scheduled_task_run_failed(
            pool,
            &request_message_id,
            RELATIONSHIP_REVOKED,
            REVOKED_MESSAGE,
            now,
        )
        .await?;
    }
    Ok(())
}
