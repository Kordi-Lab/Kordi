//! Authentication file discovery, locking, validation, and atomic persistence.

use super::migrations::migrate_loaded_store;
use super::models::AuthStore;
use anyhow::Result;
use kordi_core::{config, settings::Settings};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static AUTH_STORE_PROCESS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Path to the shared CLI auth store used by both `kordi login` and the TUI
/// auth flows.
///
/// Example:
/// - on Linux this typically resolves under `~/.kordi/auth.json`
/// - legacy auth stores are migrated automatically when possible
pub fn auth_path() -> PathBuf {
    let global_settings = Settings::load_global();
    config::auth_path(&global_settings.storage)
}

// Public for the desktop library target; unused by the standalone CLI binary.
#[allow(dead_code)]
pub fn validate_auth_store() -> Result<()> {
    let path = auth_path();
    if !path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&path)?;
    serde_json::from_str::<AuthStore>(&content)?;
    Ok(())
}

pub(in crate::login) fn load_auth() -> AuthStore {
    let path = auth_path();
    let mut store = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => AuthStore::default(),
        }
    } else {
        AuthStore::default()
    };
    migrate_loaded_store(&mut store);
    store
}

pub(in crate::login) fn save_auth(store: &AuthStore) -> Result<()> {
    let _guard = AUTH_STORE_PROCESS_LOCK
        .lock()
        .expect("auth store process lock");
    let path = auth_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut persisted = store.clone();
    migrate_loaded_store(&mut persisted);
    let content = serde_json::to_string_pretty(&persisted)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("auth.json");
    let tmp_path = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp_path, &content)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp_path, perms)?;
    }

    #[cfg(windows)]
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }

    std::fs::rename(&tmp_path, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp_path);
    })?;

    Ok(())
}
