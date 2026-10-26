//! Admission of a run by its authenticated owning desktop.
use super::*;
use crate::cloud_agent_runtime::{runs, subsession_execution};
use runs::{claim_run_for_desktop, validate_shared_cloud_agent_claim};

/// Whether a Mac of `owner` is online and ready to run `agent`.
pub(crate) async fn agent_desktop_ready(
    pool: &PgPool,
    owner: &str,
    agent: &str,
) -> Result<bool, sqlx_core::Error> {
    // Fresh capability and presence are the admission boundary. If the Mac
    // stops heartbeating, Cloud may claim the same request after they expire.
    let row: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_desktop_capabilities r JOIN cloud_devices d USING(device_id) JOIN cloud_device_presence p USING(device_id) WHERE d.account_id=$1 AND d.revoked_at IS NULL AND r.agent_id=$2 AND r.updated_at>now()-interval '35 seconds' AND p.state='online' AND p.last_heartbeat_at::timestamptz>now()-interval '35 seconds')")
        .bind(owner).bind(agent).fetch_one(pool).await?;
    Ok(row.0)
}

pub(in crate::cloud_agent_runtime) async fn claim(
    state: State<Arc<ServerState>>,
    session: Extension<CloudSession>,
    input: Json<DesktopClaimInput>,
) -> Response {
    let started = std::time::Instant::now();
    let response = claim_request(state, session, input).await;
    let outcome = response.status();
    super::super::run_locks::log_op("desktop_claim", None, outcome.as_str(), started);
    response
}

async fn claim_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(mut input): Json<DesktopClaimInput>,
) -> Response {
    if !input.run.is_well_formed() || input.run.owner_account_id != session.account_id {
        return denied();
    }
    // Proactive runs need no project folder, so they skip the project rule:
    // an evaluation's only tool searches memories, and an approved run works
    // in an empty folder of its own. Matched by run id before any chat
    // request path.
    if crate::proactive::desktop::is_evaluation(&input.run.request_message_id) {
        let (pool, run_id) = (state.db_pool(), input.run.request_message_id.trim());
        let (claim_id, route) = (input.claim_id, input.run.runtime_route.as_ref());
        // A personal agent evaluation is claimed like a proactive one.
        let claimed = if run_id.starts_with(crate::proactive::RUN_PREFIX) {
            let claim = crate::proactive::desktop::claim_evaluation;
            claim(pool, &session, claim_id, run_id, route).await
        } else {
            let claim = crate::personal_agent::desktop::claim_evaluation;
            claim(pool, &session, claim_id, run_id, route).await
        };
        return match claimed {
            Ok(Some(value)) => Json(value).into_response(),
            Ok(None) => denied(),
            Err(e) => run_error_response(
                "desktop claim",
                "Could not claim agent execution.",
                e.into(),
            ),
        };
    }
    // An approved proactive run already exists and answers a message that
    // never mentioned the agent, so it never reaches group mention checks.
    if input
        .run
        .request_message_id
        .starts_with(crate::proactive::APPROVED_RUN_PREFIX)
    {
        let claim = crate::proactive::desktop::claim_approved;
        return match claim(state.db_pool(), &session, input.claim_id, &input.run).await {
            Ok(Some(value)) => context_scope_response(&state, value).await,
            Ok(None) => denied(),
            Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
        };
    }
    let project = match crate::projects::project_route(
        state.db_pool(),
        &session.account_id,
        &input.run.session_id,
        Some(&session.device_id),
    )
    .await
    {
        Ok(project) => project,
        Err(error) => {
            return run_error_response(
                "project routing",
                "Could not resolve this project device.",
                error.into(),
            )
        }
    };
    // Another Mac runs a project session only when its build moves the session
    // into its own folder of the project first (`bindsProject`).
    if let Some(route) = project.as_ref().filter(|route| {
        !route.admits(&session.device_id)
            || (route.project_device_id != session.device_id && !input.binds_project)
    }) {
        if route
            .runners
            .iter()
            .any(|runner| runner != &session.device_id)
        {
            return Json(json!({"acquired":false})).into_response();
        }
        // No Mac with the project is online: end the request now with a reply
        // that says where to run it, instead of leaving it with no status.
        let message = route.unavailable_message();
        return match runs::fail_unavailable_project_request(state.db_pool(), &input.run, &message)
            .await
        {
            Ok(run) => Json(json!({"acquired":false,"runId":run.run_id,"errorCode":runs::PROJECT_UNAVAILABLE_ERROR_CODE,"message":message})).into_response(),
            // Not a chat request of this session, such as a follow-up or comment run.
            Err(runs::RunError::NotFound) => Json(json!({"acquired":false})).into_response(),
            Err(e) => run_error_response("project routing", "Could not end this project request.", e),
        };
    }
    // A digest run is the owner's own background run and has no chat message.
    if input
        .run
        .request_message_id
        .starts_with(crate::digest::RUN_PREFIX)
    {
        let claim = crate::digest::desktop::claim;
        return match claim(
            state.db_pool(),
            &session,
            input.claim_id,
            input.run.request_message_id.trim(),
            input.run.runtime_route.as_ref(),
        )
        .await
        {
            Ok(Some(value)) => Json(value).into_response(),
            Ok(None) => denied(),
            Err(e) => run_error_response(
                "desktop claim",
                "Could not claim agent execution.",
                e.into(),
            ),
        };
    }
    // A scheduled run is an occurrence of the owner's task, not a chat message.
    if input.run.request_message_id.starts_with("scheduled_run_") {
        let owner = executor(&session, input.claim_id);
        let claim = crate::scheduled_tasks::mac::claim;
        return match claim(state.db_pool(), &session, &owner, &input.run).await {
            Ok(Some(value)) => context_scope_response(&state, value).await,
            Ok(None) => denied(),
            Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
        };
    }
    // A comment run exists before its claim and has no chat message.
    if crate::document_shares::agents::is_comment_request(&input.run.request_message_id) {
        let owner = executor(&session, input.claim_id);
        let claim = crate::document_shares::agents::desktop::claim;
        return match claim(state.db_pool(), &session.device_id, &owner, &input.run).await {
            Ok(Some(value)) => context_scope_response(&state, value).await,
            Ok(None) => denied(),
            Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
        };
    }
    match subsession_execution::claim(
        state.db_pool(),
        &session,
        &input.run,
        &executor(&session, input.claim_id),
    )
    .await
    {
        Ok(Some(value)) => return context_scope_response(&state, value).await,
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
            .bind(wire_id).bind(&input.run.session_id).bind(&input.run.requester_account_id).bind(&session.account_id).bind(&session.device_id).bind(agent).fetch_one(state.db_pool()).await?;
        if !allowed.0 || !runs::validate_group_agent_claim(state.db_pool(), &input.run).await? || !validate_shared_cloud_agent_claim(state.db_pool(), &input.run).await? { return Ok::<_, runs::RunError>(None); }
        let owner = executor(&session, input.claim_id);
        let run = claim_run_for_desktop(state.db_pool(), &input.run, &owner).await?;
        let acquired: (bool,) = query_as("SELECT execution_backend='desktop' AND claimed_by=$2 AND status IN ('leased','running') AND lease_expires_at::timestamptz>now() FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run.run_id).bind(owner).fetch_one(state.db_pool()).await?;
        let identity = if acquired.0 { Some(runs::identity::identity_for_run(state.db_pool(), &run.run_id).await?) } else { None };
        let mut value = json!({"runId":run.run_id,"acquired":acquired.0,"leaseSeconds":45,"turnIdentity":identity});
        // The claiming Mac runs the turn in its own folder of this project.
        if let Some(route) = project.as_ref() {
            value["project"] = json!({"id":route.project_id,"name":route.project_name,"workspaceId":route.workspace_id});
        }
        Ok(Some(value))
    }.await;
    match result {
        Ok(Some(value)) => context_scope_response(&state, value).await,
        Ok(None) => denied(),
        Err(e) => run_error_response("desktop claim", "Could not claim agent execution.", e),
    }
}
