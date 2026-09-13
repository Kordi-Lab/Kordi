//! Run-authorized history for both desktop and cloud executors.
use super::{ClaimRunRequest, RunError, RunResult};
use crate::server::ServerState;
use serde::Deserialize;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
pub(super) mod media;
mod messages;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextReadRequest {
    runner_id: String,
    tool: String,
    arguments: Value,
}

#[derive(Clone)]
pub(super) struct ContextActor {
    executor: String,
    backend: &'static str,
    account: Option<String>,
}

pub(super) struct ContextScope {
    session_id: String,
    request_message_id: String,
    owner: String,
    requester: String,
    conversation_id: uuid::Uuid,
    title: String,
    kind: String,
}

pub(crate) async fn read_context(
    state: &ServerState,
    run_id: &str,
    input: ContextReadRequest,
) -> RunResult<Value> {
    let actor = ContextActor {
        executor: input.runner_id.trim().into(),
        backend: "cloud",
        account: None,
    };
    read_for_actor(state, run_id, &actor, &input.tool, &input.arguments).await
}

pub(crate) async fn read_desktop_context(
    state: &ServerState,
    run_id: &str,
    account: &str,
    executor: String,
    tool: &str,
    args: &Value,
) -> RunResult<Value> {
    let actor = ContextActor {
        executor,
        backend: "desktop",
        account: Some(account.into()),
    };
    read_for_actor(state, run_id, &actor, tool, args).await
}

async fn authorize(pool: &PgPool, run_id: &str, actor: &ContextActor) -> RunResult<ContextScope> {
    let run: Option<(String,String,String,String)> = query_as(
        "SELECT run.session_id, COALESCE(sub.parent_request_id,parent.request_message_id,run.request_message_id), run.owner_account_id, run.requester_account_id
         FROM cloud_agent_fallback_runs run LEFT JOIN cloud_agent_fallback_runs parent ON parent.run_id=run.parent_run_id LEFT JOIN cloud_agent_subsessions sub ON sub.subsession_id=run.subsession_id
         WHERE run.run_id=$1 AND run.claimed_by=$2 AND run.execution_backend=$3
         AND ($4::text IS NULL OR run.owner_account_id=$4)
         AND run.status IN ('leased','running') AND run.lease_expires_at::timestamptz>now()"
    ).bind(run_id).bind(&actor.executor).bind(actor.backend).bind(&actor.account).fetch_optional(pool).await?;
    let (session_id, request_message_id, owner, requester) = run.ok_or(RunError::NotFound)?;
    let claim = ClaimRunRequest {
        session_id: session_id.clone(),
        request_message_id: request_message_id.clone(),
        owner_account_id: owner.clone(),
        requester_account_id: requester.clone(),
        prompt: String::new(),
        runtime_route: None,
        idempotency_key: String::new(),
    };
    if !super::authorization::validate_shared_cloud_agent_claim(pool, &claim).await? {
        return Err(RunError::NotFound);
    }
    Ok(ContextScope {
        session_id,
        request_message_id,
        owner,
        requester,
        conversation_id: uuid::Uuid::nil(),
        title: String::new(),
        kind: String::new(),
    })
}

async fn read_for_actor(
    state: &ServerState,
    run_id: &str,
    actor: &ContextActor,
    tool: &str,
    args: &Value,
) -> RunResult<Value> {
    let pool = state.db_pool();
    let scope = authorize(pool, run_id, actor).await?;
    if tool == "read_calendar" {
        if scope.owner != scope.requester {
            return Err(RunError::NotFound);
        }
        let child:(bool,)=query_as("SELECT subsession_id IS NOT NULL OR parent_run_id IS NOT NULL FROM cloud_agent_fallback_runs WHERE run_id=$1").bind(run_id).fetch_one(pool).await?;
        if child.0 {
            return Err(RunError::NotFound);
        }
        let mut input: crate::digest::chat_calendar::CalendarReadInput =
            serde_json::from_value(args.clone()).map_err(|_| RunError::NotFound)?;
        if input.session_id.is_some() || input.request_message_id.is_some() {
            return Err(RunError::NotFound);
        }
        if scope.session_id.starts_with("session:group:")
            || scope.session_id.starts_with("session:direct-person:")
        {
            input.session_id = Some(scope.session_id);
            input.request_message_id = Some(scope.request_message_id);
        } else if !scope.session_id.starts_with("session:self-agent:") {
            return Err(RunError::NotFound);
        }
        return crate::digest::chat_calendar::read(pool, &scope.owner, input).await;
    }
    let scope = conversation_scope(pool, scope).await?;
    let search = tool == "search_sessions";
    if !search && (tool != "read_session" || args["sessionId"].as_str() != Some(&scope.session_id))
    {
        return Err(RunError::NotFound);
    }
    if !search && args["mode"] == "attachment" {
        return media::read(state, run_id, actor, &scope, args).await;
    }
    messages::read(pool, &scope, args, search).await
}

async fn conversation_scope(pool: &PgPool, mut scope: ContextScope) -> RunResult<ContextScope> {
    let conversation:Option<(uuid::Uuid,Option<String>,String)>=query_as(
        "SELECT c.conversation_id,c.shared_title,c.kind FROM cloud_chat_conversations c WHERE c.legacy_session_id=$1
         AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=c.conversation_id AND m.account_id=$2 AND m.membership_state='active')
         AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id=c.conversation_id AND m.account_id=$3 AND m.membership_state='active')"
    ).bind(&scope.session_id).bind(&scope.owner).bind(&scope.requester).fetch_optional(pool).await?;
    let (conversation_id, title, kind) = conversation.ok_or(RunError::NotFound)?;
    scope.conversation_id = conversation_id;
    scope.title = title.unwrap_or_else(|| "Conversation".into());
    scope.kind = kind;
    Ok(scope)
}
