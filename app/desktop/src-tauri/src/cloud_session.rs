//! OS-keychain backed storage for the Cloud Edition session token.
//!
//! Wraps the `keyring` crate so the desktop frontend can persist a session
//! token without ever touching localStorage. We store a single JSON-encoded
//! entry under service `com.kordi.cloud-session` / username `default`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::SigningKey;
use keyring::Entry;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const KEYCHAIN_USERNAME: &str = "default";
const KEYCHAIN_DEVICE_KEY_SERVICE: &str = "com.kordi.cloud-device-key";
const KEYCHAIN_BRIDGES_API_KEY_SERVICE: &str = "com.kordi.cloud-bridges-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSessionEntry {
    pub token: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
        .map_err(|err| format!("keychain_unavailable: {err}"))
}

fn entry_for(service: &str, account_id: &str) -> Result<Entry, String> {
    Entry::new(service, account_id)
        .map_err(|err| format!("keychain_unavailable: {err}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudDeviceKeypair {
    /// Base58-encoded ed25519 public key.
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pubkey: String,
    /// Base58-encoded x25519 public key derived from the ed25519 key.
    #[serde(rename = "x25519Pubkey")]
    pub x25519_pubkey: String,
}

fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*ed_pub);
    let edwards = compressed
        .decompress()
        .ok_or_else(|| "invalid_ed25519_pubkey".to_string())?;
    let montgomery = edwards.to_montgomery();
    Ok(montgomery.to_bytes())
}

#[tauri::command]
pub fn cloud_device_keypair_load_or_create(account_id: String) -> Result<CloudDeviceKeypair, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_account_id".to_string());
    }
    let keychain_entry = entry_for(KEYCHAIN_DEVICE_KEY_SERVICE, trimmed)?;
    let secret_bytes: [u8; 32] = match keychain_entry.get_password() {
        Ok(value) => {
            let decoded = URL_SAFE_NO_PAD
                .decode(value.as_bytes())
                .map_err(|err| format!("keychain_payload_invalid: {err}"))?;
            if decoded.len() != 32 {
                return Err("keychain_payload_invalid: secret length".to_string());
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&decoded);
            out
        }
        Err(keyring::Error::NoEntry) => {
            let signing = SigningKey::generate(&mut OsRng);
            let bytes = signing.to_bytes();
            let encoded = URL_SAFE_NO_PAD.encode(bytes);
            keychain_entry
                .set_password(&encoded)
                .map_err(|err| format!("keychain_write_failed: {err}"))?;
            bytes
        }
        Err(err) => return Err(format!("keychain_read_failed: {err}")),
    };

    let signing = SigningKey::from_bytes(&secret_bytes);
    let ed_pub = signing.verifying_key();
    let ed_pub_bytes = *ed_pub.as_bytes();
    let x_pub_bytes = ed25519_to_x25519_public(&ed_pub_bytes)?;

    Ok(CloudDeviceKeypair {
        ed25519_pubkey: bs58::encode(ed_pub_bytes).into_string(),
        x25519_pubkey: bs58::encode(x_pub_bytes).into_string(),
    })
}

#[tauri::command]
pub fn cloud_bridges_api_key_store(account_id: String, api_key: String) -> Result<(), String> {
    let trimmed_account = account_id.trim();
    let trimmed_key = api_key.trim();
    if trimmed_account.is_empty() || trimmed_key.is_empty() {
        return Err("invalid_input".to_string());
    }
    let entry = entry_for(KEYCHAIN_BRIDGES_API_KEY_SERVICE, trimmed_account)?;
    entry
        .set_password(trimmed_key)
        .map_err(|err| format!("keychain_write_failed: {err}"))
}

#[tauri::command]
pub fn cloud_bridges_api_key_load(account_id: String) -> Result<Option<String>, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_account_id".to_string());
    }
    let entry = entry_for(KEYCHAIN_BRIDGES_API_KEY_SERVICE, trimmed)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keychain_read_failed: {err}")),
    }
}

#[tauri::command]
pub fn cloud_session_store(
    token: String,
    account_id: String,
    expires_at: String,
) -> Result<(), String> {
    let entry = entry()?;
    let payload = CloudSessionEntry {
        token,
        account_id,
        expires_at,
    };
    let json = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    entry
        .set_password(&json)
        .map_err(|err| format!("keychain_write_failed: {err}"))
}

#[tauri::command]
pub fn cloud_session_load() -> Result<Option<CloudSessionEntry>, String> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(value) => {
            let parsed: CloudSessionEntry = serde_json::from_str(&value).map_err(|err| {
                format!("keychain_payload_invalid: {err}")
            })?;
            Ok(Some(parsed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keychain_read_failed: {err}")),
    }
}

#[tauri::command]
pub fn cloud_session_clear() -> Result<(), String> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keychain_delete_failed: {err}")),
    }
}
