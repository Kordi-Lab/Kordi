//! A cloud run's prompt is built when the run is claimed, and the runner
//! receives it when it leases the run. When the conversation's AI access
//! changed in between (a member turned on "Don't let AI use my messages", or
//! the group narrowed what agents can see), the lease rebuilds the prompt
//! under the current settings, so the provider never receives history the
//! run may no longer use. The OMP runtime reads the run's structured input
//! instead of the prompt, so its context request rebuilds that input the same
//! way. The stored prompt and input are left as they were.

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{
    fallback_prompt_for_claim, history_payload, strip_leading_agent_mention, CloudFallbackPrompt,
};
use crate::cloud_agent_runtime::runs::delivery::is_scheduled_run_request_id;
use crate::cloud_agent_runtime::runs::{
    request_identity, ClaimRunRequest, RunResult, CANARY_RUN_PREFIX,
};

/// Runs the claim path created. Canary, digest, PiP and task-session runs
/// carry prompts of their own.
const CLAIMED_RUN_PREFIX: &str = "car_";

/// Finds a claimed run whose conversation's AI access changed after the
/// claim. Run times come from the server clock and setting times from the
/// database clock, so a change shortly before the claim also counts; the
/// rebuilt prompt then comes out the same.
const CHANGED_SINCE_CLAIM_SQL: &str = "SELECT run.request_message_id, run.session_id,
        run.owner_account_id, run.requester_account_id, run.idempotency_key,
        conversation.conversation_id
 FROM cloud_agent_fallback_runs run
 JOIN cloud_chat_conversations conversation
   ON conversation.legacy_session_id = run.session_id
 WHERE run.run_id = $1 AND run.subsession_id IS NULL
   AND (EXISTS (SELECT 1 FROM cloud_chat_ai_opt_outs opt_out
                WHERE opt_out.conversation_id = conversation.conversation_id
                  AND opt_out.created_at > run.created_at::timestamptz - interval '30 seconds')
        OR EXISTS (SELECT 1 FROM cloud_chat_ai_policies policy
                   WHERE policy.conversation_id = conversation.conversation_id
                     AND policy.updated_at > run.created_at::timestamptz - interval '30 seconds'))
 LIMIT 1";

/// The prompt to lease a run with, or `None` to keep the stored prompt.
pub(in crate::cloud_agent_runtime::runs) async fn prompt_for_lease(
    pool: &PgPool,
    run_id: &str,
) -> RunResult<Option<String>> {
    Ok(rebuilt_after_change(pool, run_id)
        .await?
        .map(|prompt| prompt.user_prompt))
}

/// The OMP input to give a leased run's context request, or `None` to keep
/// the stored input.
pub(in crate::cloud_agent_runtime::runs) async fn omp_input_for_lease(
    pool: &PgPool,
    run_id: &str,
) -> RunResult<Option<Value>> {
    Ok(rebuilt_after_change(pool, run_id)
        .await?
        .map(|prompt| prompt.omp_input))
}

/// The claim's prompt and OMP input rebuilt under the current settings when
/// the conversation's AI access changed after the claim.
async fn rebuilt_after_change(
    pool: &PgPool,
    run_id: &str,
) -> RunResult<Option<CloudFallbackPrompt>> {
    if !run_id.starts_with(CLAIMED_RUN_PREFIX) || run_id.starts_with(CANARY_RUN_PREFIX) {
        return Ok(None);
    }
    let row: Option<(String, String, String, String, String, Uuid)> =
        query_as(CHANGED_SINCE_CLAIM_SQL)
            .bind(run_id)
            .fetch_optional(pool)
            .await?;
    let Some((request_id, session_id, owner, requester, idempotency_key, conversation_id)) = row
    else {
        return Ok(None);
    };
    let prompt = request_text(pool, conversation_id, &session_id, &request_id, &requester).await?;
    let input = ClaimRunRequest {
        request_message_id: request_id,
        session_id,
        owner_account_id: owner,
        requester_account_id: requester,
        prompt,
        runtime_route: None,
        idempotency_key,
    };
    Ok(Some(fallback_prompt_for_claim(pool, &input).await?))
}

/// The current request as the claim read it: the request message's text, or
/// a scheduled run's task prompt. The prompt falls back to it when the
/// request is no longer among the newest messages.
async fn request_text(
    pool: &PgPool,
    conversation_id: Uuid,
    session_id: &str,
    request_id: &str,
    requester: &str,
) -> RunResult<String> {
    if is_scheduled_run_request_id(request_id) {
        let task: Option<(String,)> = query_as(
            "SELECT task.prompt FROM scheduled_tool_task_runs run
             JOIN scheduled_tool_tasks task ON task.task_id = run.task_id
             WHERE run.run_id = $1",
        )
        .bind(request_id)
        .fetch_optional(pool)
        .await?;
        return Ok(task
            .map(|(prompt,)| prompt.trim().to_string())
            .unwrap_or_default());
    }
    let Some((_, wire)) = request_identity(pool, session_id, request_id, Some(requester)).await?
    else {
        return Ok(String::new());
    };
    let Ok(message_id) = Uuid::parse_str(&wire) else {
        return Ok(String::new());
    };
    let content: Option<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages WHERE conversation_id = $1 AND message_id = $2",
    )
    .bind(conversation_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let body = content
        .map(|(content,)| crate::chat_sync::voice::body_for_agent(&content))
        .unwrap_or_default();
    Ok(history_payload(&body)
        .as_ref()
        .and_then(|payload| payload.get("text"))
        .and_then(Value::as_str)
        .map(strip_leading_agent_mention)
        .unwrap_or_else(|| strip_leading_agent_mention(&body)))
}
