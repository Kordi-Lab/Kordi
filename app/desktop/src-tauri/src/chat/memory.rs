//! Account memory on the Mac (#1710): the cloud remote for the `reflection`
//! tool and the Memory settings commands.
use kordi_cli::memory_remote::{
    sync_memories_with_remote, MemoryRemote, MemoryRemoteError, NewRemoteMemory, RemoteMemory,
    RemoteMemoryList,
};
use kordi_core::settings::{MemorySettings, Settings};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

/// `MemoryRemote` backed by `/v1/cloud/memory` with the cloud session token.
pub(crate) struct CloudMemoryRemote {
    account_id: String,
    client: reqwest::Client,
}

impl CloudMemoryRemote {
    /// Build a remote for the stored cloud session, or `None` when signed out.
    /// Reads the keychain, so call it off the async executor.
    pub(crate) fn from_cloud_session() -> Option<Self> {
        let session = crate::cloud_session::cloud_session_load().ok().flatten()?;
        if session.token.trim().is_empty() || session.account_id.trim().is_empty() {
            return None;
        }
        Some(Self::new(session.account_id))
    }

    pub(crate) fn new(account_id: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Self { account_id, client }
    }

    async fn token(&self) -> Result<String, MemoryRemoteError> {
        let account_id = self.account_id.clone();
        tokio::task::spawn_blocking(move || {
            let session = crate::cloud_session::cloud_session_load()
                .ok()
                .flatten()
                .ok_or_else(|| MemoryRemoteError::Unavailable("signed out".to_string()))?;
            if session.account_id != account_id || session.token.trim().is_empty() {
                return Err(MemoryRemoteError::Unavailable(
                    "cloud session changed".to_string(),
                ));
            }
            Ok(session.token)
        })
        .await
        .map_err(|error| MemoryRemoteError::Other(error.to_string()))?
    }

    fn endpoint() -> Result<String, MemoryRemoteError> {
        let base = crate::cloud_api_base_url_from_env().map_err(MemoryRemoteError::Unavailable)?;
        let base = base.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(MemoryRemoteError::Unavailable(
                "no cloud API base URL".to_string(),
            ));
        }
        Ok(format!("{base}/v1/cloud/memory"))
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, MemoryRemoteError> {
        let token = self.token().await?;
        let response = request
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| MemoryRemoteError::Unavailable(error.to_string()))?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE)
        {
            return Err(MemoryRemoteError::Other(
                "memory response is too large".to_string(),
            ));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| MemoryRemoteError::Unavailable(error.to_string()))?;
        if !status.is_success() {
            return Err(decode_memory_error(status.as_u16(), &body));
        }
        serde_json::from_slice(&body).map_err(|error| MemoryRemoteError::Other(error.to_string()))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct SavedMemoryBody {
    memory: RemoteMemory,
}

/// Map a failed memory response to the remote error kinds.
pub(crate) fn decode_memory_error(status: u16, body: &[u8]) -> MemoryRemoteError {
    let parsed = serde_json::from_slice::<ErrorBody>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|body| body.error_code.as_deref())
        .unwrap_or_default();
    let message = parsed
        .as_ref()
        .and_then(|body| body.message.clone())
        .map(|message| message.chars().take(500).collect::<String>())
        .unwrap_or_else(|| format!("memory request failed with status {status}"));
    match (status, code) {
        (422, "memory_rejected") => MemoryRemoteError::Rejected(message),
        (409, "memory_disabled") => MemoryRemoteError::Disabled,
        (404, _) => MemoryRemoteError::Unavailable(message),
        (401 | 403, _) => MemoryRemoteError::Unavailable(message),
        (status, _) if status >= 500 => MemoryRemoteError::Unavailable(message),
        _ => MemoryRemoteError::Other(message),
    }
}

#[async_trait::async_trait]
impl MemoryRemote for CloudMemoryRemote {
    fn account_id(&self) -> String {
        self.account_id.clone()
    }

    async fn list(&self) -> Result<RemoteMemoryList, MemoryRemoteError> {
        let endpoint = Self::endpoint()?;
        self.send(self.client.get(endpoint)).await
    }

    async fn save(&self, memory: NewRemoteMemory) -> Result<RemoteMemory, MemoryRemoteError> {
        let endpoint = Self::endpoint()?;
        // 201 for a new memory, 200 when a clientMemoryId retry matches.
        let saved: SavedMemoryBody = self.send(self.client.post(endpoint).json(&memory)).await?;
        Ok(saved.memory)
    }
}

/// Fill the runtime's memory remote from the stored cloud session.
pub(crate) async fn attach_memory_remote(
    runtime: &mut kordi_cli::desktop_runtime::DesktopRuntimeSession,
) {
    let remote = tokio::task::spawn_blocking(CloudMemoryRemote::from_cloud_session)
        .await
        .ok()
        .flatten()
        .map(|remote| Arc::new(remote) as Arc<dyn MemoryRemote>);
    runtime.set_memory_remote(remote);
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMemorySettings {
    memory_enabled: bool,
    exclude_sensitive: bool,
}

impl From<MemorySettings> for DesktopMemorySettings {
    fn from(settings: MemorySettings) -> Self {
        Self {
            memory_enabled: settings.memory_enabled,
            exclude_sensitive: settings.exclude_sensitive,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMemorySettingsPatch {
    #[serde(default)]
    memory_enabled: Option<bool>,
    #[serde(default)]
    exclude_sensitive: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMemorySyncResult {
    uploaded: usize,
    downloaded: usize,
    rejected: usize,
    settings: Option<DesktopMemorySettings>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalMemory {
    lesson_id: String,
    scope: String,
    scope_id: String,
    scope_label: Option<String>,
    source: String,
    text: String,
    created_at: String,
    updated_at: String,
    pending_upload: bool,
}

fn update_memory_settings(
    patch: DesktopMemorySettingsPatch,
) -> Result<DesktopMemorySettings, String> {
    Settings::update_global_memory(|memory| {
        if let Some(value) = patch.memory_enabled {
            memory.memory_enabled = value;
        }
        if let Some(value) = patch.exclude_sensitive {
            memory.exclude_sensitive = value;
        }
    })
    .map(DesktopMemorySettings::from)
    .map_err(|error| format!("Unable to save memory settings: {error}"))
}

fn open_session_db() -> Result<(rusqlite::Connection, std::path::PathBuf), String> {
    let settings = Settings::load_global();
    let conn =
        kordi_session::store::open_db(&kordi_core::config::session_db_path(&settings.storage))
            .map_err(|error| format!("Unable to open the session database: {error}"))?;
    Ok((conn, kordi_core::config::artifacts_dir(&settings.storage)))
}

#[tauri::command]
pub fn desktop_memory_settings() -> Result<DesktopMemorySettings, String> {
    Ok(Settings::load_global().memory.into())
}

#[tauri::command]
pub fn desktop_memory_update_settings(
    patch: DesktopMemorySettingsPatch,
) -> Result<DesktopMemorySettings, String> {
    update_memory_settings(patch)
}

#[tauri::command]
pub async fn desktop_memory_sync() -> Result<DesktopMemorySyncResult, String> {
    let remote = tokio::task::spawn_blocking(CloudMemoryRemote::from_cloud_session)
        .await
        .map_err(|error| error.to_string())?;
    let Some(remote) = remote else {
        return Ok(DesktopMemorySyncResult::default());
    };
    let (conn, artifacts_dir) = tokio::task::spawn_blocking(open_session_db)
        .await
        .map_err(|error| error.to_string())??;
    let conn = tokio::sync::Mutex::new(conn);
    let report = sync_memories_with_remote(&conn, &artifacts_dir, &remote)
        .await
        .map_err(|error| format!("Unable to sync memories: {error}"))?;
    let settings = match report.settings {
        Some(server) => Some(update_memory_settings(DesktopMemorySettingsPatch {
            memory_enabled: Some(server.memory_enabled),
            exclude_sensitive: Some(server.exclude_sensitive),
        })?),
        None => None,
    };
    Ok(DesktopMemorySyncResult {
        uploaded: report.uploaded,
        downloaded: report.downloaded,
        rejected: report.rejected,
        settings,
    })
}

#[tauri::command]
pub async fn desktop_memory_list_local() -> Result<Vec<DesktopLocalMemory>, String> {
    tokio::task::spawn_blocking(|| {
        let (conn, _) = open_session_db()?;
        let rows = kordi_session::reflection_lessons::list_all_reflection_lessons(&conn)
            .map_err(|error| format!("Unable to read memories: {error}"))?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some(DesktopLocalMemory {
                    text: row.lesson_text?,
                    lesson_id: row.lesson_id,
                    scope: row.scope.as_str().to_string(),
                    scope_id: row.scope_id,
                    scope_label: row.scope_label,
                    source: row.source.as_str().to_string(),
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    pending_upload: row.pending_upload,
                })
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_memory_error_bodies() {
        assert_eq!(
            decode_memory_error(
                422,
                br#"{"errorCode":"memory_rejected","message":"Memories cannot record health details."}"#
            ),
            MemoryRemoteError::Rejected("Memories cannot record health details.".to_string())
        );
        assert_eq!(
            decode_memory_error(
                409,
                br#"{"errorCode":"memory_disabled","message":"Memory is off."}"#
            ),
            MemoryRemoteError::Disabled
        );
        assert_eq!(
            decode_memory_error(
                409,
                br#"{"errorCode":"memory_id_conflict","message":"Id is taken."}"#
            ),
            MemoryRemoteError::Other("Id is taken.".to_string())
        );
        assert!(matches!(
            decode_memory_error(404, b"Not Found"),
            MemoryRemoteError::Unavailable(_)
        ));
        assert!(matches!(
            decode_memory_error(400, b"{}"),
            MemoryRemoteError::Other(_)
        ));
    }

    #[test]
    fn decodes_saved_memory_and_list_bodies() {
        let saved: SavedMemoryBody = serde_json::from_str(
            r#"{"memory":{"memoryId":"m1","scope":"project","scopeId":"/repo","scopeLabel":null,"source":"manual","text":"Use pnpm.","createdAt":"2026-10-07T10:00:00Z","updatedAt":"2026-10-07T10:00:00Z"}}"#,
        )
        .unwrap();
        assert_eq!(saved.memory.memory_id, "m1");
        let list: RemoteMemoryList = serde_json::from_str(
            r#"{"memories":[],"settings":{"memoryEnabled":false,"excludeSensitive":true}}"#,
        )
        .unwrap();
        assert!(!list.settings.memory_enabled);
        let body = serde_json::to_value(NewRemoteMemory {
            scope: "project".to_string(),
            scope_id: "/repo".to_string(),
            scope_label: None,
            source: "manual".to_string(),
            text: "Use pnpm.".to_string(),
            client_memory_id: Some("mem_abc".to_string()),
        })
        .unwrap();
        assert_eq!(body["clientMemoryId"], "mem_abc");
        assert!(body.get("scopeLabel").is_none());
    }
}
