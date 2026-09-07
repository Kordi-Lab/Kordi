//! Identity comes from the authorized run and account records, never mention labels.
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::RunResult;

pub(crate) async fn identity_for_run(pool: &PgPool, run_id: &str) -> RunResult<Value> {
    let (saved, session, request, owner, agent): (Option<Value>, String, String, String, String) =
        query_as(
            "SELECT turn_identity,session_id,request_message_id,owner_account_id,execution_agent_id
         FROM cloud_agent_fallback_runs WHERE run_id=$1",
        )
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    if let Some(saved) = saved {
        return Ok(saved);
    }
    let policy = super::envelopes::cloud_group_request_envelope_for_run(pool, &session, &request)
        .await?
        .and_then(|envelope| super::group_mentions::persona_instruction(&envelope, &owner, &agent));
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
