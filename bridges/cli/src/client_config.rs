use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::ClientConfigError;

/// Client config stored at ~/.bridges/config.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub coordination: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub owner: Option<String>,
}

fn config_path() -> Result<PathBuf, ClientConfigError> {
    let base = directories::BaseDirs::new().ok_or(ClientConfigError::HomeDirUnavailable)?;
    Ok(base.home_dir().join(".bridges").join("config.json"))
}

impl ClientConfig {
    /// Load from ~/.bridges/config.json. Returns `Ok(None)` if missing.
    pub fn load() -> Result<Option<Self>, ClientConfigError> {
        let path = config_path()?;
        let data = match fs::read_to_string(&path) {
            Ok(data) => data,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(ClientConfigError::Read { path, source }),
        };
        let cfg = serde_json::from_str(&data)
            .map_err(|source| ClientConfigError::Parse { path, source })?;
        Ok(Some(cfg))
    }

    /// Load or exit with helpful error.
    pub fn load_or_exit() -> Self {
        match Self::load() {
            Ok(Some(cfg)) if !cfg.api_key.trim().is_empty() => cfg,
            Ok(Some(_)) | Ok(None) => {
                eprintln!("Not registered. Run: bridges register --coordination <url>");
                std::process::exit(1);
            }
            Err(err) => {
                eprintln!("Failed to load client config: {}", err);
                std::process::exit(1);
            }
        }
    }

    /// Save to ~/.bridges/config.json with restrictive permissions (0600).
    pub fn save(&self) -> Result<(), ClientConfigError> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| ClientConfigError::CreateDir {
                path: parent.to_path_buf(),
                source,
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok();
            }
        }
        let json = serde_json::to_string_pretty(self).map_err(ClientConfigError::Serialize)?;
        fs::write(&path, &json).map_err(|source| ClientConfigError::Write {
            path: path.clone(),
            source,
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).ok();
        }
        Ok(())
    }
}
