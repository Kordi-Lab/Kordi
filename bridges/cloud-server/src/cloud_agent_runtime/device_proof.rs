//! Proof of possession of a desktop's registered device key.
//!
//! Hosted provider material is returned to a desktop only with a signature,
//! made with the P-256 installation key registered for the session's device,
//! over a single-use challenge bound to this server, the account, device,
//! run, and execution claim. A session token alone cannot obtain the
//! material.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use p256::ecdsa::VerifyingKey;
use rand::RngCore;
use serde::Deserialize;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::runs::AgentRuntimeRoute;
use crate::auth::device_signatures::{
    audience_matches, proof_message, server_audience, signature_matches, PROOF_VERSION,
};

/// Seconds a challenge stays usable after it is issued.
pub(super) const CHALLENGE_SECONDS: i32 = 60;
pub(super) const PROVIDER_AUTH_PURPOSE: &str = "desktop-provider-auth";
const MAX_NONCE_CHARS: usize = 64;

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
    /// The version of the signed text. Desktops that sign an earlier
    /// version send none.
    #[serde(default)]
    pub version: Option<u32>,
    /// The server origin the desktop signed for.
    #[serde(default)]
    pub audience: Option<String>,
}

impl DeviceProof {
    /// Whether the proof uses the signed text this server accepts.
    pub(super) fn is_current_version(&self) -> bool {
        self.version == Some(PROOF_VERSION) && self.audience.is_some()
    }
}

/// The exact text a desktop signs to receive hosted provider material.
pub(super) fn provider_auth_message(
    audience: &str,
    account_id: &str,
    device_id: &str,
    run_id: &str,
    claim_id: Uuid,
    nonce: &str,
) -> String {
    proof_message(
        PROVIDER_AUTH_PURPOSE,
        audience,
        account_id,
        device_id,
        &[("run", run_id), ("claim", &claim_id.to_string())],
        nonce,
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
/// issued to. The signed text must name this server and the device.
pub(super) async fn verify_provider_auth_proof(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    run_id: &str,
    claim_id: Uuid,
    proof: &DeviceProof,
) -> Result<bool, sqlx_core::Error> {
    let nonce = proof.nonce.trim();
    if nonce.is_empty() || nonce.len() > MAX_NONCE_CHARS {
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
    let Some(audience) = proof
        .audience
        .as_deref()
        .filter(|_| proof.is_current_version())
    else {
        return Ok(false);
    };
    if !audience_matches(audience, &server_audience()) {
        return Ok(false);
    }
    let Some(key) = device_key(pool, account_id, device_id).await? else {
        return Ok(false);
    };
    let message = provider_auth_message(audience, account_id, device_id, run_id, claim_id, nonce);
    Ok(signature_matches(
        &key,
        message.as_bytes(),
        &proof.signature,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_binds_the_server_device_run_and_claim_on_their_own_lines() {
        let claim = Uuid::nil();
        assert_eq!(
            provider_auth_message(
                "https://kordi.ai",
                "acct_a",
                "dev_b",
                "car_c",
                claim,
                "nonce-d"
            ),
            "kordi-device-proof-v2\npurpose:desktop-provider-auth\naudience:https://kordi.ai\n\
             account:acct_a\ndevice:dev_b\nrun:car_c\n\
             claim:00000000-0000-0000-0000-000000000000\nnonce:nonce-d"
        );
    }

    #[test]
    fn only_proofs_of_the_current_version_with_an_audience_are_current() {
        let proof = |version: Option<u32>, audience: Option<&str>| DeviceProof {
            nonce: "nonce".into(),
            signature: "signature".into(),
            version,
            audience: audience.map(str::to_owned),
        };
        assert!(proof(Some(2), Some("https://kordi.ai")).is_current_version());
        assert!(!proof(None, None).is_current_version());
        assert!(!proof(None, Some("https://kordi.ai")).is_current_version());
        assert!(!proof(Some(2), None).is_current_version());
        assert!(!proof(Some(1), Some("https://kordi.ai")).is_current_version());
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
