//! Secret storage for hosted account credentials.
//!
//! Release builds keep the Cloud session token and the installation's device
//! private key in the OS keychain only. Earlier releases could leave these
//! values in plaintext files under `APP_DATA_DIR`; the first load in a release
//! build moves such a file into the keychain and then deletes it, so existing
//! users stay signed in.
//!
//! Debug builds (every `tauri dev` profile and multi-instance launcher) that set
//! `APP_DATA_DIR` use owner-only (0600) files inside that isolated development
//! data directory instead. This avoids a macOS keychain prompt every time the
//! unsigned development binary is rebuilt, while still keeping Cloud sessions
//! out of browser localStorage.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use super::scoped_service;

pub(super) const DEV_FILE_SECRETS_DIR_NAME: &str = "cloud-secrets";
/// File-backed secrets are a development convenience and are compiled out of
/// the storage decision in release builds.
const DEV_FILE_SECRETS_ALLOWED: bool = cfg!(debug_assertions);

/// Minimal keychain surface so the release storage path (including the
/// plaintext-file migration) can be exercised in tests without touching the
/// developer's real keychain.
trait SecretKeychain {
    fn get(&self, service: &str, account_id: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account_id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str, account_id: &str) -> Result<(), String>;
}

struct OsKeychain;

fn entry_for(service: &str, account_id: &str) -> Result<Entry, String> {
    Entry::new(&scoped_service(service), account_id)
        .map_err(|err| format!("keychain_unavailable: {err}"))
}

impl SecretKeychain for OsKeychain {
    fn get(&self, service: &str, account_id: &str) -> Result<Option<String>, String> {
        match entry_for(service, account_id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(format!("keychain_read_failed: {err}")),
        }
    }

    fn set(&self, service: &str, account_id: &str, value: &str) -> Result<(), String> {
        entry_for(service, account_id)?
            .set_password(value)
            .map_err(|err| format!("keychain_write_failed: {err}"))
    }

    fn delete(&self, service: &str, account_id: &str) -> Result<(), String> {
        match entry_for(service, account_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("keychain_delete_failed: {err}")),
        }
    }
}

/// Where a secret lives for the current build and environment.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SecretLocation {
    /// Debug builds with an isolated `APP_DATA_DIR`: an owner-only file.
    DevFile(PathBuf),
    /// Release builds (and debug builds without `APP_DATA_DIR`): the OS
    /// keychain. `legacy_file` is the plaintext path earlier releases used, if
    /// any, so it can be migrated and removed.
    Keychain { legacy_file: Option<PathBuf> },
}

fn app_data_secret_file_path(service: &str, account_id: &str) -> Option<PathBuf> {
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

fn secret_location(service: &str, account_id: &str, dev_files_allowed: bool) -> SecretLocation {
    match app_data_secret_file_path(service, account_id) {
        Some(path) if dev_files_allowed => SecretLocation::DevFile(path),
        legacy_file => SecretLocation::Keychain { legacy_file },
    }
}

fn current_secret_location(service: &str, account_id: &str) -> SecretLocation {
    secret_location(service, account_id, DEV_FILE_SECRETS_ALLOWED)
}

fn write_owner_only_file(path: &Path, value: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // `mode` only applies when the file is created; tighten files left by
    // earlier development builds as well.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(value.as_bytes())?;
    file.sync_all()
}

fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

fn secret_store_at(
    keychain: &dyn SecretKeychain,
    location: &SecretLocation,
    service: &str,
    account_id: &str,
    value: &str,
) -> Result<(), String> {
    match location {
        SecretLocation::DevFile(path) => write_owner_only_file(path, value)
            .map_err(|err| format!("file_secret_write_failed: {err}")),
        SecretLocation::Keychain { legacy_file } => {
            keychain.set(service, account_id, value)?;
            // A plaintext copy from an earlier release must never shadow the
            // value that was just written to the keychain.
            if let Some(path) = legacy_file {
                if let Err(err) = remove_file_if_present(path) {
                    eprintln!("[kordi] Unable to remove a legacy plaintext Cloud secret: {err}");
                }
            }
            Ok(())
        }
    }
}

fn secret_load_at(
    keychain: &dyn SecretKeychain,
    location: &SecretLocation,
    service: &str,
    account_id: &str,
) -> Result<Option<String>, String> {
    match location {
        SecretLocation::DevFile(path) => match fs::read_to_string(path) {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("file_secret_read_failed: {err}")),
        },
        SecretLocation::Keychain { legacy_file } => {
            if let Some(path) = legacy_file {
                if let Some(value) = migrate_legacy_secret_file(keychain, path, service, account_id)
                {
                    return Ok(Some(value));
                }
            }
            keychain.get(service, account_id)
        }
    }
}

/// Moves a plaintext secret written by an earlier release into the keychain.
/// The file is the newest copy (earlier releases always preferred it), so it
/// replaces any keychain value. If the keychain write fails, the file is kept
/// and its value is still returned so the user is not signed out; the move is
/// retried on the next load.
fn migrate_legacy_secret_file(
    keychain: &dyn SecretKeychain,
    path: &Path,
    service: &str,
    account_id: &str,
) -> Option<String> {
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            eprintln!("[kordi] Unable to read a legacy plaintext Cloud secret: {err}");
            return None;
        }
    };
    match keychain.set(service, account_id, &value) {
        Ok(()) => {
            if let Err(err) = remove_file_if_present(path) {
                eprintln!("[kordi] Unable to remove a migrated plaintext Cloud secret: {err}");
            }
        }
        Err(err) => {
            eprintln!(
                "[kordi] Keeping a plaintext Cloud secret until the keychain is available: {err}"
            );
        }
    }
    Some(value)
}

fn secret_delete_at(
    keychain: &dyn SecretKeychain,
    location: &SecretLocation,
    service: &str,
    account_id: &str,
) -> Result<(), String> {
    match location {
        SecretLocation::DevFile(path) => {
            remove_file_if_present(path).map_err(|err| format!("file_secret_delete_failed: {err}"))
        }
        SecretLocation::Keychain { legacy_file } => {
            let file_result = legacy_file.as_deref().map_or(Ok(()), |path| {
                remove_file_if_present(path)
                    .map_err(|err| format!("file_secret_delete_failed: {err}"))
            });
            keychain.delete(service, account_id)?;
            file_result
        }
    }
}

pub(super) fn secret_store(service: &str, account_id: &str, value: &str) -> Result<(), String> {
    let location = current_secret_location(service, account_id);
    secret_store_at(&OsKeychain, &location, service, account_id, value)
}

pub(super) fn secret_load(service: &str, account_id: &str) -> Result<Option<String>, String> {
    let location = current_secret_location(service, account_id);
    secret_load_at(&OsKeychain, &location, service, account_id)
}

pub(super) fn secret_delete(service: &str, account_id: &str) -> Result<(), String> {
    let location = current_secret_location(service, account_id);
    secret_delete_at(&OsKeychain, &location, service, account_id)
}

#[cfg(test)]
mod tests {
    use super::super::tests::with_isolated_app_data_dir;
    use super::super::{DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME};
    use super::*;

    #[derive(Default)]
    struct MemoryKeychain {
        values: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
        fail_writes: bool,
    }

    impl MemoryKeychain {
        fn value(&self, service: &str, account_id: &str) -> Option<String> {
            self.values
                .lock()
                .unwrap()
                .get(&(service.to_string(), account_id.to_string()))
                .cloned()
        }
    }

    impl SecretKeychain for MemoryKeychain {
        fn get(&self, service: &str, account_id: &str) -> Result<Option<String>, String> {
            Ok(self.value(service, account_id))
        }

        fn set(&self, service: &str, account_id: &str, value: &str) -> Result<(), String> {
            if self.fail_writes {
                return Err("keychain_write_failed: locked".to_string());
            }
            self.values.lock().unwrap().insert(
                (service.to_string(), account_id.to_string()),
                value.to_string(),
            );
            Ok(())
        }

        fn delete(&self, service: &str, account_id: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .remove(&(service.to_string(), account_id.to_string()));
            Ok(())
        }
    }

    fn write_legacy_plaintext_secret(path: &Path, value: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn legacy_file_of(location: &SecretLocation) -> &Path {
        match location {
            SecretLocation::Keychain {
                legacy_file: Some(legacy_file),
            } => legacy_file,
            other => panic!("expected a keychain location with a legacy file: {other:?}"),
        }
    }

    #[test]
    fn release_builds_select_the_keychain_even_when_app_data_dir_is_set() {
        with_isolated_app_data_dir(|dir| {
            let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
            let legacy_file = legacy_file_of(&location);
            assert!(legacy_file.starts_with(dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME)));

            assert!(matches!(
                secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, true),
                SecretLocation::DevFile(_)
            ));
        });
    }

    #[test]
    fn release_store_writes_only_to_the_keychain() {
        with_isolated_app_data_dir(|dir| {
            let keychain = MemoryKeychain::default();
            let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);

            secret_store_at(
                &keychain,
                &location,
                KEYCHAIN_SERVICE,
                KEYCHAIN_USERNAME,
                "session-json",
            )
            .unwrap();

            assert_eq!(
                keychain
                    .value(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                    .as_deref(),
                Some("session-json")
            );
            assert!(!dir.join("kordi").join(DEV_FILE_SECRETS_DIR_NAME).exists());
        });
    }

    #[test]
    fn release_load_moves_a_legacy_plaintext_secret_into_the_keychain() {
        with_isolated_app_data_dir(|_| {
            let keychain = MemoryKeychain::default();
            keychain
                .set(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, "older-keychain-value")
                .unwrap();
            let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
            let legacy_file = legacy_file_of(&location);
            write_legacy_plaintext_secret(legacy_file, "file-session-json");

            let loaded =
                secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();

            assert_eq!(loaded.as_deref(), Some("file-session-json"));
            assert_eq!(
                keychain
                    .value(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                    .as_deref(),
                Some("file-session-json")
            );
            assert!(!legacy_file.exists(), "plaintext secret must be removed");

            let reloaded =
                secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();
            assert_eq!(reloaded.as_deref(), Some("file-session-json"));
        });
    }

    #[test]
    fn release_load_keeps_the_plaintext_secret_when_the_keychain_is_unavailable() {
        with_isolated_app_data_dir(|_| {
            let keychain = MemoryKeychain {
                fail_writes: true,
                ..MemoryKeychain::default()
            };
            let location =
                secret_location(DEVICE_IDENTITY_KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
            let legacy_file = legacy_file_of(&location);
            write_legacy_plaintext_secret(legacy_file, "device-identity-json");

            let loaded = secret_load_at(
                &keychain,
                &location,
                DEVICE_IDENTITY_KEYCHAIN_SERVICE,
                KEYCHAIN_USERNAME,
            )
            .unwrap();

            assert_eq!(loaded.as_deref(), Some("device-identity-json"));
            assert!(legacy_file.exists(), "the only copy must not be deleted");
        });
    }

    #[test]
    fn release_store_and_delete_remove_legacy_plaintext_secrets() {
        with_isolated_app_data_dir(|_| {
            let keychain = MemoryKeychain::default();
            let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, false);
            let legacy_file = legacy_file_of(&location);

            write_legacy_plaintext_secret(legacy_file, "stale");
            secret_store_at(
                &keychain,
                &location,
                KEYCHAIN_SERVICE,
                KEYCHAIN_USERNAME,
                "fresh",
            )
            .unwrap();
            assert!(!legacy_file.exists());
            assert_eq!(
                secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)
                    .unwrap()
                    .as_deref(),
                Some("fresh")
            );

            write_legacy_plaintext_secret(legacy_file, "stale");
            secret_delete_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap();
            assert!(!legacy_file.exists());
            assert_eq!(
                secret_load_at(&keychain, &location, KEYCHAIN_SERVICE, KEYCHAIN_USERNAME).unwrap(),
                None
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn development_secret_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        with_isolated_app_data_dir(|_| {
            let location = secret_location(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME, true);
            let SecretLocation::DevFile(path) = &location else {
                panic!("expected development file location");
            };
            // A file left by an earlier development build with default permissions.
            write_legacy_plaintext_secret(path, "old");
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();

            secret_store_at(
                &MemoryKeychain::default(),
                &location,
                KEYCHAIN_SERVICE,
                KEYCHAIN_USERNAME,
                "session-json",
            )
            .unwrap();

            let file_mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
            assert_eq!(fs::read_to_string(path).unwrap(), "session-json");
        });
    }
}
