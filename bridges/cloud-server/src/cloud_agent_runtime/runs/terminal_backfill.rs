//! Terminal responses for runs that ended without one.
//!
//! A desktop turn can stop without publishing its last state: the Mac app
//! reloads, the native turn is interrupted, or the desktop cancels its lease.
//! The run row then ends `cancelled` or `failed` while every other device still
//! shows the `processing` reply. This module publishes the terminal reply for
//! such a run once, through the same delivery paths a Cloud runner failure
//! uses.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::delivery::{
    ensure_group_response_messages, ensure_scheduled_direct_person_response_message,
    is_scheduled_run_request_id, GroupResponse,
};
use super::envelopes::{encode_cloud_agent_response_body_with_ending, parse_cloud_group_envelope};
use super::RunResult;

pub const INTERRUPTED_TEXT: &str = "This reply was interrupted before it completed. Try again.";
pub const FAILED_TEXT: &str = "This reply could not be completed. Try again.";
const RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
/// Ended runs are released this often, so no device shows a run as running
/// for long after its executor stopped.
const RELEASE_INTERVAL: Duration = Duration::from_secs(10);
/// Missing terminal replies are backfilled every this many release passes.
const BACKFILL_EVERY_RELEASES: u32 = 6;
const STARTUP_WINDOW_HOURS: i64 = 7 * 24;
const SWEEP_WINDOW_HOURS: i64 = 1;
const SWEEP_LIMIT: i64 = 200;
const LOST_DESKTOP_GRACE_MINUTES: i32 = 10;

type EndedRun = (String, String, String, String, String, bool);

/// The reply an executor reports for the run it ended, such as the partial
/// text of a turn that stopped early. Without it the server publishes a short
/// notice.
#[derive(Clone, Copy, Debug)]
pub struct TerminalReply<'a> {
    pub text: &'a str,
    /// `stopped` or `interrupted` when `text` is the partial answer.
    pub ending: Option<&'a str>,
}

/// The delivery state an agent response for `request_id` carries, when `body`
/// is one.
pub(super) fn response_state_for_request(body: &str, request_id: &str) -> Option<String> {
    let request_id = request_id.trim();
    if let Some(envelope) = parse_cloud_group_envelope(body) {
        let message = envelope.message?;
        let matches = envelope.kind == "group-message"
            && message.sender_kind.as_deref() == Some("agent")
            && message
                .request_id
                .as_deref()
                .or(message.reply_to_message_id.as_deref())
                .is_some_and(|id| id.trim() == request_id);
        return matches.then(|| message.delivery_state.unwrap_or_default());
    }
    let encoded = body.trim().strip_prefix(RESPONSE_PREFIX)?;
    let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let matches = value.get("kind").and_then(Value::as_str) == Some("agent-response")
        && value
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| id.trim() == request_id);
    matches.then(|| {
        value
            .get("deliveryState")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    })
}

fn is_terminal_state(state: &str) -> bool {
    !matches!(state.trim(), "processing" | "queued")
}

async fn has_terminal_response(
    pool: &PgPool,
    owner_account_id: &str,
    session_id: &str,
    request_id: &str,
) -> RunResult<bool> {
    Ok(
        terminal_response_state(pool, owner_account_id, session_id, request_id)
            .await?
            .is_some(),
    )
}

/// The delivery state of the owner's terminal reply to `request_id`, if any.
async fn terminal_response_state(
    pool: &PgPool,
    owner_account_id: &str,
    session_id: &str,
    request_id: &str,
) -> RunResult<Option<String>> {
    // Deleted replies count: a reply the user removed must not come back.
    let rows: Vec<(Option<String>,)> = query_as(
        "SELECT message.content #>> '{blocks,0,text}' \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
         WHERE conversation.legacy_session_id = $1 AND message.sender_account_id = $2",
    )
    .bind(session_id)
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().find_map(|(body,)| {
        body.and_then(|body| response_state_for_request(&body, request_id))
            .filter(|state| is_terminal_state(state))
    }))
}

/// Publishes the terminal reply of an ended user request that has none and
/// returns its message ID. Scheduled, digest, PiP, and background-session
/// runs keep their own lifecycles and are skipped.
pub async fn publish_missing_terminal_response(
    pool: &PgPool,
    run_id: &str,
) -> RunResult<Option<String>> {
    publish_terminal_response(pool, run_id, None).await
}

/// Publishes `reply`, or the short notice without one, as the terminal reply
/// of an ended run that has none, and returns its message ID. A completed run
/// gets a reply only when its executor reports one.
pub async fn publish_terminal_response(
    pool: &PgPool,
    run_id: &str,
    reply: Option<TerminalReply<'_>>,
) -> RunResult<Option<String>> {
    let run: Option<EndedRun> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, request_message_id, status, \
           cancel_requested_at IS NOT NULL \
         FROM cloud_agent_fallback_runs run \
         WHERE run_id = $1 AND (status IN ('cancelled', 'failed') OR ($2 AND status = 'completed')) \
           AND NOT legacy_duplicate \
           AND subsession_id IS NULL \
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat chat WHERE chat.run_id = run.run_id)",
    )
    .bind(run_id)
    .bind(reply.is_some())
    .fetch_optional(pool)
    .await?;
    let Some((owner, requester, session_id, request_id, status, stop_requested)) = run else {
        return Ok(None);
    };
    if is_scheduled_run_request_id(&request_id)
        || run_id.starts_with(crate::digest::RUN_PREFIX)
        || run_id.starts_with(crate::pip::RUN_PREFIX)
        || has_terminal_response(pool, &owner, &session_id, &request_id).await?
    {
        return Ok(None);
    }
    let reply = reply.filter(|reply| !reply.text.trim().is_empty());
    let text = if let Some(reply) = reply {
        reply.text
    } else if status == "cancelled" && stop_requested {
        super::stop::STOPPED_TEXT
    } else if status == "cancelled" {
        INTERRUPTED_TEXT
    } else {
        FAILED_TEXT
    };
    let ending = reply.and_then(|reply| reply.ending);
    let delivery_state = if status == "completed" {
        "complete"
    } else {
        status.as_str()
    };
    if let Some(message_id) = ensure_group_response_messages(
        pool,
        GroupResponse {
            run_id,
            owner_account_id: &owner,
            session_id: &session_id,
            request_message_id: &request_id,
            response_text: text,
            delivery_state,
        },
    )
    .await?
    {
        return Ok(Some(message_id));
    }
    let body =
        encode_cloud_agent_response_body_with_ending(&request_id, text, delivery_state, ending);
    if let Some(message_id) =
        ensure_scheduled_direct_person_response_message(pool, run_id, &owner, &session_id, &body)
            .await?
    {
        return Ok(Some(message_id));
    }
    // A self-agent chat: replace the run's processing reply in place, or add
    // the terminal reply when the run never published one.
    let message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        run_id,
        &owner,
        &requester,
        &session_id,
        &body,
    )
    .await?;
    crate::cloud_agent_runtime::artifacts::update_response_message_body(pool, &message_id, &body)
        .await?;
    Ok(Some(message_id))
}

/// Publishes the terminal reply of a run its desktop just cancelled. The
/// desktop can no longer publish once its lease ends, so the server does.
pub(crate) async fn publish_after_cancel(state: &crate::server::ServerState, run_id: &str) {
    match publish_missing_terminal_response(state.db_pool(), run_id).await {
        Ok(Some(message_id)) => {
            crate::cloud_agent_runtime::routes::notify_run_response(state, Some(&message_id)).await
        }
        Ok(None) => {}
        Err(error) => eprintln!("[cloud_agent_runtime] terminal reply for {run_id}: {error}"),
    }
}

/// The run status that matches a terminal reply's delivery state.
fn run_status_for_reply(state: &str) -> &'static str {
    match state.trim() {
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "completed",
    }
}

/// Ends desktop runs whose executor is gone.
///
/// A run whose lease lapsed while the request already has its terminal reply
/// ends at once: its executor finished the turn but could not end the run, for
/// example after losing its lease mid-publish. A run whose stop was requested
/// ends when its lease lapses (`stop::release_stopped_runs`). Any other run gets
/// a grace period: a Cloud runner takes over an expired desktop lease within
/// seconds when it can, so a run still held by the desktop after the grace has
/// lost its executor (for example a project chat that runs only on its Mac).
pub(crate) async fn release_lost_desktop_runs(pool: &PgPool) -> RunResult<()> {
    let lapsed: Vec<(String, String, String, String)> = query_as(
        "SELECT run_id, owner_account_id, session_id, request_message_id \
         FROM cloud_agent_fallback_runs run \
         WHERE execution_backend = 'desktop' AND status IN ('leased', 'running') \
           AND NOT legacy_duplicate AND subsession_id IS NULL \
           AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz <= now() \
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat chat WHERE chat.run_id = run.run_id) \
         ORDER BY lease_expires_at LIMIT $1",
    )
    .bind(SWEEP_LIMIT)
    .fetch_all(pool)
    .await?;
    for (run_id, owner, session_id, request_id) in lapsed {
        let Some(state) = terminal_response_state(pool, &owner, &session_id, &request_id).await?
        else {
            continue;
        };
        sqlx_core::query::query(
            "UPDATE cloud_agent_fallback_runs SET status = $2, completed_at = now()::text, \
               updated_at = now()::text \
             WHERE run_id = $1 AND status IN ('leased', 'running') \
               AND lease_expires_at::timestamptz <= now()",
        )
        .bind(&run_id)
        .bind(run_status_for_reply(&state))
        .execute(pool)
        .await?;
    }
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs run SET status = 'cancelled', \
           error_code = 'desktop_executor_lost', completed_at = now()::text, updated_at = now()::text \
         WHERE execution_backend = 'desktop' AND status IN ('leased', 'running') \
           AND NOT legacy_duplicate AND subsession_id IS NULL \
           AND lease_expires_at IS NOT NULL \
           AND lease_expires_at::timestamptz < now() - make_interval(mins => $1::INT) \
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat chat WHERE chat.run_id = run.run_id)",
    )
    .bind(LOST_DESKTOP_GRACE_MINUTES)
    .execute(pool)
    .await?;
    Ok(())
}

/// Publishes missing terminal replies for desktop runs that ended within the
/// last `window_hours`, and returns how many it published.
pub async fn backfill_terminal_responses(pool: &PgPool, window_hours: i64) -> RunResult<usize> {
    release_lost_desktop_runs(pool).await?;
    let runs: Vec<(String,)> = query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs \
         WHERE execution_backend = 'desktop' AND status IN ('cancelled', 'failed') \
           AND NOT legacy_duplicate AND subsession_id IS NULL \
           AND COALESCE(completed_at, updated_at)::timestamptz > now() - make_interval(hours => $1::INT) \
         ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT $2",
    )
    .bind(window_hours as i32)
    .bind(SWEEP_LIMIT)
    .fetch_all(pool)
    .await?;
    let mut published = 0;
    for (run_id,) in runs {
        match publish_missing_terminal_response(pool, &run_id).await {
            Ok(Some(_)) => published += 1,
            Ok(None) => {}
            Err(error) => eprintln!("[cloud_agent_runtime] terminal reply for {run_id}: {error}"),
        }
    }
    Ok(published)
}

/// Starts the sweep: ended runs are released every few seconds; missing
/// terminal replies are backfilled for a week of history once at startup,
/// then for the last hour every minute.
pub fn spawn(pool: PgPool) {
    tokio::spawn(async move {
        let mut window_hours = STARTUP_WINDOW_HOURS;
        let mut interval = tokio::time::interval(RELEASE_INTERVAL);
        let mut releases = 0u32;
        loop {
            interval.tick().await;
            if let Err(error) = super::stop::release_stopped_runs(&pool).await {
                eprintln!("[cloud_agent_runtime] stopped run sweep: {error}");
            }
            if releases.is_multiple_of(BACKFILL_EVERY_RELEASES) {
                if let Err(error) = backfill_terminal_responses(&pool, window_hours).await {
                    eprintln!("[cloud_agent_runtime] terminal reply sweep: {error}");
                }
                window_hours = SWEEP_WINDOW_HOURS;
            } else if let Err(error) = release_lost_desktop_runs(&pool).await {
                eprintln!("[cloud_agent_runtime] lost desktop run sweep: {error}");
            }
            releases = releases.wrapping_add(1);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_response(value: Value) -> String {
        format!(
            "{RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(value.to_string())
        )
    }

    fn group_response(request_id: &str, state: &str) -> String {
        let envelope = serde_json::json!({
            "kind": "group-message",
            "groupId": "session:group:one",
            "createdByAccountId": "owner",
            "actor": { "accountId": "owner", "displayName": "Owner" },
            "participants": [],
            "message": {
                "id": "reply", "senderAccountId": "owner", "text": "Working",
                "createdAtMs": 1, "senderKind": "agent", "deliveryState": state,
                "requestId": request_id, "replyToMessageId": request_id
            }
        });
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    #[test]
    fn response_state_reads_only_the_exact_request() {
        let processing = group_response("msg-a", "processing");
        assert_eq!(
            response_state_for_request(&processing, "msg-a").as_deref(),
            Some("processing")
        );
        assert_eq!(response_state_for_request(&processing, "msg-b"), None);
        let failed = group_response("msg-a", "failed");
        assert!(is_terminal_state(
            &response_state_for_request(&failed, "msg-a").unwrap()
        ));
        let direct = agent_response(serde_json::json!({
            "kind": "agent-response", "requestId": "msg-c", "text": "Done", "deliveryState": "complete"
        }));
        assert_eq!(
            response_state_for_request(&direct, "msg-c").as_deref(),
            Some("complete")
        );
        // Legacy replies without a state were terminal.
        let legacy = agent_response(serde_json::json!({
            "kind": "agent-response", "requestId": "msg-d", "text": "Done"
        }));
        assert!(is_terminal_state(
            &response_state_for_request(&legacy, "msg-d").unwrap()
        ));
        assert_eq!(response_state_for_request("plain text", "msg-a"), None);
    }
}
