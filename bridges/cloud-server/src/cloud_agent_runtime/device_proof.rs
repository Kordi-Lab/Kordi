//! Proof of possession of a desktop's registered device key.
//!
//! Hosted provider material is returned to a desktop only with a signature,
//! made with the P-256 installation key registered for the session's device,
//! over a single-use challenge bound to the account, device, run, and
//! execution claim. A session token alone cannot obtain the material.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rand::RngCore;
use serde::Deserialize;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::runs::AgentRuntimeRoute;

/// Seconds a challenge stays usable after it is issued.
pub(super) const CHALLENGE_SECONDS: i32 = 60;
/// ECDSA over P-256 with SHA-256, as WebCrypto and CryptoKit produce it.
pub(super) const PROOF_ALGORITHM: &str = "ecdsa-p256-sha256";
pub(super) const PROVIDER_AUTH_PURPOSE: &str = "desktop-provider-auth";
const MAX_NONCE_CHARS: usize = 64;
const MAX_SIGNATURE_CHARS: usize = 256;

/// Auth choices whose credentials the server stores and hands to the
/// executing runtime, as the desktop classifies them.
const HOSTED_AUTH_CHOICE_PREFIXES: [&str; 4] = [
    "cloud-login:",
    "cloud-api-key:",
    "ios-codex:",
    "ios-api-key:",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceProof {
    pub nonce: String,
    pub signature: String,
}

/// The exact text a desktop signs to receive hosted provider material.
pub(super) fn provider_auth_message(
    account_id: &str,
    run_id: &str,
    claim_id: Uuid,
    nonce: &str,
) -> String {
    format!(
        "kordi-device-proof-v1\npurpose:{PROVIDER_AUTH_PURPOSE}\naccount:{account_id}\n\
         run:{run_id}\nclaim:{claim_id}\nnonce:{nonce}"
    )
}

/// Whether a run on this route needs hosted provider material.
pub(super) fn route_uses_hosted_auth(route: &AgentRuntimeRoute) -> bool {
    route
        .default_auth_choice
        .as_deref()
        .map(str::trim)
        .is_some_and(|choice| {
            HOSTED_AUTH_CHOICE_PREFIXES.iter().any(|prefix| {
                choice
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| !suffix.is_empty())
            })
        })
}

/// The registered P-256 key of a live desktop device, if it has one.
pub(super) async fn device_key(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<Option<VerifyingKey>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT device_public_key FROM cloud_devices \
         WHERE device_id=$1 AND account_id=$2 AND revoked_at IS NULL \
         AND device_key_algorithm='p256' AND device_platform IN ('macos','desktop')",
    )
    .bind(device_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .and_then(|(key,)| crate::auth::devices::parse_p256_public_key(&key))
        .map(VerifyingKey::from))
}

/// Issues a fresh challenge for one execution lease, replacing any earlier
/// one for that lease and removing the device's expired challenges.
pub(super) async fn issue_challenge(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    run_id: &str,
    claim_id: Uuid,
) -> Result<(String, DateTime<Utc>), sqlx_core::Error> {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let nonce = URL_SAFE_NO_PAD.encode(bytes);
    let mut tx = pool.begin().await?;
    query(
        "DELETE FROM cloud_device_proof_challenges WHERE device_id=$1 \
         AND (expires_at<=now() OR (run_id=$2 AND claim_id=$3))",
    )
    .bind(device_id)
    .bind(run_id)
    .bind(claim_id)
    .execute(&mut *tx)
    .await?;
    let (expires_at,): (DateTime<Utc>,) = query_as(
        "INSERT INTO cloud_device_proof_challenges(nonce,account_id,device_id,run_id,claim_id,expires_at) \
         VALUES($1,$2,$3,$4,$5,now()+make_interval(secs=>$6)) RETURNING expires_at",
    )
    .bind(&nonce)
    .bind(account_id)
    .bind(device_id)
    .bind(run_id)
    .bind(claim_id)
    .bind(CHALLENGE_SECONDS)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((nonce, expires_at))
}

/// Consumes the challenge named by the proof and checks its signature with
/// the device's registered key. A challenge is used at most once, whatever
/// the outcome, and only for the account, device, run, and claim it was
/// issued to.
pub(super) async fn verify_provider_auth_proof(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    run_id: &str,
    claim_id: Uuid,
    proof: &DeviceProof,
) -> Result<bool, sqlx_core::Error> {
    let nonce = proof.nonce.trim();
    if nonce.is_empty()
        || nonce.len() > MAX_NONCE_CHARS
        || proof.signature.len() > MAX_SIGNATURE_CHARS
    {
        return Ok(false);
    }
    let consumed: Option<(bool,)> = query_as(
        "DELETE FROM cloud_device_proof_challenges \
         WHERE nonce=$1 AND account_id=$2 AND device_id=$3 AND run_id=$4 AND claim_id=$5 \
         RETURNING expires_at>now()",
    )
    .bind(nonce)
    .bind(account_id)
    .bind(device_id)
    .bind(run_id)
    .bind(claim_id)
    .fetch_optional(pool)
    .await?;
    if consumed != Some((true,)) {
        return Ok(false);
    }
    let Some(key) = device_key(pool, account_id, device_id).await? else {
        return Ok(false);
    };
    let message = provider_auth_message(account_id, run_id, claim_id, nonce);
    Ok(signature_matches(
        &key,
        message.as_bytes(),
        &proof.signature,
    ))
}

/// Accepts a base64url signature in the fixed 64-byte form or in DER.
fn signature_matches(key: &VerifyingKey, message: &[u8], encoded: &str) -> bool {
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded.trim()) else {
        return false;
    };
    Signature::from_slice(&bytes)
        .or_else(|_| Signature::from_der(&bytes))
        .is_ok_and(|signature| key.verify(message, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_slice(&[seed; 32]).unwrap()
    }

    #[test]
    fn message_binds_every_field_on_its_own_line() {
        let claim = Uuid::nil();
        assert_eq!(
            provider_auth_message("acct_a", "car_b", claim, "nonce-c"),
            "kordi-device-proof-v1\npurpose:desktop-provider-auth\naccount:acct_a\n\
             run:car_b\nclaim:00000000-0000-0000-0000-000000000000\nnonce:nonce-c"
        );
    }

    #[test]
    fn signatures_verify_only_for_the_signed_message_and_key() {
        let key = signing_key(7);
        let message = b"signed message";
        let signature: Signature = key.sign(message);
        let fixed = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let der = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
        let verifying = VerifyingKey::from(&key);

        assert!(signature_matches(&verifying, message, &fixed));
        assert!(signature_matches(&verifying, message, &der));
        assert!(!signature_matches(&verifying, b"other message", &fixed));
        assert!(!signature_matches(
            &VerifyingKey::from(&signing_key(8)),
            message,
            &fixed
        ));
        assert!(!signature_matches(&verifying, message, "not base64!"));
        assert!(!signature_matches(&verifying, message, ""));
    }

    #[test]
    fn only_named_hosted_accounts_need_hosted_material() {
        let route = |choice: Option<&str>| AgentRuntimeRoute {
            default_auth_choice: choice.map(str::to_owned),
            ..AgentRuntimeRoute::default()
        };
        for choice in [
            "cloud-login:work",
            "cloud-api-key:work",
            "ios-codex:phone",
            " ios-api-key:key ",
        ] {
            assert!(route_uses_hosted_auth(&route(Some(choice))), "{choice}");
        }
        for choice in [None, Some("default"), Some("cloud-login:"), Some("local:x")] {
            assert!(!route_uses_hosted_auth(&route(choice)), "{choice:?}");
        }
    }
}
