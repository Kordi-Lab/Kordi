//! Hosted provider material for the owner Mac executing a run. It is released
//! only with proof that the request comes from the installation holding the
//! device key registered for the session's device.
use super::*;
use crate::auth::device_signatures::{PROOF_ALGORITHM, PROOF_VERSION};
use crate::cloud_agent_runtime::device_proof::{self, DeviceProof, PROVIDER_AUTH_PURPOSE};
use crate::cloud_agent_runtime::provider_auth::{
    provider_auth_for_account_route, EnvProviderAuthCipher, ProviderAuthCipher,
    ProviderAuthForRunResult, RunnerProviderAuthMaterialEnvelope,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::cloud_agent_runtime) struct ProviderAuthInput {
    claim_id: Uuid,
    #[serde(default)]
    device_proof: Option<DeviceProof>,
}

fn device_key_required() -> Response {
    error_response(
        "device_key_required",
        "This Mac has no registered device key. Sign out of Kordi and sign in again on this Mac to use hosted provider accounts here.",
        StatusCode::FORBIDDEN,
    )
}

fn device_proof_required() -> Response {
    error_response(
        "device_proof_required",
        "Update Kordi on this Mac to use hosted provider accounts here.",
        StatusCode::FORBIDDEN,
    )
}

fn device_proof_invalid() -> Response {
    error_response(
        "device_proof_invalid",
        "This Mac could not prove that it holds its registered device key.",
        StatusCode::FORBIDDEN,
    )
}

/// Issues the single-use challenge the owner Mac signs with its device key
/// before it requests provider material for the run it executes. The
/// response names the signed-text version and the session's device; the
/// desktop names this server's origin itself.
pub(in crate::cloud_agent_runtime) async fn provider_auth_challenge(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<RenewalInput>,
) -> Response {
    let pool = state.db_pool();
    let owner = executor(&session, input.claim_id);
    let issued = async {
        if desktop_provider_route(pool, &session, &run_id, &owner)
            .await?
            .is_none()
        {
            return Ok(Err(expired()));
        }
        if device_proof::device_key(pool, &session.account_id, &session.device_id)
            .await?
            .is_none()
        {
            return Ok(Err(device_key_required()));
        }
        device_proof::issue_challenge(
            pool,
            &session.account_id,
            &session.device_id,
            &run_id,
            input.claim_id,
        )
        .await
        .map(Ok)
    }
    .await;
    match issued {
        Ok(Ok((nonce, expires_at))) => Json(json!({
            "nonce": nonce,
            "expiresAt": expires_at.to_rfc3339(),
            "algorithm": PROOF_ALGORITHM,
            "purpose": PROVIDER_AUTH_PURPOSE,
            "version": PROOF_VERSION,
            "deviceId": session.device_id,
        }))
        .into_response(),
        Ok(Err(response)) => response,
        Err(error) => run_error_response(
            "device proof challenge",
            "Could not issue a device challenge.",
            error.into(),
        ),
    }
}

/// Refuses the request unless it carries a valid proof for this run and
/// claim. Without a registered key the refusal says how to register one, and
/// a proof of an earlier signed-text version asks for a desktop update.
async fn device_proof_refusal(
    pool: &PgPool,
    session: &CloudSession,
    run_id: &str,
    input: &ProviderAuthInput,
) -> Option<Response> {
    let refusal = async {
        if let Some(proof) = input.device_proof.as_ref() {
            if device_proof::verify_provider_auth_proof(
                pool,
                &session.account_id,
                &session.device_id,
                run_id,
                input.claim_id,
                proof,
            )
            .await?
            {
                return Ok(None);
            }
        }
        let registered = device_proof::device_key(pool, &session.account_id, &session.device_id)
            .await?
            .is_some();
        Ok::<_, sqlx_core::Error>(Some(match (registered, &input.device_proof) {
            (false, _) => device_key_required(),
            (true, None) => device_proof_required(),
            (true, Some(proof)) if !proof.is_current_version() => device_proof_required(),
            (true, Some(_)) => device_proof_invalid(),
        }))
    }
    .await;
    refusal.unwrap_or_else(|error| {
        Some(run_error_response(
            "device proof",
            "Could not verify the device proof.",
            error.into(),
        ))
    })
}

/// Material is returned only to the authenticated owner Mac holding this
/// run's current execution lease, with a fresh proof of its device key. The
/// browser never receives this response.
pub(in crate::cloud_agent_runtime) async fn provider_auth(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<ProviderAuthInput>,
) -> Response {
    let owner = executor(&session, input.claim_id);
    let route = match desktop_provider_route(state.db_pool(), &session, &run_id, &owner).await {
        Ok(Some(route)) => route,
        Ok(None) => return expired(),
        Err(error) => {
            return run_error_response(
                "desktop provider auth",
                "Could not load provider account.",
                error.into(),
            )
        }
    };
    if let Some(refusal) = device_proof_refusal(state.db_pool(), &session, &run_id, &input).await {
        return refusal;
    }
    let cipher = EnvProviderAuthCipher::from_env().ok();
    let result = provider_auth_for_account_route(
        state.db_pool(),
        cipher
            .as_ref()
            .map(|value| value as &dyn ProviderAuthCipher),
        &session.account_id,
        &route,
        Some(&run_id),
    )
    .await;
    // Resolving an OAuth account can refresh its token. Check the lease again
    // before handing the resulting short-lived material to the desktop.
    match desktop_provider_route(state.db_pool(), &session, &run_id, &owner).await {
        Ok(Some(current)) if current == route => {}
        Ok(_) => return expired(),
        Err(error) => {
            return run_error_response(
                "desktop provider auth",
                "Could not load provider account.",
                error.into(),
            )
        }
    }
    match result {
        Ok(ProviderAuthForRunResult::Found(provider_auth)) => {
            Json(RunnerProviderAuthMaterialEnvelope { provider_auth }).into_response()
        }
        Ok(ProviderAuthForRunResult::ProviderAuthNotFound) => error_response(
            "provider_auth_not_found",
            "Provider account was not found for this run.",
            StatusCode::NOT_FOUND,
        ),
        Ok(ProviderAuthForRunResult::ProviderAuthCipherUnavailable) => error_response(
            "provider_auth_not_configured",
            "Provider accounts are unavailable.",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        Ok(ProviderAuthForRunResult::RunNotFound) => expired(),
        Err(error) => run_error_response(
            "desktop provider auth",
            "Could not load provider account.",
            error.into(),
        ),
    }
}

async fn desktop_provider_route(
    pool: &PgPool,
    session: &CloudSession,
    run_id: &str,
    owner: &str,
) -> Result<Option<Value>, sqlx_core::Error> {
    let row: Option<(Value,)> = query_as(
        "SELECT r.runtime_route_json FROM cloud_agent_fallback_runs r \
         JOIN cloud_devices d ON d.device_id=$3 AND d.account_id=$2 \
         WHERE r.run_id=$1 AND r.owner_account_id=$2 AND r.claimed_by=$4 \
         AND r.execution_backend='desktop' AND r.status IN ('leased','running') \
         AND r.lease_expires_at::timestamptz>now() \
         AND d.device_platform IN ('macos','desktop') AND d.revoked_at IS NULL",
    )
    .bind(run_id)
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|value| value.0))
}
