//! OS-keychain backed storage for the Cloud Edition session token.
//!
//! Wraps the `keyring` crate so the desktop frontend can persist a session
//! token without ever touching localStorage. We store a single JSON-encoded
//! entry under service `com.kordi.cloud-session` / username `default`.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "com.kordi.cloud-session";
const KEYCHAIN_USERNAME: &str = "default";

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
