use super::*;

pub(super) async fn refresh_runner_provider_auth(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RefreshRunnerProviderAuthRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let runner_id = input.runner_id.trim();
    let snapshot_id = input.snapshot_id.trim();
    if runner_id.is_empty() || snapshot_id.is_empty() || !input.payload.is_object() {
        return error_response(
            "invalid_provider_auth_refresh",
            "runnerId, snapshotId, and an object payload are required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let cipher = match EnvProviderAuthCipher::from_env() {
        Ok(cipher) => cipher,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] provider auth cipher unavailable: {err}");
            return error_response(
                "provider_auth_not_configured",
                "Cloud provider-auth snapshots are not configured on this server.",
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    };
    match refresh_provider_auth_for_run(
        state.db_pool(),
        &cipher,
        &run_id,
        runner_id,
        snapshot_id,
        input.payload,
    )
    .await
    {
        Ok(RefreshProviderAuthForRunResult::Refreshed {
            account_id,
            material: provider_auth,
        }) => {
            state
                .events()
                .publish_provider_auth_updated(&account_id)
                .await;
            Json(RunnerProviderAuthMaterialEnvelope { provider_auth }).into_response()
        }
        Ok(RefreshProviderAuthForRunResult::RunNotFound) => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        Ok(RefreshProviderAuthForRunResult::SnapshotNotFound) => error_response(
            "provider_auth_not_found",
            "Cloud provider-auth snapshot was not found for this run.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] refresh provider auth for run: {err}");
            error_response(
                "server_error",
                "Could not refresh Cloud provider-auth material.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

pub(super) async fn restore_provider_auth_snapshots(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<RestoreProviderAuthSnapshotsRequest>,
) -> Response {
    let Some(device_public_key) = input.decoded_device_public_key() else {
        return error_response(
            "invalid_provider_auth_restore_key",
            "A valid device public key is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    match authorize_device_restore_key(
        state.db_pool(),
        &session.token_id,
        &session.account_id,
        &session.device_id,
        &device_public_key,
    )
    .await
    {
        Ok(DeviceRestoreKeyAuthorization::Allowed) => {}
        Ok(DeviceRestoreKeyAuthorization::ReauthenticationRequired) => {
            return error_response(
                "provider_auth_restore_reauthentication_required",
                "Sign in again on this device to restore provider authentication.",
                StatusCode::FORBIDDEN,
            );
        }
        Ok(DeviceRestoreKeyAuthorization::KeyMismatch) => {
            return error_response(
                "provider_auth_restore_device_key_mismatch",
                "This device must sign in again before its provider authentication can be restored.",
                StatusCode::FORBIDDEN,
            );
        }
        Ok(DeviceRestoreKeyAuthorization::DeviceNotFound) => {
            return error_response(
                "provider_auth_restore_device_not_found",
                "The signed-in device is unavailable.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(err) => {
            eprintln!("[cloud_agent_runtime] validate provider auth restore session: {err}");
            return error_response(
                "server_error",
                "Could not validate provider-auth restoration.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    let cipher = match EnvProviderAuthCipher::from_env() {
        Ok(cipher) => cipher,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] provider auth restore cipher unavailable: {err}");
            return error_response(
                "provider_auth_not_configured",
                "Cloud provider-auth snapshots are not configured on this server.",
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    };
    match restore_snapshots_for_device(
        state.db_pool(),
        &cipher,
        &session.account_id,
        &session.device_id,
        device_public_key,
        input.known_revision.as_deref(),
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] restore provider auth snapshots: {err}");
            error_response(
                "server_error",
                "Could not restore provider authentication on this device.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
