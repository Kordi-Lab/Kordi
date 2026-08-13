//! Secret storage for hosted account credentials.
//!
//! Packaged apps use the OS keychain. Multi-instance dev runs set `APP_DATA_DIR`,
//! so they use isolated files under that throwaway data directory instead; this
//! avoids macOS keychain password prompts every time the unsigned dev binary is
//! rebuilt while still keeping Cloud sessions out of browser localStorage.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const DEVICE_IDENTITY_KEYCHAIN_SERVICE: &str = "com.kordi.cloud-device-identity";
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
    #[serde(rename = "deviceId", default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudDeviceIdentityEntry {
    #[serde(rename = "privateKeyPkcs8")]
    pub private_key_pkcs8: String,
    #[serde(rename = "publicKeySpki")]
    pub public_key_spki: String,
    #[serde(rename = "keyAlgorithm")]
    pub key_algorithm: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CloudDeviceSystemMetadata {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub platform: String,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "timeZone")]
    pub time_zone: Option<String>,
    #[serde(rename = "countryCode")]
    pub country_code: Option<String>,
}

fn command_output(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn macos_model_name() -> String {
    command_output(
        "/usr/sbin/system_profiler",
        &["SPHardwareDataType", "-detailLevel", "mini"],
    )
    .and_then(|output| {
        output.lines().find_map(|line| {
            line.trim()
                .strip_prefix("Model Name:")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    })
    .unwrap_or_else(|| "Mac".to_string())
}

#[cfg(target_os = "macos")]
fn macos_time_zone() -> Option<String> {
    fs::read_link("/etc/localtime").ok().and_then(|path| {
        let value = path.to_string_lossy();
        value
            .split("zoneinfo/")
            .nth(1)
            .map(str::trim)
            .filter(|zone| !zone.is_empty())
            .map(str::to_string)
    })
}

#[cfg(target_os = "macos")]
fn time_zone_country_code(time_zone: &str) -> Option<String> {
    [
        "/usr/share/zoneinfo/zone1970.tab",
        "/usr/share/zoneinfo/zone.tab",
    ]
    .into_iter()
    .find_map(|path| {
        fs::read_to_string(path).ok().and_then(|contents| {
            contents.lines().find_map(|line| {
                if line.starts_with('#') {
                    return None;
                }
                let mut fields = line.split('\t');
                let countries = fields.next()?;
                let _coordinates = fields.next()?;
                let zone = fields.next()?;
                (zone == time_zone)
                    .then(|| countries.split(',').next().unwrap_or(countries).to_string())
            })
        })
    })
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

#[tauri::command]
pub fn cloud_session_store(
    token: String,
    account_id: String,
    expires_at: String,
    device_id: Option<String>,
) -> Result<(), String> {
    let payload = CloudSessionEntry {
        token,
        account_id,
        expires_at,
        device_id,
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

/// Persist the installation keypair independently of account sign-out. Only
/// the public half is sent to the Cloud API; the private half remains in the
/// OS keychain (or the isolated developer profile's secret directory).
#[tauri::command]
pub fn cloud_device_identity_store(identity: CloudDeviceIdentityEntry) -> Result<(), String> {
    if identity.key_algorithm != "p256"
        || identity.private_key_pkcs8.trim().is_empty()
        || identity.public_key_spki.trim().is_empty()
    {
        return Err("device_identity_invalid".to_string());
    }
    let json = serde_json::to_string(&identity).map_err(|error| error.to_string())?;
    secret_store(DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, &json)
}

#[tauri::command]
pub fn cloud_device_identity_load() -> Result<Option<CloudDeviceIdentityEntry>, String> {
    match secret_load(DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)? {
        Some(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| format!("device_identity_payload_invalid: {error}")),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn cloud_device_system_metadata() -> CloudDeviceSystemMetadata {
    #[cfg(target_os = "macos")]
    {
        let time_zone = macos_time_zone();
        let country_code = time_zone.as_deref().and_then(time_zone_country_code);
        CloudDeviceSystemMetadata {
            display_name: macos_model_name(),
            platform: "macos".to_string(),
            os_version: command_output("/usr/bin/sw_vers", &["-productVersion"])
                .unwrap_or_default(),
            time_zone,
            country_code,
        }
    }

    #[cfg(not(target_os = "macos"))]
    CloudDeviceSystemMetadata {
        display_name: "Kordi desktop".to_string(),
        platform: std::env::consts::OS.to_string(),
        os_version: String::new(),
        time_zone: None,
        country_code: None,
    }
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
                Some("dev_123".to_string()),
            )
            .unwrap();

            let loaded = cloud_session_load().unwrap().expect("stored session");
            assert_eq!(loaded.token, "token-123");
            assert_eq!(loaded.account_id, "acct_123");
            assert_eq!(loaded.device_id.as_deref(), Some("dev_123"));
            assert!(dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME).exists());

            cloud_session_clear().unwrap();
            assert!(cloud_session_load().unwrap().is_none());
        });
    }

    #[test]
    fn device_identity_survives_session_clear_in_isolated_profile() {
        with_isolated_app_data_dir(|_| {
            let identity = CloudDeviceIdentityEntry {
                private_key_pkcs8: "private".to_string(),
                public_key_spki: "public".to_string(),
                key_algorithm: "p256".to_string(),
            };
            cloud_device_identity_store(identity.clone()).unwrap();
            cloud_session_clear().unwrap();

            assert_eq!(cloud_device_identity_load().unwrap(), Some(identity));
        });
    }
}
