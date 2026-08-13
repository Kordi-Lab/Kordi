use super::*;
use sqlx_core::transaction::Transaction;

pub(super) fn device_server_error(message: &'static str) -> Response {
    err("server_error", message, StatusCode::INTERNAL_SERVER_ERROR)
}

fn idempotency_conflict() -> Response {
    err(
        "idempotency_key_reused",
        "This client operation ID was already used for different device changes.",
        StatusCode::CONFLICT,
    )
}

pub(super) async fn require_confirmed_actor(
    transaction: &mut Transaction<'_, sqlx_postgres::Postgres>,
    session: &CloudSession,
) -> Result<(), Box<Response>> {
    let state: Option<(String,)> = query_as(
        "SELECT authorization_state FROM cloud_devices \
         WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL \
         FOR SHARE",
    )
    .bind(&session.account_id)
    .bind(&session.device_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| {
        Box::new(device_server_error(
            "Could not verify the current device authorization.",
        ))
    })?;

    match state {
        Some((authorization_state,)) if authorization_state == "confirmed" => Ok(()),
        Some(_) => Err(Box::new(err(
            "device_review_required",
            "Confirm this device from an already authorized installation before managing sessions.",
            StatusCode::FORBIDDEN,
        ))),
        None => Err(Box::new(err(
            "device_authorization_revoked",
            "This device authorization is no longer active.",
            StatusCode::UNAUTHORIZED,
        ))),
    }
}

pub(super) async fn write_device_audit(
    transaction: &mut Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    actor_device_id: &str,
    event_type: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(actor_device_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(super) fn restored_operation(
    operation: crate::auth::devices::StoredDeviceOperation,
    operation_kind: &str,
    fingerprint: &str,
) -> Result<DeviceMutationResponse, Box<Response>> {
    if operation.operation_kind != operation_kind || operation.request_fingerprint != fingerprint {
        return Err(Box::new(idempotency_conflict()));
    }
    serde_json::from_value(operation.result).map_err(|_| {
        Box::new(device_server_error(
            "Could not restore the device operation.",
        ))
    })
}
