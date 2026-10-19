//! Starting a run from a comment that mentions an agent.
//!
//! [`plan`] runs before the comment is stored: it resolves the mention,
//! skips a repeat of a request that is still being answered, and charges the
//! requester's agent-run budget (the document owner's for a public reader),
//! refusing with `429` like every other agent run. [`start`] runs after the
//! comment exists and queues one run per comment and agent in
//! `cloud_agent_fallback_runs`, for the owner's ready Mac first ([`desktop`])
//! and the cloud runner otherwise.

use axum::http::StatusCode;
use axum::response::Response;
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::access::{document_session, DocumentRecord, ShareRow};
use super::super::contents::document_source;
use super::super::events::publish_agent_request;
use super::super::render::document_blocks;
use super::super::{db_error, err, Caller};
use super::comment_request_id;
use super::desktop;
use super::gating::{offered_tools, ToolGate};
use super::mentions::{
    candidates_for_account, candidates_for_reader, resolve_mention, ResolvedAgent,
};
use super::prompt::{build_prompt, build_system_prompt, PromptInput, ThreadLine};
use super::threads::{load_comments, thread_of};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::cloud_agent_runtime::runs::route_fill::fill_cloud_route;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;
use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;
use crate::connectors::models::{ConnectorAudience, RunTrigger};
use crate::server::ServerState;

/// A comment about to be stored, as the mention rules see it.
pub(crate) struct MentionContext<'a> {
    pub record: &'a DocumentRecord,
    pub caller: &'a Caller,
    /// The share a public reader came through.
    pub share: Option<&'a ShareRow>,
    pub body: &'a str,
    pub block_id: &'a str,
    pub parent_comment_id: Option<&'a str>,
}

/// A run the comment will start once it is stored.
#[derive(Debug, Clone)]
pub(crate) struct PlannedRun {
    pub agent: ResolvedAgent,
    pub session_id: String,
    /// Who pays for and owns the request: the commenter, or the document
    /// owner for a public reader.
    pub requester_account_id: String,
    pub public_reader: bool,
}

impl PlannedRun {
    /// Person-started only when the commenter owns the agent; a public
    /// reader's run is always a background run.
    pub(crate) fn trigger(&self) -> RunTrigger {
        if self.public_reader {
            RunTrigger::Background
        } else {
            RunTrigger::for_person_message(&self.agent.owner_account_id, &self.requester_account_id)
        }
    }
}

fn rate_limited(retry_after: std::time::Duration) -> Response {
    let mut response = err(
        "rate_limited",
        "Too many agent requests. Try again shortly.",
        StatusCode::TOO_MANY_REQUESTS,
    );
    if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
        response.headers_mut().insert("Retry-After", value);
    }
    response
}

/// Whether the same author already asked the same agent the same thing in
/// the same place and that run has not ended. A double submit then stores
/// the comment without a second run.
async fn same_request_pending(
    pool: &PgPool,
    ctx: &MentionContext<'_>,
    agent_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (account_id, reader_key) = ctx.caller.columns();
    let (pending,): (bool,) = query_as(
        "SELECT EXISTS ( \
           SELECT 1 FROM cloud_document_comments comment \
           JOIN cloud_agent_fallback_runs run ON run.document_comment_id = comment.comment_id \
           WHERE comment.attachment_id = $1 AND comment.block_id = $2 \
             AND comment.parent_comment_id IS NOT DISTINCT FROM $3 AND comment.body = $4 \
             AND comment.author_account_id IS NOT DISTINCT FROM $5 \
             AND comment.author_reader_key IS NOT DISTINCT FROM $6 \
             AND comment.deleted_at IS NULL AND run.execution_agent_id = $7 \
             AND run.status IN ('queued', 'leased', 'running'))",
    )
    .bind(&ctx.record.attachment_id)
    .bind(ctx.block_id)
    .bind(ctx.parent_comment_id)
    .bind(ctx.body)
    .bind(account_id)
    .bind(reader_key)
    .bind(agent_id)
    .fetch_one(pool)
    .await?;
    Ok(pending)
}

/// Resolves the comment's mention and charges the run. `Ok(None)` when the
/// comment starts no run; `Err` is the `429` or a database error, and the
/// comment is then not stored.
pub(crate) async fn plan(
    state: &ServerState,
    rate_limiter: &CloudRateLimiter,
    ctx: &MentionContext<'_>,
) -> Result<Option<PlannedRun>, Box<Response>> {
    if !ctx.body.contains('@') {
        return Ok(None);
    }
    let pool = state.db_pool();
    let canonical = &ctx.record.attachment_id;
    let (requester, public_reader) = match ctx.caller {
        Caller::Account(account) => (account.clone(), false),
        Caller::Reader(_) => {
            if !ctx.share.is_some_and(|share| share.readers_can_ask_agent) {
                return Ok(None);
            }
            (ctx.record.owner_account_id.clone(), true)
        }
    };
    let Some((session_id, _)) = document_session(pool, canonical, Some(&requester))
        .await
        .map_err(|_| db_error())?
    else {
        return Ok(None);
    };
    let candidates = if public_reader {
        candidates_for_reader(pool, &requester).await
    } else {
        candidates_for_account(pool, &requester, &session_id).await
    }
    .map_err(|_| db_error())?;
    let Some(agent) = resolve_mention(ctx.body, &candidates) else {
        return Ok(None);
    };
    if same_request_pending(pool, ctx, &agent.agent_id)
        .await
        .map_err(|_| db_error())?
    {
        return Ok(None);
    }
    if let RateLimitDecision::Limited { retry_after } =
        rate_limiter.observe_agent_run(&requester).await
    {
        return Err(Box::new(rate_limited(retry_after)));
    }
    Ok(Some(PlannedRun {
        agent,
        session_id,
        requester_account_id: requester,
        public_reader,
    }))
}

/// The named agent's own system prompt and stored route, when the agent is
/// not the owner's default agent.
async fn definition(
    pool: &PgPool,
    agent: &ResolvedAgent,
) -> Result<Option<(String, AgentRuntimeRoute)>, sqlx_core::Error> {
    let row: Option<(String, serde_json::Value)> = query_as(
        "SELECT system_prompt, model_routing_json FROM cloud_agent_definitions \
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
    )
    .bind(&agent.agent_id)
    .bind(&agent.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(system_prompt, route)| {
        (
            system_prompt,
            serde_json::from_value::<AgentRuntimeRoute>(route).unwrap_or_default(),
        )
    }))
}

/// Queues the run for `comment_id`. Idempotent per comment and agent: a
/// second call returns the first run's id. Errors are for the caller to log;
/// the comment stays either way.
pub(crate) async fn start(
    state: &ServerState,
    record: &DocumentRecord,
    comment_id: &str,
    plan: &PlannedRun,
) -> Result<String, sqlx_core::Error> {
    let pool = state.db_pool();
    let failed = |what: &str| sqlx_core::Error::Protocol(format!("comment run: {what}"));
    let source = document_source(state, record)
        .await
        .map_err(|_| failed("document source"))?;
    let comments = load_comments(pool, &record.attachment_id).await?;
    let comment = comments
        .iter()
        .find(|comment| comment.comment_id == comment_id)
        .ok_or_else(|| failed("comment is gone"))?;
    let thread: Vec<ThreadLine<'_>> = thread_of(&comments, comment.root_id())
        .into_iter()
        .take_while(|entry| entry.comment_id != comment_id)
        .map(|entry| ThreadLine {
            author: &entry.author,
            by_agent: entry.by_agent,
            body: &entry.body,
        })
        .collect();
    let blocks = document_blocks(record.format, &source.text);
    let title = record.title(&source.text);
    let user_prompt = build_prompt(&PromptInput {
        title: &title,
        attachment_id: &record.attachment_id,
        revision: source.revision,
        blocks: &blocks,
        block_id: &comment.block_id,
        thread: &thread,
        requester_name: &comment.author,
        request: &comment.body,
    });
    let trigger = plan.trigger();
    let viewer = if record.owner_account_id == plan.requester_account_id {
        super::super::model::Viewer::Owner
    } else {
        super::super::model::Viewer::Member
    };
    let can_edit = offered_tools(&ToolGate {
        comment_run: true,
        trigger,
        scheduled: false,
        public_reader: plan.public_reader,
        requester_can_edit: super::super::canonical::can_edit(
            pool,
            record,
            viewer,
            &plan.requester_account_id,
        )
        .await?,
        session_has_document: true,
        group_session: false,
        owner_request: plan.requester_account_id == plan.agent.owner_account_id,
        desktop_backend: false,
    })
    .edit;
    let owner = &plan.agent.owner_account_id;
    let named = definition(pool, &plan.agent).await?;
    let system_prompt = build_system_prompt(
        &plan.agent.name,
        named.as_ref().map(|(prompt, _)| prompt.as_str()),
        can_edit,
    );
    let route = named.map(|(_, route)| route).unwrap_or_default();
    let route = fill_cloud_route(pool, owner, &plan.session_id, route).await?;
    let route =
        serde_json::to_value(route).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    let sandbox =
        ensure_sandbox_for_run(pool, &plan.session_id, owner, &plan.requester_account_id).await?;
    let request_id = comment_request_id(comment_id);
    let now = Utc::now().to_rfc3339();
    // Routed like a chat run: a ready Mac of the owner gets the first chance
    // and the cloud runner waits until `desktop_preferred_until`.
    let agent_id = &plan.agent.agent_id;
    let prefer_desktop =
        desktop::prefer_desktop(pool, owner, agent_id, &plan.session_id, plan.public_reader)
            .await?;
    let preferred_until = prefer_desktop.then(desktop::desktop_preferred_until);
    // Other accounts read the reply, so the run gets no connector tools.
    let inserted = query(
        "INSERT INTO cloud_agent_fallback_runs ( \
            run_id, idempotency_key, request_message_id, session_id, owner_account_id, \
            requester_account_id, status, prompt, system_prompt, sandbox_id, runtime_route_json, \
            created_at, updated_at, execution_backend, execution_agent_id, run_trigger, \
            connector_audience, document_comment_id, desktop_preferred_until \
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $11, 'cloud', $12, \
                   $13, $14, $15, $16) \
         ON CONFLICT DO NOTHING",
    )
    .bind(format!("car_{}", uuid::Uuid::new_v4().simple()))
    .bind(format!("{request_id}:{}", plan.agent.agent_id))
    .bind(&request_id)
    .bind(&plan.session_id)
    .bind(owner)
    .bind(&plan.requester_account_id)
    .bind(&user_prompt)
    .bind(&system_prompt)
    .bind(&sandbox.sandbox_id)
    .bind(route)
    .bind(&now)
    .bind(&plan.agent.agent_id)
    .bind(trigger.as_str())
    .bind(ConnectorAudience::Shared.as_str())
    .bind(comment_id)
    .bind(preferred_until)
    .execute(pool)
    .await?;
    if prefer_desktop && inserted.rows_affected() == 1 {
        // The Mac runs its own agent definition, so the guidance a cloud run
        // gets as its system prompt travels in the prompt.
        let guidance = build_system_prompt(&plan.agent.name, None, can_edit);
        let request = desktop::AgentRequest {
            comment_id,
            attachment_id: &record.attachment_id,
            session_id: &plan.session_id,
            requester_account_id: &plan.requester_account_id,
            agent_id,
            prompt: &format!("{guidance}\n\n{user_prompt}"),
        };
        let payload = desktop::agent_request_payload(&request);
        publish_agent_request(pool, owner, &payload).await;
    }
    let (run_id,): (String,) = query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 AND execution_agent_id = $2 AND request_message_id = $3 \
           AND NOT legacy_duplicate",
    )
    .bind(owner)
    .bind(&plan.agent.agent_id)
    .bind(&request_id)
    .fetch_one(pool)
    .await?;
    Ok(run_id)
}
