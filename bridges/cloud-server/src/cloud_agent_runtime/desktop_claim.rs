//! Admission of a run by its authenticated owning desktop.
use super::*;
use crate::auth::rate_limit::CloudRateLimiter;
use crate::cloud_agent_runtime::{claim_route::agent_run_rate_limited, runs, subsession_execution};
use runs::{claim_run, claim_run_for_desktop, requester_may_invoke};

enum Admission {
    Decided(Value),
    /// The run's route selects a hosted provider account that this Mac
    /// cannot use.
    NeedsDeviceProof,
}

pub(in crate::cloud_agent_runtime) async fn claim(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    rate_limiter: Option<Extension<Arc<CloudRateLimiter>>>,
    Json(mut input): Json<DesktopClaimInput>,
) -> Response {
    if !input.run.is_well_formed() || input.run.owner_account_id != session.account_id {
        return denied();
    }
    let project_session = match crate::projects::session_device(
        state.db_pool(),
        &session.account_id,
        &input.run.session_id,
    )
    .await
    {
        Ok(Some(device)) if device != session.device_id => {
            return Json(json!({"acquired":false})).into_response()
        }
        Ok(device) => device.is_some(),
        Err(error) => {
            return run_error_response(
                "project routing",
                "Could not resolve this project device.",
                error.into(),
            )
        }
    };
    match subsession_execution::claim(
        state.db_pool(),
        &session,
        &input.run,
        &executor(&session, input.claim_id),
    )
    .await
    {
        Ok(Some(value)) => return context_scope_response(state.db_pool(), value).await,
        Ok(None) => {}
        Err(error) => {
            return run_error_response(
                "subsession admission",
                "Could not admit the follow-up.",
                error,
            )
        }
    }
    let result = async {
        let Some((request_id,wire_id))=runs::request_identity(state.db_pool(),&input.run.session_id,&input.run.request_message_id).await? else { return Ok::<_,runs::RunError>(None); };
        input.run.request_message_id=request_id;
        let agent = execution_agent_id(state.db_pool(), &input.run).await?;
        let allowed: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id WHERE m.message_id::text=$1 AND c.legacy_session_id=$2 AND m.sender_account_id=$3 AND m.deleted_at IS NULL AND member.account_id=$4 AND member.membership_state='active') AND EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities r JOIN cloud_devices d USING(device_id) WHERE r.device_id=$5 AND d.account_id=$4 AND d.revoked_at IS NULL AND r.agent_id=$6 AND r.updated_at>now()-interval '35 seconds')")
            .bind(wire_id).bind(&input.run.session_id).bind(&input.run.requester_account_id).bind(&session.account_id).bind(&session.device_id).bind(&agent).fetch_one(state.db_pool()).await?;
        if !allowed.0 || !runs::claim_conversation_admits_run(state.db_pool(), &input.run).await? || !runs::validate_group_agent_claim(state.db_pool(), &input.run).await? || !requester_may_invoke(state.db_pool(), &input.run).await? { return Ok::<_, runs::RunError>(None); }
        // A project session has no cloud fallback, so its Mac claims the run
        // and reports a missing device proof when it requests provider material.
        if !project_session && !hosted_execution_permitted(state.db_pool(), &session, &input.run, &agent).await? {
            return Ok(Some(Admission::NeedsDeviceProof));
        }
        let owner = executor(&session, input.claim_id);
        let run = claim_run_for_desktop(state.db_pool(), &input.run, &owner).await?;
        let acquired: (bool,) = query_as("SELECT execution_backend='desktop' AND claimed_by=$2 AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run.run_id).bind(owner).fetch_one(state.db_pool()).await?;
        let identity = if acquired.0 { Some(runs::identity::identity_for_run(state.db_pool(), &run.run_id).await?) } else { None };
        Ok(Some(Admission::Decided(json!({"runId":run.run_id,"acquired":acquired.0,"leaseSeconds":45,"turnIdentity":identity}))))
    }.await;
    match result {
        Ok(Some(Admission::Decided(value))) => context_scope_response(state.db_pool(), value).await,
        Ok(Some(Admission::NeedsDeviceProof)) => {
            hand_off_hosted_run(state.db_pool(), &session, rate_limiter, &input.run).await
        }
        Ok(None) => denied(),
        Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
    }
}

/// Hands a run this Mac cannot execute to a runtime that can. The owner's
/// route here comes from this Mac's settings for the session, so it can
/// select a hosted account where the route in the caller's admission request
/// does not, and that admission then waits for this Mac. Unless another ready
/// Mac that proves its device key will claim the run, Cloud queues it on this
/// route under the same request, and admission returns that run.
async fn hand_off_hosted_run(
    pool: &PgPool,
    session: &CloudSession,
    rate_limiter: Option<Extension<Arc<CloudRateLimiter>>>,
    run: &ClaimRunRequest,
) -> Response {
    let not_acquired = || Json(json!({"acquired":false})).into_response();
    // Another requester's run uses the agent's stored route in both claims,
    // so that requester's admission already sends it to Cloud.
    if run.requester_account_id != session.account_id {
        return not_acquired();
    }
    match prefer_ready_desktop(pool, run).await {
        Ok(true) => return not_acquired(),
        Ok(false) => {}
        Err(error) => {
            return run_error_response("desktop claim", "Could not claim agent execution.", error)
        }
    }
    if let Some(response) = agent_run_rate_limited(rate_limiter, &session.account_id).await {
        return response;
    }
    match claim_run(pool, run).await {
        Ok(queued) => Json(json!({
            "runId": queued.run_id,
            "acquired": false,
            "executionBackend": queued.execution_backend,
        }))
        .into_response(),
        Err(error) => run_error_response(
            "desktop hand-off",
            "Could not hand the request to Cloud.",
            error,
        ),
    }
}

/// Runs on hosted provider accounts need a desktop that published readiness
/// with device proofs and has a registered device key. Any other desktop
/// hands them off.
async fn hosted_execution_permitted(
    pool: &PgPool,
    session: &CloudSession,
    run: &ClaimRunRequest,
    agent: &str,
) -> runs::RunResult<bool> {
    let route = runs::runtime_route_for_claim(pool, run).await?;
    if !crate::cloud_agent_runtime::device_proof::route_uses_hosted_auth(&route) {
        return Ok(true);
    }
    let row: (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities r JOIN cloud_devices d USING(device_id) \
         WHERE r.device_id=$1 AND r.agent_id=$2 AND r.device_proof AND d.account_id=$3 \
         AND d.device_key_algorithm='p256' AND d.revoked_at IS NULL)",
    )
    .bind(&session.device_id)
    .bind(agent)
    .bind(&session.account_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}
