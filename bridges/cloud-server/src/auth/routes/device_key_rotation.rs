//! Rotation of the current device's registered installation key.
//!
//! A device replaces its registered P-256 key only with a single-use
//! challenge issued to that device's session, signed by both the registered
//! key and the new key, for this server and this device. A session token
//! alone cannot change the key, and a signature cannot be used twice or for
//! another server or device.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::VerifyingKey;
use rand::RngCore;
use serde_json::json;

use super::device_operation_support::device_server_error;
use super::*;
use crate::auth::device_signatures::{
    audience_matches, proof_message, server_audience, signature_matches, PROOF_ALGORITHM,
    PROOF_VERSION,
};
use crate::auth::devices::{normalize_p256_public_key, parse_p256_public_key};

pub(crate) const KEY_ROTATION_PURPOSE: &str = "device-key-rotation";
/// Seconds a challenge stays usable after it is issued.
const CHALLENGE_SECONDS: i32 = 60;
const MAX_NONCE_CHARS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceKeyRotationRequest {
    nonce: String,
    audience: String,
    public_key: String,
    key_algorithm: String,
    /// The signature of the registered key.
    signature: String,
    /// The signature of the new key, proving that the device holds it.
    new_key_signature: String,
}

/// The exact text a device signs, with both keys, to rotate its key.
pub(crate) fn key_rotation_message(
    audience: &str,
    account_id: &str,
    device_id: &str,
    new_public_key: &str,
    nonce: &str,
) -> String {
    proof_message(
        KEY_ROTATION_PURPOSE,
        audience,
        account_id,
        device_id,
        &[("key", new_public_key)],
        nonce,
    )
}

fn rotation_refused() -> Response {
    err(
        "device_key_rotation_invalid",
        "This device could not prove that it holds its registered key.",
        StatusCode::FORBIDDEN,
    )
}

fn device_key_required() -> Response {
    err(
        "device_key_required",
        "This device has no registered key to rotate. Sign in again on this device.",
        StatusCode::CONFLICT,
    )
}

/// The registered P-256 key of the session's live device, as stored. The
/// device row stays locked until the transaction ends.
async fn registered_key(
    connection: &mut sqlx_postgres::PgConnection,
    session: &CloudSession,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT device_public_key FROM cloud_devices WHERE device_id=$1 AND account_id=$2 \
         AND revoked_at IS NULL AND device_key_algorithm='p256' FOR UPDATE",
    )
    .bind(&session.device_id)
    .bind(&session.account_id)
    .fetch_optional(connection)
    .await?;
    Ok(row
        .map(|(key,)| key)
        .filter(|key| parse_p256_public_key(key).is_some()))
}

/// Issues the single-use challenge the current device signs to rotate its
/// key, replacing any earlier one for the device.
pub(super) async fn device_key_rotation_challenge(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let issued = async {
        let mut tx = state.db_pool().begin().await?;
        if registered_key(&mut tx, &session).await?.is_none() {
            return Ok(None);
        }
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let nonce = URL_SAFE_NO_PAD.encode(bytes);
        query(
            "DELETE FROM cloud_device_key_rotation_challenges \
             WHERE device_id=$1 OR expires_at<=now()",
        )
        .bind(&session.device_id)
        .execute(&mut *tx)
        .await?;
        let (expires_at,): (DateTime<Utc>,) = query_as(
            "INSERT INTO cloud_device_key_rotation_challenges(nonce,account_id,device_id,expires_at) \
             VALUES($1,$2,$3,now()+make_interval(secs=>$4)) RETURNING expires_at",
        )
        .bind(&nonce)
        .bind(&session.account_id)
        .bind(&session.device_id)
        .bind(CHALLENGE_SECONDS)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(Some((nonce, expires_at)))
    }
    .await;
    match issued {
        Ok(Some((nonce, expires_at))) => Json(json!({
            "nonce": nonce,
            "expiresAt": expires_at.to_rfc3339(),
            "algorithm": PROOF_ALGORITHM,
            "purpose": KEY_ROTATION_PURPOSE,
            "version": PROOF_VERSION,
            "deviceId": session.device_id,
        }))
        .into_response(),
        Ok(None) => device_key_required(),
        Err(_) => device_server_error("Could not issue a device key challenge."),
    }
}

/// Consumes the challenge, whatever the outcome, and reports whether it was
/// issued to this session's device and is still live.
async fn consume_challenge(
    pool: &PgPool,
    session: &CloudSession,
    nonce: &str,
) -> Result<bool, sqlx_core::Error> {
    if nonce.is_empty() || nonce.len() > MAX_NONCE_CHARS {
        return Ok(false);
    }
    let consumed: Option<(bool,)> = query_as(
        "DELETE FROM cloud_device_key_rotation_challenges \
         WHERE nonce=$1 AND account_id=$2 AND device_id=$3 RETURNING expires_at>now()",
    )
    .bind(nonce)
    .bind(&session.account_id)
    .bind(&session.device_id)
    .fetch_optional(pool)
    .await?;
    Ok(consumed == Some((true,)))
}

enum Rotation {
    Rotated,
    Refused,
    NoRegisteredKey,
    KeyInUse,
}

/// Replaces the current device's registered key with the request's key. The
/// request must carry a live challenge issued to this session's device,
/// signed for this server and device by the registered key and the new key.
/// A retry after the replacement succeeded needs only the new key's
/// signature, over a fresh challenge.
pub(super) async fn rotate_current_device_key(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<DeviceKeyRotationRequest>,
) -> Response {
    let new_key = match normalize_p256_public_key(&request.public_key, &request.key_algorithm) {
        Ok(key) => key,
        Err(error) => return err(error.code(), error.message(), StatusCode::BAD_REQUEST),
    };
    let nonce = request.nonce.trim();
    let rotation = async {
        if !consume_challenge(state.db_pool(), &session, nonce).await?
            || !audience_matches(&request.audience, &server_audience())
        {
            return Ok(Rotation::Refused);
        }
        let message = key_rotation_message(
            &request.audience,
            &session.account_id,
            &session.device_id,
            &new_key,
            nonce,
        );
        let new_public = parse_p256_public_key(&new_key);
        let Some(new_verifying) = new_public.map(VerifyingKey::from) else {
            return Ok(Rotation::Refused);
        };
        if !signature_matches(
            &new_verifying,
            message.as_bytes(),
            &request.new_key_signature,
        ) {
            return Ok(Rotation::Refused);
        }
        let mut tx = state.db_pool().begin().await?;
        let Some(registered) = registered_key(&mut tx, &session).await? else {
            return Ok(Rotation::NoRegisteredKey);
        };
        let Some(registered_public) = parse_p256_public_key(&registered) else {
            return Ok(Rotation::NoRegisteredKey);
        };
        if Some(registered_public) == new_public {
            return Ok(Rotation::Rotated);
        }
        if !signature_matches(
            &VerifyingKey::from(registered_public),
            message.as_bytes(),
            &request.signature,
        ) {
            return Ok(Rotation::Refused);
        }
        query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!(
                "device-authorization:{}:{new_key}",
                session.account_id
            ))
            .execute(&mut *tx)
            .await?;
        let (in_use,): (bool,) = query_as(
            "SELECT EXISTS(SELECT 1 FROM cloud_devices WHERE account_id=$1 AND device_public_key=$2)",
        )
        .bind(&session.account_id)
        .bind(&new_key)
        .fetch_one(&mut *tx)
        .await?;
        if in_use {
            return Ok(Rotation::KeyInUse);
        }
        let updated = query(
            "UPDATE cloud_devices SET device_public_key=$1, device_key_algorithm='p256' \
             WHERE device_id=$2 AND account_id=$3 AND device_public_key=$4 AND revoked_at IS NULL",
        )
        .bind(&new_key)
        .bind(&session.device_id)
        .bind(&session.account_id)
        .bind(&registered)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Ok(Rotation::Refused);
        }
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(Rotation::Rotated)
    }
    .await;
    match rotation {
        Ok(Rotation::Rotated) => Json(json!({
            "deviceId": session.device_id,
            "keyAlgorithm": "p256",
        }))
        .into_response(),
        Ok(Rotation::Refused) => rotation_refused(),
        Ok(Rotation::NoRegisteredKey) => device_key_required(),
        Ok(Rotation::KeyInUse) => err(
            "device_key_in_use",
            "Another device of this account is registered with that key.",
            StatusCode::CONFLICT,
        ),
        Err(_) => device_server_error("Could not rotate the device key."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_text_names_the_server_device_and_new_key() {
        assert_eq!(
            key_rotation_message("https://kordi.ai", "acct_a", "dev_b", "key-c", "nonce-d"),
            "kordi-device-proof-v2\npurpose:device-key-rotation\naudience:https://kordi.ai\n\
             account:acct_a\ndevice:dev_b\nkey:key-c\nnonce:nonce-d"
        );
    }
}
