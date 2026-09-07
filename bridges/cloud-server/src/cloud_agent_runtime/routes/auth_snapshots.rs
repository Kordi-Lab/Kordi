use super::*;

pub(super) async fn publish_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(mutation): Query<ProviderAuthMutationQuery>,
    Json(input): Json<PublishProviderAuthSnapshotRequest>,
) -> Response {
    if !mutation.is_explicit() {
        return explicit_provider_auth_intent_required();
    }
    let Some(input) = input.normalized() else {
        return error_response(
            "invalid_provider_auth_snapshot",
            "Provider, authChoice, and payload are required.",
            StatusCode::BAD_REQUEST,
        );
    };
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
    match publish_snapshot(
        state.db_pool(),
        &cipher,
        &session.account_id,
        &session.device_id,
        input,
    )
    .await
    {
        Ok(snapshot) => (StatusCode::CREATED, Json(snapshot)).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] publish provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not publish Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

pub(super) async fn current_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(query): Query<CurrentProviderAuthSnapshotQuery>,
) -> Response {
    match current_snapshot(state.db_pool(), &session.account_id, &query).await {
        Ok(snapshot) => Json(CurrentProviderAuthSnapshotResponse { snapshot }).into_response(),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] current provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not load Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

pub(super) async fn revoke_provider_auth_snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(snapshot_id): Path<String>,
    Query(mutation): Query<ProviderAuthMutationQuery>,
) -> Response {
    if !mutation.is_explicit() {
        return explicit_provider_auth_intent_required();
    }
    match revoke_snapshot(state.db_pool(), &session.account_id, &snapshot_id).await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => error_response(
            "provider_auth_snapshot_not_found",
            "Cloud provider-auth snapshot was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] revoke provider auth snapshot: {err}");
            error_response(
                "server_error",
                "Could not revoke Cloud provider-auth snapshot.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
fn explicit_provider_auth_intent_required() -> Response {
    error_response(
        "explicit_provider_auth_intent_required",
        "Provider authentication changes require explicit user intent.",
        StatusCode::BAD_REQUEST,
    )
}
