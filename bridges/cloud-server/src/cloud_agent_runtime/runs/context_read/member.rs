//! Account-authorized observation does not grant execution or renew a run lease.
use super::*;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberContextInput {
    pub session_id: String,
    #[serde(default)]
    pub source_request_id: Option<String>,
    pub tool: String,
    pub arguments: Value,
}

pub(crate) async fn read_member_context(
    state: &ServerState,
    account: String,
    input: MemberContextInput,
) -> RunResult<Value> {
    if !matches!(input.tool.as_str(), "read_session" | "search_sessions") {
        return Err(RunError::NotFound);
    }
    let actor = ContextActor {
        executor: String::new(),
        backend: "desktop",
        account: Some(account),
        observation: Some((input.session_id, input.source_request_id)),
    };
    read_for_actor(state, "", &actor, &input.tool, &input.arguments).await
}

pub(super) async fn authorize_member(
    pool: &PgPool,
    actor: &ContextActor,
) -> RunResult<ContextScope> {
    let owner = actor.account.clone().ok_or(RunError::NotFound)?;
    let (session_id, source) = actor.observation.as_ref().ok_or(RunError::NotFound)?;
    let (request_message_id, requester) = if let Some(source) = source {
        // A child retains its parent's admitted request identity, not an expired
        // execution lease. Recheck membership, visibility and Agent sharing on every read.
        let (logical, wire) = super::super::request_identity(pool, session_id, source)
            .await?
            .ok_or(RunError::NotFound)?;
        let run: Option<(String, String)> = query_as(
            "SELECT request_message_id,requester_account_id FROM cloud_agent_fallback_runs
             WHERE owner_account_id=$1 AND session_id=$2 AND request_message_id IN ($3,$4)
             AND status IN ('leased','running','completed') ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&owner)
        .bind(session_id)
        .bind(logical)
        .bind(wire)
        .fetch_optional(pool)
        .await?;
        run.ok_or(RunError::NotFound)?
    } else {
        (String::new(), owner.clone())
    };
    if source.is_some() {
        let claim = ClaimRunRequest {
            session_id: session_id.clone(),
            request_message_id: request_message_id.clone(),
            owner_account_id: owner.clone(),
            requester_account_id: requester.clone(),
            prompt: String::new(),
            runtime_route: None,
            idempotency_key: String::new(),
        };
        if !super::super::authorization::validate_shared_cloud_agent_claim(pool, &claim).await? {
            return Err(RunError::NotFound);
        }
    }
    Ok(ContextScope {
        session_id: session_id.clone(),
        request_message_id,
        owner,
        requester,
        conversation_id: uuid::Uuid::nil(),
        title: String::new(),
        kind: String::new(),
    })
}
