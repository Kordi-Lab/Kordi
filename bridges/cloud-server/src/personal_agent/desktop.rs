//! Evaluations on the owner's Mac, through the proactive evaluation path
//! (docs/development/proactive-agent.md, "Mac execution"). The sweep holds a
//! new evaluation for one presence timeout while the Mac's `proactive`
//! readiness row is fresh and announces it with `personal_agent.eval_requested`.
//! The Mac claims it through the generic desktop claim route with the run id
//! as `requestMessageId` ([`claim_evaluation`]), answers `search_memory`
//! through the digest observe route, and ends it through
//! `POST /v1/cloud/proactive/desktop/{run_id}/complete`, which calls the same
//! completion as the cloud runner.

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;

/// Admits the signed-in owner's Mac to the queued evaluation `run_id`, with
/// the answer shape of a proactive evaluation claim
/// (`"proactive": {"kind": "evaluation", …}`). `Ok(None)` refuses the
/// claim: the Mac is not ready for proactive runs, or the run is not its
/// agent's active evaluation.
pub(crate) async fn claim_evaluation(
    pool: &PgPool,
    session: &CloudSession,
    claim_id: Uuid,
    run_id: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<Option<Value>, sqlx_core::Error> {
    let owner = &session.account_id;
    let active: Option<(Option<Value>, String)> = query_as(
        "SELECT run.runtime_route_json, run.execution_agent_id
         FROM cloud_personal_agent_state state
         JOIN cloud_agent_fallback_runs run ON run.run_id = state.active_run_id
         WHERE state.active_run_id = $1 AND state.owner_account_id = $2
           AND run.owner_account_id = $2 AND run.execution_agent_id = state.agent_id",
    )
    .bind(run_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    let Some((asked, agent_id)) = active else {
        return Ok(None);
    };
    let claim = crate::proactive::desktop::evaluation_claim;
    claim(pool, session, claim_id, run_id, route, asked, &agent_id).await
}
