//! Secret storage for hosted account credentials.
//!
//! Packaged apps use the OS keychain. Multi-instance dev runs set `APP_DATA_DIR`,
//! so they use isolated files under that throwaway data directory instead; this
//! avoids macOS keychain password prompts every time the unsigned dev binary is
//! rebuilt while still keeping Cloud sessions out of browser localStorage.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const KEYCHAIN_USERNAME: &str = "default";
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

pub(crate) fn secret_store(service: &str, account_id: &str, value: &str) -> Result<(), String> {
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

pub(crate) fn secret_load(service: &str, account_id: &str) -> Result<Option<String>, String> {
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
}
