use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountStorageActivation {
    pub account_id: String,
    pub storage_root: String,
    pub requires_reload: bool,
}

fn active_storage() -> &'static Mutex<Option<CloudAccountStorageActivation>> {
    static ACTIVE: OnceLock<Mutex<Option<CloudAccountStorageActivation>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn normalize_account_id(account_id: &str) -> Result<String, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() || !trimmed.starts_with("acct_") {
        return Err("invalid_account_id".to_string());
    }
    Ok(trimmed.to_string())
}

fn account_dir_name(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let hash = hasher.finalize();
    hash[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn app_data_root() -> Result<PathBuf, String> {
    std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "app_data_dir_unavailable".to_string())
}

fn account_storage_parent(account_id: &str) -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("accounts").join(account_dir_name(account_id)))
}

#[tauri::command]
pub fn cloud_account_storage_root(account_id: String) -> Result<String, String> {
    let account_id = normalize_account_id(&account_id)?;
    let root = account_storage_parent(&account_id)?.join("kordi");
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cloud_account_storage_activate(account_id: String) -> Result<CloudAccountStorageActivation, String> {
    let account_id = normalize_account_id(&account_id)?;
    let parent = account_storage_parent(&account_id)?;
    let storage_root = parent.join("kordi");
    std::fs::create_dir_all(&storage_root)
        .map_err(|err| format!("cloud_account_storage_create_failed: {err}"))?;

    let activation = CloudAccountStorageActivation {
        account_id,
        storage_root: storage_root.to_string_lossy().to_string(),
        requires_reload: true,
    };
    unsafe { std::env::set_var("KORDI_STORAGE_ROOT", parent) };
    *active_storage().lock().map_err(|_| "cloud_account_storage_lock_failed".to_string())? =
        Some(activation.clone());
    Ok(activation)
}

#[tauri::command]
pub fn cloud_account_storage_current() -> Result<Option<CloudAccountStorageActivation>, String> {
    active_storage()
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_app_data_dir<T>(test: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let previous_app_data_dir = std::env::var_os("APP_DATA_DIR");
        let previous_storage_root = std::env::var_os("KORDI_STORAGE_ROOT");
        let dir = std::env::temp_dir().join(format!("kordi-cloud-account-paths-test-{}", uuid::Uuid::new_v4()));

        std::env::set_var("APP_DATA_DIR", &dir);
        std::env::remove_var("KORDI_STORAGE_ROOT");
        *active_storage().lock().expect("active storage lock") = None;
        let output = test(dir.clone());
        let _ = std::fs::remove_dir_all(&dir);
        match previous_app_data_dir {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
        match previous_storage_root {
            Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
            None => std::env::remove_var("KORDI_STORAGE_ROOT"),
        }
        *active_storage().lock().expect("active storage lock") = None;
        output
    }

    #[test]
    fn same_account_resolves_to_same_stable_root() {
        with_app_data_dir(|dir| {
            let first = cloud_account_storage_root("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_root(" acct_alpha ".to_string()).unwrap();

            assert_eq!(first, second);
            assert!(PathBuf::from(&first).starts_with(dir.join("accounts")));
            assert!(first.ends_with("/kordi") || first.ends_with("\\kordi"));
        });
    }

    #[test]
    fn different_accounts_resolve_to_different_roots() {
        with_app_data_dir(|_| {
            let first = cloud_account_storage_root("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_root("acct_beta".to_string()).unwrap();

            assert_ne!(first, second);
        });
    }

    #[test]
    fn invalid_account_ids_are_rejected() {
        with_app_data_dir(|_| {
            assert_eq!(cloud_account_storage_root("".to_string()).unwrap_err(), "invalid_account_id");
            assert_eq!(cloud_account_storage_root("human_123".to_string()).unwrap_err(), "invalid_account_id");
        });
    }

    #[test]
    fn activation_sets_current_storage_root() {
        with_app_data_dir(|dir| {
            let activation = cloud_account_storage_activate("acct_alpha".to_string()).unwrap();
            let current = cloud_account_storage_current().unwrap().expect("active storage");

            assert_eq!(activation.account_id, "acct_alpha");
            assert_eq!(activation.storage_root, current.storage_root);
            let env_root = PathBuf::from(std::env::var("KORDI_STORAGE_ROOT").unwrap());
            assert_eq!(env_root.join("kordi"), PathBuf::from(&activation.storage_root));
            assert!(PathBuf::from(&activation.storage_root).starts_with(dir.join("accounts")));
            assert!(activation.requires_reload);
        });
    }
}
