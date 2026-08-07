use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const SHARED_ACCOUNT_AUTH_ROOT_ENV: &str = "KORDI_SHARED_ACCOUNT_AUTH_ROOT";
const SHARED_ACCOUNT_AUTH_DIRNAME: &str = "io.kordi.shared";

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
    Ok(app_data_root()?
        .join("accounts")
        .join(account_dir_name(account_id)))
}

fn shared_account_auth_root() -> Result<PathBuf, String> {
    if let Some(root) =
        std::env::var_os(SHARED_ACCOUNT_AUTH_ROOT_ENV).filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(root));
    }
    let app_data_dir = app_data_root()?;
    let app_data_parent = app_data_dir
        .parent()
        .ok_or_else(|| "shared_account_auth_parent_unavailable".to_string())?;
    Ok(app_data_parent
        .join(SHARED_ACCOUNT_AUTH_DIRNAME)
        .join("account-auth"))
}

fn shared_account_auth_path(account_id: &str) -> Result<PathBuf, String> {
    Ok(shared_account_auth_root()?
        .join(account_dir_name(account_id))
        .join("auth.json"))
}

fn is_cloud_app_data_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name == "io.kordi.cloud" || name.starts_with("io.kordi.cloud."))
}

fn legacy_account_auth_candidates(account_id: &str) -> Result<Vec<PathBuf>, String> {
    let account_dir = account_dir_name(account_id);
    let app_data_dir = app_data_root()?;
    let mut candidates = vec![app_data_dir
        .join("accounts")
        .join(&account_dir)
        .join("auth.json")];
    if let Some(parent) = app_data_dir.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            candidates.extend(entries.flatten().filter_map(|entry| {
                let path = entry.path();
                (path != app_data_dir && path.is_dir() && is_cloud_app_data_dir(&path))
                    .then(|| path.join("accounts").join(&account_dir).join("auth.json"))
            }));
        }
    }
    candidates.retain(|path| path.is_file());
    candidates.sort_by(|left, right| {
        let modified = |path: &PathBuf| fs::metadata(path).and_then(|value| value.modified()).ok();
        modified(right).cmp(&modified(left))
    });
    candidates.dedup();
    Ok(candidates)
}

fn migrate_shared_account_auth_if_needed(
    account_id: &str,
    destination: &Path,
) -> Result<(), String> {
    if destination.is_file() {
        return Ok(());
    }
    let Some(source) = legacy_account_auth_candidates(account_id)?
        .into_iter()
        .next()
    else {
        return Ok(());
    };
    let contents =
        fs::read(&source).map_err(|err| format!("shared_account_auth_read_failed: {err}"))?;
    let valid_object = serde_json::from_slice::<serde_json::Value>(&contents)
        .ok()
        .is_some_and(|value| value.is_object());
    if !valid_object {
        return Err("shared_account_auth_source_invalid".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "shared_account_auth_parent_unavailable".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("shared_account_auth_create_failed: {err}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(destination) {
        Ok(mut file) => {
            if let Err(err) = file.write_all(&contents) {
                drop(file);
                let _ = fs::remove_file(destination);
                return Err(format!("shared_account_auth_write_failed: {err}"));
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(format!("shared_account_auth_write_failed: {err}")),
    }
    Ok(())
}

#[tauri::command]
pub fn cloud_account_storage_root(account_id: String) -> Result<String, String> {
    let account_id = normalize_account_id(&account_id)?;
    let root = account_storage_parent(&account_id)?.join("kordi");
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cloud_account_storage_activate(
    account_id: String,
) -> Result<CloudAccountStorageActivation, String> {
    let account_id = normalize_account_id(&account_id)?;
    let parent = account_storage_parent(&account_id)?;
    let storage_root = parent.join("kordi");
    std::fs::create_dir_all(&storage_root)
        .map_err(|err| format!("cloud_account_storage_create_failed: {err}"))?;
    let auth_path = shared_account_auth_path(&account_id)?;
    migrate_shared_account_auth_if_needed(&account_id, &auth_path)?;

    let current = active_storage()
        .lock()
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())?
        .clone();
    let requires_reload = current
        .as_ref()
        .is_some_and(|active| active.account_id != account_id);
    let activation = CloudAccountStorageActivation {
        account_id,
        storage_root: storage_root.to_string_lossy().to_string(),
        requires_reload,
    };
    unsafe { std::env::set_var("KORDI_STORAGE_ROOT", parent) };
    unsafe { std::env::set_var("KORDI_AUTH_PATH", auth_path) };
    *active_storage()
        .lock()
        .map_err(|_| "cloud_account_storage_lock_failed".to_string())? = Some(activation.clone());
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

    fn with_app_data_dir<T>(test: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::lock_process_environment();
        let previous_app_data_dir = std::env::var_os("APP_DATA_DIR");
        let previous_storage_root = std::env::var_os("KORDI_STORAGE_ROOT");
        let previous_auth_path = std::env::var_os("KORDI_AUTH_PATH");
        let previous_shared_auth_root = std::env::var_os(SHARED_ACCOUNT_AUTH_ROOT_ENV);
        let base_dir = std::env::temp_dir().join(format!(
            "kordi-cloud-account-paths-test-{}",
            uuid::Uuid::new_v4()
        ));
        let dir = base_dir.join("io.kordi.cloud.test");
        let shared_auth_root = base_dir
            .join(SHARED_ACCOUNT_AUTH_DIRNAME)
            .join("account-auth");

        std::env::set_var("APP_DATA_DIR", &dir);
        std::env::set_var(SHARED_ACCOUNT_AUTH_ROOT_ENV, &shared_auth_root);
        std::env::remove_var("KORDI_STORAGE_ROOT");
        std::env::remove_var("KORDI_AUTH_PATH");
        *active_storage().lock().expect("active storage lock") = None;
        let output = test(dir.clone());
        let _ = std::fs::remove_dir_all(&base_dir);
        match previous_app_data_dir {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
        match previous_storage_root {
            Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
            None => std::env::remove_var("KORDI_STORAGE_ROOT"),
        }
        match previous_auth_path {
            Some(value) => std::env::set_var("KORDI_AUTH_PATH", value),
            None => std::env::remove_var("KORDI_AUTH_PATH"),
        }
        match previous_shared_auth_root {
            Some(value) => std::env::set_var(SHARED_ACCOUNT_AUTH_ROOT_ENV, value),
            None => std::env::remove_var(SHARED_ACCOUNT_AUTH_ROOT_ENV),
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
            assert_eq!(
                cloud_account_storage_root("".to_string()).unwrap_err(),
                "invalid_account_id"
            );
            assert_eq!(
                cloud_account_storage_root("human_123".to_string()).unwrap_err(),
                "invalid_account_id"
            );
        });
    }

    #[test]
    fn activation_sets_current_storage_root() {
        with_app_data_dir(|dir| {
            let activation = cloud_account_storage_activate("acct_alpha".to_string()).unwrap();
            let current = cloud_account_storage_current()
                .unwrap()
                .expect("active storage");

            assert_eq!(activation.account_id, "acct_alpha");
            assert_eq!(activation.storage_root, current.storage_root);
            let env_root = PathBuf::from(std::env::var("KORDI_STORAGE_ROOT").unwrap());
            assert_eq!(
                env_root.join("kordi"),
                PathBuf::from(&activation.storage_root)
            );
            assert_eq!(
                PathBuf::from(std::env::var("KORDI_AUTH_PATH").unwrap()),
                shared_account_auth_path("acct_alpha").unwrap()
            );
            assert!(PathBuf::from(&activation.storage_root).starts_with(dir.join("accounts")));
            assert!(!activation.requires_reload);
        });
    }

    #[test]
    fn switching_accounts_requires_reload_boundary() {
        with_app_data_dir(|_| {
            let first = cloud_account_storage_activate("acct_alpha".to_string()).unwrap();
            let second = cloud_account_storage_activate("acct_beta".to_string()).unwrap();
            let third = cloud_account_storage_activate("acct_beta".to_string()).unwrap();

            assert!(!first.requires_reload);
            assert!(second.requires_reload);
            assert!(!third.requires_reload);
        });
    }

    #[test]
    fn activation_migrates_auth_from_another_cloud_instance() {
        with_app_data_dir(|dir| {
            let account_id = "acct_alpha";
            let sibling_auth = dir
                .parent()
                .unwrap()
                .join("io.kordi.cloud.other-preview")
                .join("accounts")
                .join(account_dir_name(account_id))
                .join("auth.json");
            std::fs::create_dir_all(sibling_auth.parent().unwrap()).unwrap();
            std::fs::write(
                &sibling_auth,
                r#"{"version":4,"profiles":{"anthropic":[]}}"#,
            )
            .unwrap();

            cloud_account_storage_activate(account_id.to_string()).unwrap();

            let shared_auth = shared_account_auth_path(account_id).unwrap();
            assert_eq!(
                std::fs::read_to_string(shared_auth).unwrap(),
                r#"{"version":4,"profiles":{"anthropic":[]}}"#
            );
        });
    }

    #[test]
    fn different_accounts_use_different_shared_auth_files() {
        with_app_data_dir(|_| {
            assert_ne!(
                shared_account_auth_path("acct_alpha").unwrap(),
                shared_account_auth_path("acct_beta").unwrap()
            );
        });
    }
}
