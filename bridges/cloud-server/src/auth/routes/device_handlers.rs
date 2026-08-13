use super::device_operation_support::{
    device_server_error, require_confirmed_actor, restored_operation, write_device_audit,
};
use super::*;
use crate::auth::devices::{
    existing_device_operation, lock_device_operation, operation_fingerprint,
    record_device_operation,
};

pub(super) async fn rename_device(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(device_id): axum::extract::Path<String>,
    Json(request): Json<RenameDeviceRequest>,
) -> Response {
    let display_name = request.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return err(
            "invalid_device_name",
            "Device name must contain between 1 and 80 characters.",
            StatusCode::BAD_REQUEST,
        );
    }
    let display_name = display_name.to_string();
    let intent = serde_json::json!({"deviceId": device_id, "displayName": display_name});
    let fingerprint = operation_fingerprint(&intent);
    let mut transaction = match state.db_pool().begin().await {
        Ok(value) => value,
        Err(_) => return device_server_error("Could not start the device operation."),
    };
    if let Err(response) = require_confirmed_actor(&mut transaction, &session).await {
        return *response;
    }
    if lock_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
    )
    .await
    .is_err()
    {
        return device_server_error("Could not lock the device operation.");
    }
    match existing_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
    )
    .await
    {
        Ok(Some(operation)) => {
            return match restored_operation(operation, "rename", &fingerprint) {
                Ok(result) => Json(result).into_response(),
                Err(response) => *response,
            };
        }
        Ok(None) => {}
        Err(_) => return device_server_error("Could not load the device operation."),
    }

    let updated: Option<(String, String)> = match query_as(
        "UPDATE cloud_devices SET device_name = $1 \
         WHERE account_id = $2 AND device_id = $3 AND revoked_at IS NULL \
         RETURNING device_id, authorization_state",
    )
    .bind(&display_name)
    .bind(&session.account_id)
    .bind(&device_id)
    .fetch_optional(&mut *transaction)
    .await
    {
        Ok(value) => value,
        Err(_) => return device_server_error("Could not rename the device."),
    };
    let Some((_, authorization_state)) = updated else {
        return err(
            "device_not_found",
            "Device not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if append_device_sync_event(
        &mut transaction,
        &session.account_id,
        "device.renamed",
        &device_id,
        Some(&display_name),
        &authorization_state,
    )
    .await
    .is_err()
        || write_device_audit(
            &mut transaction,
            &session.account_id,
            &session.device_id,
            "device.renamed",
            serde_json::json!({"targetDeviceId": device_id}),
        )
        .await
        .is_err()
    {
        return device_server_error("Could not record the device rename.");
    }
    let result = DeviceMutationResponse {
        affected_device_ids: vec![device_id.clone()],
    };
    if record_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
        "rename",
        &fingerprint,
        &serde_json::to_value(&result).unwrap_or_default(),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return device_server_error("Could not commit the device rename.");
    }
    state
        .events()
        .publish_device_event(&session.account_id, "renamed", &device_id)
        .await;
    Json(result).into_response()
}

pub(super) async fn confirm_device(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(device_id): axum::extract::Path<String>,
    Json(request): Json<DeviceOperationRequest>,
) -> Response {
    if device_id == session.device_id {
        return err(
            "cannot_confirm_current_device",
            "Confirm this login from another authorized device.",
            StatusCode::BAD_REQUEST,
        );
    }
    let intent = serde_json::json!({"deviceId": device_id});
    let fingerprint = operation_fingerprint(&intent);
    let mut transaction = match state.db_pool().begin().await {
        Ok(value) => value,
        Err(_) => return device_server_error("Could not start the device operation."),
    };
    if let Err(response) = require_confirmed_actor(&mut transaction, &session).await {
        return *response;
    }
    if lock_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
    )
    .await
    .is_err()
    {
        return device_server_error("Could not lock the device operation.");
    }
    match existing_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
    )
    .await
    {
        Ok(Some(operation)) => {
            return match restored_operation(operation, "confirm", &fingerprint) {
                Ok(result) => Json(result).into_response(),
                Err(response) => *response,
            };
        }
        Ok(None) => {}
        Err(_) => return device_server_error("Could not load the device operation."),
    }
    let row: Option<(Option<String>,)> = match query_as(
        "UPDATE cloud_devices SET authorization_state = 'confirmed', \
                confirmed_at = COALESCE(confirmed_at, $1) \
         WHERE account_id = $2 AND device_id = $3 AND revoked_at IS NULL \
         RETURNING device_name",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(&session.account_id)
    .bind(&device_id)
    .fetch_optional(&mut *transaction)
    .await
    {
        Ok(value) => value,
        Err(_) => return device_server_error("Could not confirm the device."),
    };
    let Some((display_name,)) = row else {
        return err(
            "device_not_found",
            "Device not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if append_device_sync_event(
        &mut transaction,
        &session.account_id,
        "device.confirmed",
        &device_id,
        display_name.as_deref(),
        "confirmed",
    )
    .await
    .is_err()
        || write_device_audit(
            &mut transaction,
            &session.account_id,
            &session.device_id,
            "device.confirmed",
            serde_json::json!({"targetDeviceId": device_id}),
        )
        .await
        .is_err()
    {
        return device_server_error("Could not record the device confirmation.");
    }
    let result = DeviceMutationResponse {
        affected_device_ids: vec![device_id.clone()],
    };
    if record_device_operation(
        &mut transaction,
        &session.account_id,
        request.client_operation_id,
        "confirm",
        &fingerprint,
        &serde_json::to_value(&result).unwrap_or_default(),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return device_server_error("Could not commit the device confirmation.");
    }
    state
        .events()
        .publish_device_event(&session.account_id, "confirmed", &device_id)
        .await;
    Json(result).into_response()
}

pub(super) async fn revoke_device(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(device_id): axum::extract::Path<String>,
    Json(request): Json<DeviceOperationRequest>,
) -> Response {
    if device_id == session.device_id {
        return err(
            "cannot_revoke_current_device",
            "Use sign out to end the current device session.",
            StatusCode::BAD_REQUEST,
        );
    }
    revoke_devices(state, session, request.client_operation_id, Some(device_id)).await
}

pub(super) async fn revoke_other_devices(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<DeviceOperationRequest>,
) -> Response {
    revoke_devices(state, session, request.client_operation_id, None).await
}

async fn revoke_devices(
    state: Arc<ServerState>,
    session: CloudSession,
    operation_id: uuid::Uuid,
    target_device_id: Option<String>,
) -> Response {
    let operation_kind = if target_device_id.is_some() {
        "revoke"
    } else {
        "revoke_others"
    };
    let intent = serde_json::json!({
        "targetDeviceId": target_device_id,
        "currentDeviceId": session.device_id,
    });
    let fingerprint = operation_fingerprint(&intent);
    let mut transaction = match state.db_pool().begin().await {
        Ok(value) => value,
        Err(_) => return device_server_error("Could not start the device operation."),
    };
    if let Err(response) = require_confirmed_actor(&mut transaction, &session).await {
        return *response;
    }
    if lock_device_operation(&mut transaction, &session.account_id, operation_id)
        .await
        .is_err()
    {
        return device_server_error("Could not lock the device operation.");
    }
    match existing_device_operation(&mut transaction, &session.account_id, operation_id).await {
        Ok(Some(operation)) => {
            return match restored_operation(operation, operation_kind, &fingerprint) {
                Ok(result) => Json(result).into_response(),
                Err(response) => *response,
            };
        }
        Ok(None) => {}
        Err(_) => return device_server_error("Could not load the device operation."),
    }

    let now = Utc::now().to_rfc3339();
    let affected: Vec<(String, Option<String>)> = if let Some(target) = target_device_id.as_deref()
    {
        match query_as(
            "UPDATE cloud_devices SET revoked_at = $1 \
             WHERE account_id = $2 AND device_id = $3 AND device_id <> $4 AND revoked_at IS NULL \
             RETURNING device_id, device_name",
        )
        .bind(&now)
        .bind(&session.account_id)
        .bind(target)
        .bind(&session.device_id)
        .fetch_all(&mut *transaction)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return device_server_error("Could not revoke the device."),
        }
    } else {
        match query_as(
            "UPDATE cloud_devices SET revoked_at = $1 \
             WHERE account_id = $2 AND device_id <> $3 AND revoked_at IS NULL \
             RETURNING device_id, device_name",
        )
        .bind(&now)
        .bind(&session.account_id)
        .bind(&session.device_id)
        .fetch_all(&mut *transaction)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return device_server_error("Could not revoke other devices."),
        }
    };
    if target_device_id.is_some() && affected.is_empty() {
        return err(
            "device_not_found",
            "Device not found.",
            StatusCode::NOT_FOUND,
        );
    }
    let affected_ids = affected
        .iter()
        .map(|(device_id, _)| device_id.clone())
        .collect::<Vec<_>>();
    if query(
        "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
         WHERE account_id = $2 AND device_id <> $3 AND revoked_at IS NULL \
           AND ($4::TEXT IS NULL OR device_id = $4)",
    )
    .bind(&now)
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(target_device_id.as_deref())
    .execute(&mut *transaction)
    .await
    .is_err()
    {
        return device_server_error("Could not revoke device sessions.");
    }
    for (device_id, display_name) in &affected {
        if append_device_sync_event(
            &mut transaction,
            &session.account_id,
            "device.revoked",
            device_id,
            display_name.as_deref(),
            "revoked",
        )
        .await
        .is_err()
        {
            return device_server_error("Could not record device revocation sync state.");
        }
    }
    if write_device_audit(
        &mut transaction,
        &session.account_id,
        &session.device_id,
        "device.revoked",
        serde_json::json!({"targetDeviceIds": affected_ids}),
    )
    .await
    .is_err()
    {
        return device_server_error("Could not record the device revocation.");
    }
    let result = DeviceMutationResponse {
        affected_device_ids: affected_ids.clone(),
    };
    if record_device_operation(
        &mut transaction,
        &session.account_id,
        operation_id,
        operation_kind,
        &fingerprint,
        &serde_json::to_value(&result).unwrap_or_default(),
    )
    .await
    .is_err()
        || transaction.commit().await.is_err()
    {
        return device_server_error("Could not commit the device revocation.");
    }

    for revoked_device_id in &affected_ids {
        state
            .events()
            .publish_device_event(&session.account_id, "revoked", revoked_device_id)
            .await;
        state
            .events()
            .publish_device_revoked(revoked_device_id)
            .await;
    }
    Json(result).into_response()
}
