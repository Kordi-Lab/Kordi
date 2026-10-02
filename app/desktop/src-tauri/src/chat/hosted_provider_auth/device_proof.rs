//! The device proof this Mac signs before it receives hosted provider
//! material: a single-use challenge, signed in native code with the
//! installation key, for this server and this session's device.

use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    provider_auth_endpoint, read_limited, refusal_message, DEVICE_PROOF_FAILED,
    MAX_CHALLENGE_BYTES, UNAVAILABLE,
};
use crate::cloud_session::DEVICE_PROOF_VERSION as PROOF_VERSION;

const PROOF_ALGORITHM: &str = "ecdsa-p256-sha256";
const PROOF_PURPOSE: &str = "desktop-provider-auth";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceChallenge {
    nonce: String,
    algorithm: String,
    purpose: String,
    /// Absent from servers that ask for an earlier signed text.
    #[serde(default)]
    version: Option<u32>,
    /// The device of the session the challenge was issued to.
    #[serde(default)]
    device_id: Option<String>,
}

/// The text this Mac signs with its device key to receive hosted provider
/// material. The server builds the same text from the challenge it issued,
/// its own origin, and the session's device.
fn provider_auth_proof_message(
    audience: &str,
    account_id: &str,
    device_id: &str,
    run_id: &str,
    claim_id: &str,
    nonce: &str,
) -> Result<String, String> {
    let claim_id = uuid::Uuid::parse_str(claim_id.trim()).map_err(|_| UNAVAILABLE)?;
    crate::cloud_session::device_proof_message(
        PROOF_PURPOSE,
        audience,
        account_id,
        device_id,
        &[("run", run_id), ("claim", &claim_id.to_string())],
        nonce,
    )
    .map_err(|_| UNAVAILABLE.to_string())
}

/// The device this Mac signs for: the one its stored session names, which
/// the challenge must not contradict. Sessions stored before the device was
/// recorded use the device the challenge was issued to.
fn proof_device_id(stored: Option<&str>, challenged: Option<&str>) -> Result<String, String> {
    let clean = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    match (clean(stored), clean(challenged)) {
        (Some(stored), Some(challenged)) if stored != challenged => Err(DEVICE_PROOF_FAILED.into()),
        (Some(device), _) | (None, Some(device)) => Ok(device),
        (None, None) => Err(UNAVAILABLE.into()),
    }
}

/// Requests the single-use challenge for this lease. `None` means the server
/// predates device proofs and accepts the request without one. A server that
/// asks for another signed-text version is refused rather than given a
/// signature that names neither the server nor the device.
pub(super) async fn request_challenge(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    lease: &DesktopCloudExecutionLease,
) -> Result<Option<DeviceChallenge>, String> {
    let response = client
        .post(provider_auth_endpoint(base_url, lease, true)?)
        .bearer_auth(token)
        .json(&json!({ "claimId": lease.claim_id }))
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    let status = response.status();
    if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Ok(None);
    }
    let body = read_limited(response, MAX_CHALLENGE_BYTES).await?;
    if !status.is_success() {
        return Err(refusal_message(&body));
    }
    let challenge: DeviceChallenge = serde_json::from_slice(&body).map_err(|_| UNAVAILABLE)?;
    if challenge.algorithm != PROOF_ALGORITHM
        || challenge.purpose != PROOF_PURPOSE
        || challenge.version != Some(PROOF_VERSION)
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(Some(challenge))
}

/// Signs the challenge in native code with the installation key, for the
/// server at `audience` and this session's device. The private key never
/// reaches the webview.
pub(super) async fn device_proof(
    audience: &str,
    session: &crate::cloud_session::CloudSessionEntry,
    lease: &DesktopCloudExecutionLease,
    challenge: DeviceChallenge,
) -> Result<Value, String> {
    let device_id = proof_device_id(session.device_id.as_deref(), challenge.device_id.as_deref())?;
    let nonce = challenge.nonce;
    let message = provider_auth_proof_message(
        audience,
        &session.account_id,
        &device_id,
        &lease.run_id,
        &lease.claim_id,
        &nonce,
    )?;
    let signature = tokio::task::spawn_blocking(move || {
        crate::cloud_session::sign_with_device_key(message.as_bytes())
    })
    .await
    .map_err(|_| UNAVAILABLE)?
    .map_err(|_| DEVICE_PROOF_FAILED)?;
    Ok(json!({
        "version": PROOF_VERSION,
        "audience": audience,
        "nonce": nonce,
        "signature": signature,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_message_matches_the_server_contract() {
        assert_eq!(
            provider_auth_proof_message(
                "https://kordi.ai",
                "acct_a",
                "dev_b",
                "car_c",
                "6F9619FF-8B86-D011-B42D-00C04FC964FF",
                "nonce-d"
            )
            .unwrap(),
            "kordi-device-proof-v2\npurpose:desktop-provider-auth\naudience:https://kordi.ai\n\
             account:acct_a\ndevice:dev_b\nrun:car_c\n\
             claim:6f9619ff-8b86-d011-b42d-00c04fc964ff\nnonce:nonce-d"
        );
    }

    #[test]
    fn proof_message_refuses_fields_that_could_add_lines() {
        let claim = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
        let message = |audience, account, device, run, claim, nonce| {
            provider_auth_proof_message(audience, account, device, run, claim, nonce)
        };
        let origin = "https://kordi.ai";
        assert!(message(origin, "acct\nrun:x", "dev", "car_b", claim, "n").is_err());
        assert!(message(origin, "acct_a", "dev\r", "car_b", claim, "n").is_err());
        assert!(message(origin, "acct_a", "dev", "car_b\r", claim, "n").is_err());
        assert!(message("https://a\nb", "acct_a", "dev", "car_b", claim, "n").is_err());
        assert!(message(origin, "acct_a", "", "car_b", claim, "n").is_err());
        assert!(message(origin, "acct_a", "dev", "car_b", claim, "").is_err());
        assert!(message(origin, "acct_a", "dev", "car_b", "not-a-claim", "n").is_err());
    }

    #[test]
    fn the_proof_names_the_stored_sessions_device() {
        assert_eq!(
            proof_device_id(Some("dev_a"), Some("dev_a")).unwrap(),
            "dev_a"
        );
        assert_eq!(proof_device_id(Some("dev_a"), None).unwrap(), "dev_a");
        assert_eq!(proof_device_id(None, Some(" dev_b ")).unwrap(), "dev_b");
        assert_eq!(
            proof_device_id(Some("dev_a"), Some("dev_b")).unwrap_err(),
            DEVICE_PROOF_FAILED
        );
        assert_eq!(proof_device_id(Some(" "), None).unwrap_err(), UNAVAILABLE);
    }

    #[test]
    fn challenges_name_the_signed_text_version() {
        let challenge: DeviceChallenge = serde_json::from_value(json!({
            "nonce": "n", "algorithm": PROOF_ALGORITHM, "purpose": PROOF_PURPOSE,
            "version": 2, "deviceId": "dev_a", "expiresAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(challenge.version, Some(PROOF_VERSION));
        assert_eq!(challenge.device_id.as_deref(), Some("dev_a"));
        let earlier: DeviceChallenge = serde_json::from_value(json!({
            "nonce": "n", "algorithm": PROOF_ALGORITHM, "purpose": PROOF_PURPOSE
        }))
        .unwrap();
        assert_eq!(earlier.version, None);
    }
}
