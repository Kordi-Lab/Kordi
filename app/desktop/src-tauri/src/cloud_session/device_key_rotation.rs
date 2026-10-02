//! One-time replacement of installation keys that earlier releases created.
//!
//! Earlier releases generated the installation key in the webview, where page
//! script could read its private half. This release replaces such a key once:
//! it generates a new key in native code, registers it for the signed-in
//! device with a request signed by the old key and the new one, and only then
//! discards the old key. Without a stored session nothing can register a key,
//! so the key is replaced locally and the next sign-in registers the new one.
//! When the server cannot rotate keys yet, the old key stays in use and a
//! later launch or sign-in tries again.

use serde::Deserialize;
use serde_json::{json, Value};

use super::device_identity::{self, PreparedRotation};
use super::{cloud_session_load, device_proof_message, CloudSessionEntry, DEVICE_PROOF_VERSION};

const PURPOSE: &str = "device-key-rotation";
const ALGORITHM: &str = "ecdsa-p256-sha256";
const MAX_RESPONSE_BYTES: usize = 4 * 1024;
const CHALLENGE_PATH: &str = "/v1/cloud/auth/devices/current/key-rotation/challenge";
const ROTATION_PATH: &str = "/v1/cloud/auth/devices/current/key-rotation";

/// Held while a device proof is signed and used, and exclusively while the
/// key is rotated, so no proof is signed with a key the server just replaced.
pub(crate) static DEVICE_KEY_USE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    NotNeeded,
    ReplacedLocally,
    Rotated,
    Deferred(&'static str),
}

/// The server's answer to a request to register the new key.
#[derive(Debug, PartialEq, Eq)]
enum Registration {
    Registered,
    /// The server holds no key for this device, so none needs replacing.
    NoRegisteredKey,
    /// Another device of the account holds the new key.
    KeyInUse,
    /// The server predates key rotation.
    Unsupported,
    Failed(&'static str),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Challenge {
    nonce: String,
    algorithm: String,
    purpose: String,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    device_id: Option<String>,
}

/// At launch: without a session a legacy key is replaced at once, before
/// the webview can register it; with one it is rotated in the background.
pub(crate) fn start() {
    match cloud_session_load() {
        Ok(Some(session)) if !session.token.trim().is_empty() => spawn(),
        Ok(_) => {
            if let Err(error) = device_identity::replace_legacy_identity_locally() {
                eprintln!("[kordi] Unable to replace the device key: {error}");
            }
        }
        Err(error) => {
            eprintln!("[kordi] Unable to load the session to rotate the device key: {error}")
        }
    }
}

/// Rotates a legacy key in the background.
pub(crate) fn spawn() {
    tauri::async_runtime::spawn(async {
        match rotate_legacy_key().await {
            Outcome::Deferred(reason) if reason != "rotation_unsupported" => {
                eprintln!("[kordi] Device key rotation deferred: {reason}");
            }
            _ => {}
        }
    });
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| "device_identity_unavailable".to_string())?
}

/// Replaces a key that an earlier release created, if one is stored.
pub(crate) async fn rotate_legacy_key() -> Outcome {
    match blocking(device_identity::has_legacy_identity).await {
        Ok(true) => {}
        Ok(false) => return Outcome::NotNeeded,
        Err(_) => return Outcome::Deferred("device_identity_unavailable"),
    }
    let _exclusive = DEVICE_KEY_USE.write().await;
    let session = match blocking(cloud_session_load).await {
        Ok(session) => session.filter(|session| !session.token.trim().is_empty()),
        Err(_) => return Outcome::Deferred("session_unavailable"),
    };
    let Some(session) = session else {
        return match blocking(device_identity::replace_legacy_identity_locally).await {
            Ok(true) => Outcome::ReplacedLocally,
            Ok(false) => Outcome::NotNeeded,
            Err(_) => Outcome::Deferred("device_identity_unavailable"),
        };
    };
    let prepared = match blocking(device_identity::prepare_rotation).await {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return Outcome::NotNeeded,
        Err(_) => return Outcome::Deferred("device_identity_unavailable"),
    };
    let Ok(base_url) = crate::cloud_api_base_url_from_env() else {
        return Outcome::Deferred("api_unavailable");
    };
    let outcome = match register(&base_url, &session, &prepared).await {
        Registration::Registered => Outcome::Rotated,
        Registration::NoRegisteredKey => Outcome::ReplacedLocally,
        Registration::KeyInUse => {
            let _ = blocking(device_identity::discard_pending_key).await;
            return Outcome::Deferred("device_key_in_use");
        }
        Registration::Unsupported => return Outcome::Deferred("rotation_unsupported"),
        Registration::Failed(reason) => return Outcome::Deferred(reason),
    };
    let public = prepared.new_public_key_spki;
    match blocking(move || device_identity::complete_rotation(&public)).await {
        Ok(()) => outcome,
        Err(_) => Outcome::Deferred("device_identity_unavailable"),
    }
}

async fn read_limited(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

fn refusal(body: &[u8]) -> Registration {
    let code = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("errorCode")?.as_str().map(str::to_owned));
    match code.as_deref() {
        Some("device_key_required") => Registration::NoRegisteredKey,
        Some("device_key_in_use") => Registration::KeyInUse,
        _ => Registration::Failed("rotation_refused"),
    }
}

/// Sends `body` and returns the successful JSON answer, or what the server's
/// answer means for the rotation.
async fn post(
    client: &reqwest::Client,
    url: String,
    token: &str,
    body: &Value,
) -> Result<Value, Registration> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|_| Registration::Failed("network"))?;
    let status = response.status();
    if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Err(Registration::Unsupported);
    }
    let bytes = read_limited(response)
        .await
        .ok_or(Registration::Failed("response_invalid"))?;
    if !status.is_success() {
        return Err(refusal(&bytes));
    }
    serde_json::from_slice(&bytes).map_err(|_| Registration::Failed("response_invalid"))
}

/// The device the rotation names: the one the stored session names, which
/// the challenge must not contradict, or the challenge's for a session
/// stored before the device was recorded.
fn rotation_device(session: &CloudSessionEntry, challenge: &Challenge) -> Option<String> {
    let clean = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    match (
        clean(session.device_id.as_deref()),
        clean(challenge.device_id.as_deref()),
    ) {
        (Some(stored), Some(challenged)) if stored != challenged => None,
        (Some(device), _) | (None, Some(device)) => Some(device),
        (None, None) => None,
    }
}

/// Registers the prepared key for the session's device at `base_url`, the
/// API origin this desktop uses, which the signed text names.
async fn register(
    base_url: &str,
    session: &CloudSessionEntry,
    prepared: &PreparedRotation,
) -> Registration {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return Registration::Failed("client_unavailable");
    };
    let challenge = match post(
        &client,
        format!("{base_url}{CHALLENGE_PATH}"),
        &session.token,
        &json!({}),
    )
    .await
    {
        Ok(value) => value,
        Err(registration) => return registration,
    };
    let Ok(challenge) = serde_json::from_value::<Challenge>(challenge) else {
        return Registration::Failed("challenge_invalid");
    };
    if challenge.algorithm != ALGORITHM
        || challenge.purpose != PURPOSE
        || challenge.version != Some(DEVICE_PROOF_VERSION)
    {
        return Registration::Failed("challenge_invalid");
    }
    let Some(device_id) = rotation_device(session, &challenge) else {
        return Registration::Failed("device_mismatch");
    };
    let Ok(text) = device_proof_message(
        PURPOSE,
        base_url,
        &session.account_id,
        &device_id,
        &[("key", &prepared.new_public_key_spki)],
        &challenge.nonce,
    ) else {
        return Registration::Failed("challenge_invalid");
    };
    let request = json!({
        "nonce": challenge.nonce,
        "audience": base_url,
        "publicKey": prepared.new_public_key_spki,
        "keyAlgorithm": "p256",
        "signature": device_identity::sign_with(&prepared.old, text.as_bytes()),
        "newKeySignature": device_identity::sign_with(&prepared.new, text.as_bytes()),
    });
    match post(
        &client,
        format!("{base_url}{ROTATION_PATH}"),
        &session.token,
        &request,
    )
    .await
    {
        Ok(_) => Registration::Registered,
        Err(registration) => registration,
    }
}

#[cfg(test)]
mod tests;
