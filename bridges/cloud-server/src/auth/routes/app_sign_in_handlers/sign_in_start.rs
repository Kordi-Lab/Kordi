//! Starting an app sign-in once a grant is verified: register the device,
//! start the sign-in, record it, and answer with the token response. Shared
//! by the authorization code and device code grants.

use super::token::{server_error, token_response};
use super::*;
use crate::auth::app_sign_in::tokens::start_sign_in;
use crate::auth::app_sign_in::IssuedTokens;

/// A sign-in started inside a transaction that is not committed yet.
pub(in crate::auth::routes) struct StartedSignIn {
    account_id: String,
    device_id: String,
    is_new_device: bool,
    pub(in crate::auth::routes) issued: IssuedTokens,
}

/// Register the device and start an app sign-in for `account_id`, with its
/// audit record and device sync event. Shared by the authorization code and
/// device code grants. The caller commits `tx` and then calls
/// [`finish_sign_in`].
pub(in crate::auth::routes) async fn begin_sign_in(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    registration: &NormalizedDeviceRegistration,
    client_id: &str,
    audit: serde_json::Value,
) -> Result<StartedSignIn, Response> {
    let device = authorize_device(tx, account_id, registration, "pending_review")
        .await
        .map_err(|_| server_error())?;
    let issued = start_sign_in(tx, account_id, &device.device_id, client_id)
        .await
        .map_err(|_| server_error())?;
    let mut metadata = serde_json::json!({
        "clientId": client_id,
        "signInId": issued.sign_in_id,
    });
    if let (Some(metadata), serde_json::Value::Object(extra)) = (metadata.as_object_mut(), audit) {
        metadata.extend(extra);
    }
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, 'auth.app_sign_in.success', $4, $5)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(&device.device_id)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    if device.is_new_authorization {
        append_device_sync_event(
            tx,
            account_id,
            "device.added",
            &device.device_id,
            registration.display_name.as_deref(),
            "pending_review",
        )
        .await
        .map_err(|_| server_error())?;
    }
    Ok(StartedSignIn {
        account_id: account_id.to_string(),
        device_id: device.device_id,
        is_new_device: device.is_new_authorization,
        issued,
    })
}

/// After the sign-in's transaction committed: announce a new device and
/// return the token response.
pub(in crate::auth::routes) async fn finish_sign_in(
    state: &ServerState,
    started: StartedSignIn,
    include_account: bool,
) -> Response {
    if started.is_new_device {
        let events = state.events().clone();
        let account_id = started.account_id.clone();
        let device_id = started.device_id.clone();
        tokio::spawn(async move {
            events
                .publish_device_event(&account_id, "added", &device_id)
                .await;
        });
    }
    let account = if include_account {
        owner_account_response_row(state.db_pool(), &started.account_id)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    token_response(started.issued, account)
}
