//! Identity comes from the authorized run and account records, never mention labels.
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::RunResult;

pub(crate) async fn identity_for_run(pool: &PgPool, run_id: &str) -> RunResult<Value> {
    type RunRow = (
        Option<Value>,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    let (saved, session, request, owner, agent, requester, context_request): RunRow = query_as(
        "SELECT run.turn_identity,run.session_id,run.request_message_id,run.owner_account_id,
                run.execution_agent_id,run.requester_account_id,
                COALESCE(sub.parent_request_id,parent.request_message_id,run.request_message_id)
         FROM cloud_agent_fallback_runs run
         LEFT JOIN cloud_agent_fallback_runs parent ON parent.run_id=run.parent_run_id
         LEFT JOIN cloud_agent_subsessions sub ON sub.subsession_id=run.subsession_id
         WHERE run.run_id=$1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    if let Some(saved) = saved {
        return Ok(saved);
    }
    let persona = super::envelopes::cloud_group_request_envelope_for_run(pool, &session, &request)
        .await?
        .and_then(|envelope| super::group_mentions::persona_instruction(&envelope, &owner, &agent));
    // Both runtimes render requestPolicy, so the conversation access note
    // reaches the model wherever the run executes.
    let context_agent = if agent.is_empty() {
        format!("cloud-agent:{owner}")
    } else {
        agent.clone()
    };
    let guidance = super::context_policy::ContextPolicy::for_run(
        pool,
        &session,
        &owner,
        &requester,
        &context_agent,
        Some(&context_request),
    )
    .await?
    .guidance();
    let policy = match (persona, guidance) {
        (Some(persona), Some(guidance)) => Some(format!("{persona}\n\n{guidance}")),
        (persona, guidance) => persona.or(guidance),
    };
    let (mut identity,): (Value,) = query_as(
        "SELECT
            jsonb_build_object('requestId',r.request_message_id,'agentId',COALESCE(NULLIF(r.execution_agent_id,''),'cloud-agent:'||r.owner_account_id),
                'ownerAccountId',r.owner_account_id,'ownerName',owner.display_name,
                'requesterAccountId',r.requester_account_id,'requesterName',requester.display_name,
                'agentName',COALESCE((SELECT name FROM cloud_agent_definitions
                    WHERE agent_id=r.execution_agent_id AND owner_account_id=r.owner_account_id),
                    profile.display_name,'Kordi'))
         FROM cloud_agent_fallback_runs r JOIN cloud_accounts owner ON owner.account_id=r.owner_account_id
         JOIN cloud_accounts requester ON requester.account_id=r.requester_account_id
         LEFT JOIN cloud_default_agent_profiles profile ON profile.owner_account_id=owner.account_id
         WHERE r.run_id=$1",
    ).bind(run_id).fetch_one(pool).await?;
    if let Some(policy) = policy {
        identity["requestPolicy"] = Value::String(policy);
    }
    // Atomic first-writer wins, including competing lease attempts. Avoid holding
    // a pool connection while reading the request envelope on another connection.
    let (identity,): (Value,) = query_as("UPDATE cloud_agent_fallback_runs SET turn_identity=COALESCE(turn_identity,$2) WHERE run_id=$1 RETURNING turn_identity")
        .bind(run_id)
        .bind(&identity)
        .fetch_one(pool)
        .await?;
    Ok(identity)
}
