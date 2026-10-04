//! Hosted account session, device identity, and device metadata commands.
//!
//! Where the secrets live (OS keychain in release builds, owner-only files in
//! isolated debug profiles) is decided in `secret_store`.

use serde::{Deserialize, Serialize};
use std::{fs, process::Command};

pub(crate) mod device_identity;
mod secret_store;

pub(crate) use device_identity::sign_with_device_key;
pub(crate) use secret_store::configure_keychain_scope;
use secret_store::{secret_delete, secret_load, secret_store};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const DEVICE_IDENTITY_KEYCHAIN_SERVICE: &str = "com.kordi.cloud-device-identity";
const KEYCHAIN_USERNAME: &str = "default";
/// Secrets that earlier releases kept as plaintext files under `APP_DATA_DIR`.
const LEGACY_FILE_SECRETS: &[(&str, &str)] = &[
    (KEYCHAIN_SERVICE, KEYCHAIN_USERNAME),
    (DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME),
];

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

#[tauri::command]
pub fn cloud_session_store(
    token: String,
    account_id: String,
    expires_at: String,
    device_id: Option<String>,
) -> Result<(), String> {
    if let Some(previous) = cloud_session_load()? {
        if previous.account_id != account_id {
            tauri::async_runtime::spawn(crate::digest_calendar::clear_reminders(Some(
                previous.account_id,
            )));
        }
    }
    let payload = CloudSessionEntry {
        token,
        account_id,
        expires_at,
        device_id,
    };
    let json = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    secret_store(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, &json)?;
    if let Err(err) = crate::cloud_host_activity::start() {
        eprintln!("[kordi] Unable to keep Cloud agent host active: {err}");
    }
    Ok(())
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
    let account_id = cloud_session_load()
        .ok()
        .flatten()
        .map(|session| session.account_id);
    tauri::async_runtime::spawn(crate::digest_calendar::clear_reminders(account_id));
    secret_delete(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    crate::cloud_host_activity::stop();
    Ok(())
}

/// Persist the installation keypair independently of account sign-out. Only
/// the public half leaves native code, for the Cloud API; the private half
/// remains in the OS keychain (or the isolated developer profile's secret
/// directory) and is used only by `device_identity`.
pub(crate) fn cloud_device_identity_store(
    identity: CloudDeviceIdentityEntry,
) -> Result<(), String> {
    if identity.key_algorithm != "p256"
        || identity.private_key_pkcs8.trim().is_empty()
        || identity.public_key_spki.trim().is_empty()
    {
        return Err("device_identity_invalid".to_string());
    }
    let json = serde_json::to_string(&identity).map_err(|error| error.to_string())?;
    secret_store(DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, &json)
}

pub(crate) fn cloud_device_identity_load() -> Result<Option<CloudDeviceIdentityEntry>, String> {
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
    use std::path::PathBuf;

    pub(super) fn with_isolated_app_data_dir<T>(test: impl FnOnce(PathBuf) -> T) -> T {
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
            assert!(dir
                .join("kordi")
                .join(secret_store::DEV_FILE_SECRETS_DIR_NAME)
                .exists());

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
