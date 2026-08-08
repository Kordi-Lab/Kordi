use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const RESTORE_ALGORITHM: &str = "x25519-hkdf-sha256-aes-256-gcm-v1";
const RESTORE_HKDF_INFO: &[u8] = b"kordi-provider-auth-device-restore-v1";
const MAX_RESTORE_CIPHERTEXT_BYTES: usize = 1024 * 1024 + 4096;
const DEVICE_KEY_SERVICE: &str = "com.kordi.cloud-provider-auth-device-key";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoreEnvelope {
    algorithm: String,
    server_public_key: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoreResponse {
    pub(super) device_id: String,
    pub(super) snapshot_count: usize,
    pub(super) sync_revision: String,
    pub(super) changed: bool,
    pub(super) envelope: Option<RestoreEnvelope>,
}

pub(super) async fn request_restore_envelope(
    token: &str,
    device_public_key: &[u8; 32],
    known_revision: Option<&str>,
) -> Result<RestoreResponse, String> {
    let base_url = crate::cloud_api_base_url_from_env()?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/cloud/agent-provider-auth/snapshots/restore",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&json!({
            "devicePublicKey": URL_SAFE_NO_PAD.encode(device_public_key),
            "knownRevision": known_revision,
        }))
        .send()
        .await
        .map_err(|err| format!("Cloud provider-auth restore request failed: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let code = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| {
                body.get("errorCode")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "cloud_provider_auth_restore_failed".to_string());
        return Err(format!("{code} ({status})"));
    }
    response
        .json::<RestoreResponse>()
        .await
        .map_err(|_| "Cloud provider-auth restore response is invalid".to_string())
}

pub(super) fn decrypt_restore_envelope(
    account_id: &str,
    device_id: &str,
    device_secret: &StaticSecret,
    envelope: &RestoreEnvelope,
) -> Result<Vec<u8>, String> {
    if envelope.algorithm != RESTORE_ALGORITHM {
        return Err("Cloud provider-auth restore algorithm is unsupported".to_string());
    }
    let server_public_key = decode_fixed::<32>(&envelope.server_public_key, "server public key")?;
    let salt = decode_fixed::<32>(&envelope.salt, "salt")?;
    let nonce = decode_fixed::<12>(&envelope.nonce, "nonce")?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| "Cloud provider-auth restore ciphertext is invalid".to_string())?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_RESTORE_CIPHERTEXT_BYTES {
        return Err("Cloud provider-auth restore ciphertext size is invalid".to_string());
    }
    let shared_secret = device_secret.diffie_hellman(&PublicKey::from(server_public_key));
    if !shared_secret.was_contributory() {
        return Err("Cloud provider-auth restore key exchange failed".to_string());
    }
    let mut key_bytes = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(RESTORE_HKDF_INFO, &mut key_bytes)
        .map_err(|_| "Cloud provider-auth restore key derivation failed".to_string())?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let aad = format!("kordi-provider-auth-device-restore-v1\0{account_id}\0{device_id}");
    let plaintext = cipher.decrypt(
        Nonce::from_slice(&nonce),
        Payload {
            msg: &ciphertext,
            aad: aad.as_bytes(),
        },
    );
    key_bytes.fill(0);
    plaintext.map_err(|_| "Cloud provider-auth restore decryption failed".to_string())
}

fn decode_fixed<const N: usize>(encoded: &str, label: &str) -> Result<[u8; N], String> {
    URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| format!("Cloud provider-auth restore {label} is invalid"))
}

pub(super) fn provider_auth_device_secret(account_id: &str) -> Result<StaticSecret, String> {
    let instance_scope = std::env::var("APP_INSTANCE_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "desktop".to_string());
    let key_account = format!("{account_id}:{instance_scope}");
    if let Some(encoded) = crate::cloud_session::secret_load(DEVICE_KEY_SERVICE, &key_account)? {
        return Ok(StaticSecret::from(decode_fixed::<32>(
            encoded.trim(),
            "saved device key",
        )?));
    }
    let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    crate::cloud_session::secret_store(
        DEVICE_KEY_SERVICE,
        &key_account,
        &URL_SAFE_NO_PAD.encode(secret.to_bytes()),
    )?;
    Ok(secret)
}
