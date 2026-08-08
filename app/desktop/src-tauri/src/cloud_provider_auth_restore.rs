use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use x25519_dalek::PublicKey;

mod payload;
mod transport;
use payload::{optional_string, optional_value, required_i64, required_string};
use transport::{decrypt_restore_envelope, provider_auth_device_secret, request_restore_envelope};

const SYNC_STATE_FILENAME: &str = "provider-auth-sync.json";

fn oauth_expiry_or_unknown(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<i64, String> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(i64::MAX),
        Some(value) => {
            if let Some(expiry) = value.as_i64().filter(|value| *value > 0) {
                return Ok(expiry);
            }
            if let Some(expiry) = value.as_u64().filter(|value| *value > 0) {
                return Ok(i64::try_from(expiry).unwrap_or(i64::MAX));
            }
            Err(format!(
                "Cloud provider-auth restore field {key} is invalid"
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBundle {
    version: u32,
    account_id: String,
    device_id: String,
    sync_revision: String,
    snapshots: Vec<RestoreSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreSnapshot {
    snapshot_id: String,
    provider: String,
    auth_choice: String,
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudProviderAuthRestoreResult {
    restored_profiles: usize,
    removed_profiles: usize,
    selection_changed: bool,
    restored_providers: Vec<String>,
    sync_revision: String,
    changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SyncedProfile {
    provider: String,
    profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAuthSyncState {
    version: u32,
    sync_revision: String,
    profiles: Vec<SyncedProfile>,
}

impl Default for ProviderAuthSyncState {
    fn default() -> Self {
        Self {
            version: 1,
            sync_revision: String::new(),
            profiles: Vec::new(),
        }
    }
}

#[tauri::command]
pub async fn desktop_cloud_provider_auth_restore(
    account_id: String,
) -> Result<DesktopCloudProviderAuthRestoreResult, String> {
    let account_id = account_id.trim();
    let active = crate::cloud_account_paths::cloud_account_storage_current()?
        .ok_or_else(|| "Cloud account storage is not active".to_string())?;
    if active.account_id != account_id {
        return Err(
            "Cloud provider-auth restore account does not match active storage".to_string(),
        );
    }
    let session = crate::cloud_session::cloud_session_load()?
        .ok_or_else(|| "Cloud session is unavailable".to_string())?;
    if session.account_id != account_id {
        return Err("Cloud provider-auth restore account does not match session".to_string());
    }

    let sync_state_path = provider_auth_sync_state_path(&active.storage_root);
    let previous_sync_state = load_provider_auth_sync_state(&sync_state_path)?;
    let device_secret = provider_auth_device_secret(account_id)?;
    let device_public = PublicKey::from(&device_secret);
    let response = request_restore_envelope(
        &session.token,
        device_public.as_bytes(),
        (!previous_sync_state.sync_revision.is_empty())
            .then_some(previous_sync_state.sync_revision.as_str()),
    )
    .await?;
    if !response.changed {
        return Ok(DesktopCloudProviderAuthRestoreResult {
            restored_profiles: 0,
            removed_profiles: 0,
            selection_changed: false,
            restored_providers: Vec::new(),
            sync_revision: response.sync_revision,
            changed: false,
        });
    }
    let snapshots = if let Some(envelope) = response.envelope {
        let plaintext =
            decrypt_restore_envelope(account_id, &response.device_id, &device_secret, &envelope)?;
        let bundle: RestoreBundle = serde_json::from_slice(&plaintext)
            .map_err(|_| "Cloud provider-auth restore payload is invalid".to_string())?;
        if bundle.version != 2
            || bundle.account_id != account_id
            || bundle.device_id != response.device_id
            || bundle.sync_revision != response.sync_revision
            || bundle.snapshots.len() != response.snapshot_count
        {
            return Err("Cloud provider-auth restore binding validation failed".to_string());
        }
        bundle.snapshots
    } else {
        if response.snapshot_count != 0 {
            return Err("Cloud provider-auth restore response is inconsistent".to_string());
        }
        Vec::new()
    };

    let mut imports = Vec::with_capacity(snapshots.len());
    let mut restored_providers = Vec::new();
    let mut synced_profiles = Vec::new();
    for snapshot in snapshots {
        let imported = auth_import_from_snapshot(snapshot)?;
        if !restored_providers.contains(&imported.provider) {
            restored_providers.push(imported.provider.clone());
        }
        synced_profiles.push(SyncedProfile {
            provider: imported.provider.clone(),
            profile_id: imported.profile_id.clone(),
        });
        imports.push(imported);
    }
    let previously_synced = previous_sync_state
        .profiles
        .iter()
        .map(|profile| (profile.provider.clone(), profile.profile_id.clone()))
        .collect::<Vec<_>>();
    let reconciled =
        kordi_cli::login::reconcile_cloud_auth_profiles(imports, &previously_synced)
            .map_err(|err| format!("Could not save restored provider authentication: {err}"))?;
    save_provider_auth_sync_state(
        &sync_state_path,
        &ProviderAuthSyncState {
            version: 1,
            sync_revision: response.sync_revision.clone(),
            profiles: synced_profiles,
        },
    )?;
    if reconciled.imported_profiles > 0
        || reconciled.removed_profiles > 0
        || reconciled.selection_changed
    {
        kordi_cli::desktop_runtime::clear_desktop_model_options_cache();
    }
    Ok(DesktopCloudProviderAuthRestoreResult {
        restored_profiles: reconciled.imported_profiles,
        removed_profiles: reconciled.removed_profiles,
        selection_changed: reconciled.selection_changed,
        restored_providers,
        sync_revision: response.sync_revision,
        changed: true,
    })
}

fn provider_auth_sync_state_path(storage_root: &str) -> PathBuf {
    PathBuf::from(storage_root).join(SYNC_STATE_FILENAME)
}

fn load_provider_auth_sync_state(path: &Path) -> Result<ProviderAuthSyncState, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let state = serde_json::from_slice::<ProviderAuthSyncState>(&bytes)
                .map_err(|_| "Cloud provider-auth sync state is invalid".to_string())?;
            if state.version != 1 {
                return Err("Cloud provider-auth sync state version is unsupported".to_string());
            }
            Ok(state)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(ProviderAuthSyncState::default())
        }
        Err(err) => Err(format!(
            "Could not read Cloud provider-auth sync state: {err}"
        )),
    }
}

fn save_provider_auth_sync_state(path: &Path, state: &ProviderAuthSyncState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Cloud provider-auth sync state path is invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|err| {
        format!("Could not create Cloud provider-auth sync state directory: {err}")
    })?;
    let tmp_path = path.with_file_name(format!(
        ".{SYNC_STATE_FILENAME}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|_| "Could not encode Cloud provider-auth sync state".to_string())?;
    fs::write(&tmp_path, bytes)
        .map_err(|err| format!("Could not write Cloud provider-auth sync state: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Could not protect Cloud provider-auth sync state: {err}"))?;
    }
    fs::rename(&tmp_path, path)
        .inspect_err(|_| {
            let _ = fs::remove_file(&tmp_path);
        })
        .map_err(|err| format!("Could not commit Cloud provider-auth sync state: {err}"))
}

fn auth_import_from_snapshot(
    snapshot: RestoreSnapshot,
) -> Result<kordi_cli::login::CloudAuthProfileImport, String> {
    let payload = snapshot
        .payload
        .as_object()
        .ok_or_else(|| "Cloud provider-auth restore payload is invalid".to_string())?;
    let active = payload
        .get("syncActive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if payload.get("apiKey").is_some() {
        let profile_id = restored_profile_id(&snapshot, "api-key")?;
        return Ok(kordi_cli::login::CloudAuthProfileImport {
            provider: snapshot.provider,
            profile_id,
            active,
            secret: kordi_cli::login::CloudAuthProfileSecret::ApiKey {
                key: required_string(payload, "apiKey")?,
            },
        });
    }
    let api_mode = payload
        .get("apiMode")
        .and_then(Value::as_str)
        .ok_or_else(|| "Cloud provider-auth restore OAuth mode is missing".to_string())?;
    let access_token = required_string(payload, "accessToken")?;
    let refresh_token = optional_string(payload, "refreshToken");
    let profile_id = restored_profile_id(&snapshot, api_mode)?;
    let provider_matches = match api_mode {
        "openai-codex-oauth" => matches!(snapshot.provider.as_str(), "openai" | "openai-codex"),
        "anthropic-oauth" => snapshot.provider == "anthropic",
        "github-copilot-oauth" => snapshot.provider == "github-copilot",
        _ => false,
    };
    if !provider_matches {
        return Err("Cloud provider-auth restore provider binding is invalid".to_string());
    }

    match api_mode {
        "openai-codex-oauth" => Ok(kordi_cli::login::CloudAuthProfileImport {
            provider: "openai-codex".to_string(),
            profile_id,
            active,
            secret: kordi_cli::login::CloudAuthProfileSecret::OAuth {
                access: access_token,
                refresh: refresh_token,
                // Early Cloud snapshots did not persist an expiry for OAuth
                // credentials whose local source did not expose one. Preserve
                // those snapshots as non-expiring, matching the local auth
                // store's existing representation for an unknown expiry.
                expires: oauth_expiry_or_unknown(payload, "expiresAt")?,
                extra: json!({
                    "accountId": optional_value(payload, "accountId"),
                }),
            },
        }),
        "anthropic-oauth" => Ok(kordi_cli::login::CloudAuthProfileImport {
            provider: "anthropic".to_string(),
            profile_id,
            active,
            secret: kordi_cli::login::CloudAuthProfileSecret::OAuth {
                access: access_token,
                refresh: refresh_token,
                expires: oauth_expiry_or_unknown(payload, "expiresAt")?,
                extra: json!({}),
            },
        }),
        "github-copilot-oauth" => {
            let github_access_token = required_string(payload, "githubAccessToken")?;
            let authority = optional_string(payload, "authority");
            let account_label = optional_string(payload, "accountLabel");
            let runtime_expires_at = required_i64(payload, "runtimeExpiresAt")?;
            Ok(kordi_cli::login::CloudAuthProfileImport {
                provider: "github-copilot".to_string(),
                profile_id,
                active,
                secret: kordi_cli::login::CloudAuthProfileSecret::OAuth {
                    access: github_access_token,
                    refresh: refresh_token,
                    expires: required_i64(payload, "githubAccessExpiresAt")?,
                    extra: json!({
                        "domain": if authority.is_empty() { "github.com" } else { authority.as_str() },
                        "login": if account_label.is_empty() { None } else { Some(account_label) },
                        "copilot_token": access_token,
                        "copilot_expires_at": runtime_expires_at,
                        "copilot_api_base_url": optional_string(payload, "baseUrl"),
                    }),
                },
            })
        }
        _ => Err(format!(
            "Cloud provider-auth restore does not support OAuth mode {api_mode}"
        )),
    }
}

fn restored_profile_id(snapshot: &RestoreSnapshot, api_mode: &str) -> Result<String, String> {
    if let Some(profile_id) = snapshot.auth_choice.strip_prefix("profile:") {
        return Ok(profile_id.to_string());
    }
    let prefix = match api_mode {
        "api-key" => "api-key",
        "openai-codex-oauth" => "openai-codex",
        "anthropic-oauth" => "anthropic-oauth",
        "github-copilot-oauth" => "github-copilot",
        _ => return Err("Cloud provider-auth restore OAuth mode is unsupported".to_string()),
    };
    let snapshot_id = snapshot
        .snapshot_id
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
        .collect::<String>();
    if snapshot_id.is_empty() {
        return Err("Cloud provider-auth restore snapshot id is invalid".to_string());
    }
    Ok(format!("{prefix}-cloud-{snapshot_id}"))
}

#[cfg(test)]
mod tests;
