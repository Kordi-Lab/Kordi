//! Secret storage for Cloud Edition credentials.
//!
//! Packaged apps use the OS keychain. Multi-instance dev runs set `APP_DATA_DIR`,
//! so they use isolated files under that throwaway data directory instead; this
//! avoids macOS keychain password prompts every time the unsigned dev binary is
//! rebuilt while still keeping Cloud sessions out of browser localStorage.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::SigningKey;
use keyring::Entry;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const KEYCHAIN_USERNAME: &str = "default";
const KEYCHAIN_DEVICE_KEY_SERVICE: &str = "com.kordi.cloud-device-key";
const KEYCHAIN_BRIDGES_API_KEY_SERVICE: &str = "com.kordi.cloud-bridges-api-key";
const DEV_FILE_SECRETS_DIR_NAME: &str = "cloud-secrets";

/// Suffix the keychain service name with the running instance id when
/// `APP_INSTANCE_ID` is set (the multi-instance launcher sets it to
/// `user1`, `user2`, etc.). Without this, every Tauri window on the
/// same machine shares one keychain entry, so signing up in window 2
/// silently overwrites window 1's session and both windows end up as
/// the same account — which broke side-by-side multi-user testing.
fn scoped_service(base: &str) -> String {
    match std::env::var("APP_INSTANCE_ID") {
        Ok(value) if !value.trim().is_empty() => format!("{base}.{}", value.trim()),
        _ => base.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSessionEntry {
    pub token: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

fn entry_for(service: &str, account_id: &str) -> Result<Entry, String> {
    Entry::new(&scoped_service(service), account_id)
        .map_err(|err| format!("keychain_unavailable: {err}"))
}

fn dev_file_secret_path(service: &str, account_id: &str) -> Option<PathBuf> {
    let data_dir = std::env::var_os("APP_DATA_DIR")?;
    let scoped = scoped_service(service);
    let encoded_name = URL_SAFE_NO_PAD.encode(format!("{scoped}:{account_id}"));
    Some(
        PathBuf::from(data_dir)
            .join("kordi")
            .join(DEV_FILE_SECRETS_DIR_NAME)
            .join(format!("{encoded_name}.secret")),
    )
}

fn secret_store(service: &str, account_id: &str, value: &str) -> Result<(), String> {
    if let Some(path) = dev_file_secret_path(service, account_id) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("file_secret_write_failed: {err}"))?;
        }
        return fs::write(path, value).map_err(|err| format!("file_secret_write_failed: {err}"));
    }

    entry_for(service, account_id)?
        .set_password(value)
        .map_err(|err| format!("keychain_write_failed: {err}"))
}

fn secret_load(service: &str, account_id: &str) -> Result<Option<String>, String> {
    if let Some(path) = dev_file_secret_path(service, account_id) {
        return match fs::read_to_string(path) {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("file_secret_read_failed: {err}")),
        };
    }

    match entry_for(service, account_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keychain_read_failed: {err}")),
    }
}

fn secret_delete(service: &str, account_id: &str) -> Result<(), String> {
    if let Some(path) = dev_file_secret_path(service, account_id) {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("file_secret_delete_failed: {err}")),
        };
    }

    match entry_for(service, account_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keychain_delete_failed: {err}")),
    }
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
pub fn cloud_device_keypair_load_or_create(
    account_id: String,
) -> Result<CloudDeviceKeypair, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_account_id".to_string());
    }
    let secret_bytes: [u8; 32] = match secret_load(KEYCHAIN_DEVICE_KEY_SERVICE, trimmed)? {
        Some(value) => {
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
        None => {
            let signing = SigningKey::generate(&mut OsRng);
            let bytes = signing.to_bytes();
            let encoded = URL_SAFE_NO_PAD.encode(bytes);
            secret_store(KEYCHAIN_DEVICE_KEY_SERVICE, trimmed, &encoded)?;
            bytes
        }
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
    secret_store(
        KEYCHAIN_BRIDGES_API_KEY_SERVICE,
        trimmed_account,
        trimmed_key,
    )
}

#[tauri::command]
pub fn cloud_bridges_api_key_load(account_id: String) -> Result<Option<String>, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_account_id".to_string());
    }
    secret_load(KEYCHAIN_BRIDGES_API_KEY_SERVICE, trimmed)
}

#[tauri::command]
pub fn cloud_session_store(
    token: String,
    account_id: String,
    expires_at: String,
) -> Result<(), String> {
    let payload = CloudSessionEntry {
        token,
        account_id,
        expires_at,
    };
    let json = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    secret_store(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, &json)
}

#[tauri::command]
pub fn cloud_session_load() -> Result<Option<CloudSessionEntry>, String> {
    match secret_load(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)? {
        Some(value) => {
            let parsed: CloudSessionEntry = serde_json::from_str(&value)
                .map_err(|err| format!("keychain_payload_invalid: {err}"))?;
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn cloud_session_clear() -> Result<(), String> {
    secret_delete(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_isolated_app_data_dir<T>(test: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::lock_process_environment();
        let previous_app_data_dir = std::env::var_os("APP_DATA_DIR");
        let previous_instance_id = std::env::var_os("APP_INSTANCE_ID");
        let dir =
            std::env::temp_dir().join(format!("kordi-cloud-session-test-{}", uuid::Uuid::new_v4()));

        std::env::set_var("APP_DATA_DIR", &dir);
        std::env::set_var("APP_INSTANCE_ID", "user2");
        let output = test(dir.clone());
        let _ = fs::remove_dir_all(&dir);
        match previous_app_data_dir {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
        match previous_instance_id {
            Some(value) => std::env::set_var("APP_INSTANCE_ID", value),
            None => std::env::remove_var("APP_INSTANCE_ID"),
        }
        output
    }

    #[test]
    fn cloud_session_uses_app_data_file_store_when_isolated_dev_instance_is_running() {
        with_isolated_app_data_dir(|dir| {
            assert!(cloud_session_load().unwrap().is_none());
            cloud_session_store(
                "token-123".to_string(),
                "acct_123".to_string(),
                "2026-01-01T00:00:00Z".to_string(),
            )
            .unwrap();

            let loaded = cloud_session_load().unwrap().expect("stored session");
            assert_eq!(loaded.token, "token-123");
            assert_eq!(loaded.account_id, "acct_123");
            assert!(dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME).exists());

            cloud_session_clear().unwrap();
            assert!(cloud_session_load().unwrap().is_none());
        });
    }

    #[test]
    fn cloud_device_key_uses_stable_app_data_file_store() {
        with_isolated_app_data_dir(|_| {
            let first = cloud_device_keypair_load_or_create("acct_123".to_string()).unwrap();
            let second = cloud_device_keypair_load_or_create("acct_123".to_string()).unwrap();
            assert_eq!(first.ed25519_pubkey, second.ed25519_pubkey);
            assert_eq!(first.x25519_pubkey, second.x25519_pubkey);
        });
    }
}
