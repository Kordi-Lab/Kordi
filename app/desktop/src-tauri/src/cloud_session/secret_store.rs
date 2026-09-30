//! Secret storage for hosted account credentials.
//!
//! Release builds keep the Cloud session token and the installation's device
//! private key in the OS keychain only. Earlier releases kept these values in
//! plaintext files under `APP_DATA_DIR/kordi/cloud-secrets`; the first launch
//! of a release build moves those files into the keychain, deletes them, and
//! removes keychain items that the file-based releases had left behind (see
//! [`retire_legacy_secret_dir`]), so existing users stay signed in and nothing
//! older comes back.
//!
//! Debug builds (every `tauri dev` profile and multi-instance launcher) that set
//! `APP_DATA_DIR` use owner-only (0600) files inside that isolated development
//! data directory instead. This avoids a macOS keychain prompt every time the
//! unsigned development binary is rebuilt, while still keeping Cloud sessions
//! out of browser localStorage.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use super::{scoped_service, LEGACY_FILE_SECRETS};

pub(super) const DEV_FILE_SECRETS_DIR_NAME: &str = "cloud-secrets";
const SECRET_FILE_EXTENSION: &str = "secret";
/// Marks a secret whose plaintext file (or its absence) a release build has
/// already carried over to the keychain.
const MIGRATED_MARKER_EXTENSION: &str = "migrated";
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

/// Named development and preview identifiers (`io.kordi.cloud.<profile>`)
/// get their own keychain items, so a release build of an isolated profile
/// never reads the product app's session. The product identifier keeps the
/// original service names.
static KEYCHAIN_PROFILE_SCOPE: OnceLock<String> = OnceLock::new();

const ISOLATED_CLOUD_IDENTIFIER_PREFIX: &str = "io.kordi.cloud.";

pub(crate) fn configure_keychain_scope(app_identifier: &str) {
    if let Some(scope) = keychain_profile_scope(app_identifier) {
        let _ = KEYCHAIN_PROFILE_SCOPE.set(scope);
    }
}

fn keychain_profile_scope(app_identifier: &str) -> Option<String> {
    app_identifier
        .strip_prefix(ISOLATED_CLOUD_IDENTIFIER_PREFIX)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| format!("profile.{name}"))
}

fn keychain_service_name(service: &str, profile_scope: Option<&str>) -> String {
    let scoped = scoped_service(service);
    match profile_scope {
        Some(scope) => format!("{scoped}.{scope}"),
        None => scoped,
    }
}

fn entry_for(service: &str, account_id: &str) -> Result<Entry, String> {
    let service = keychain_service_name(service, KEYCHAIN_PROFILE_SCOPE.get().map(String::as_str));
    Entry::new(&service, account_id).map_err(|err| format!("keychain_unavailable: {err}"))
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

fn secret_file_stem(service: &str, account_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}:{account_id}", scoped_service(service)))
}

fn app_data_secret_file_path(service: &str, account_id: &str) -> Option<PathBuf> {
    let data_dir = std::env::var_os("APP_DATA_DIR")?;
    Some(
        PathBuf::from(data_dir)
            .join("kordi")
            .join(DEV_FILE_SECRETS_DIR_NAME)
            .join(format!(
                "{}.{SECRET_FILE_EXTENSION}",
                secret_file_stem(service, account_id)
            )),
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

fn migrated_marker_path(secret_file: &Path) -> PathBuf {
    secret_file.with_extension(MIGRATED_MARKER_EXTENSION)
}

/// Records that `secret_file`'s secret now lives in the keychain, so
/// [`retire_legacy_secret_dir`] never treats the keychain value as stale.
/// Does nothing when the legacy folder is already gone.
fn mark_legacy_secret_migrated(secret_file: &Path) -> std::io::Result<()> {
    if !secret_file.parent().is_some_and(Path::is_dir) {
        return Ok(());
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(migrated_marker_path(secret_file)).map(|_| ())
}

/// Moves one legacy secret into the keychain. The file is the newest copy
/// (the file-based releases always preferred it), so it replaces any keychain
/// value. Without a file, the keychain item predates the file-based releases
/// and survived their sign-outs and device resets, so it is removed.
fn migrate_legacy_secret(
    keychain: &dyn SecretKeychain,
    secret_file: &Path,
    service: &str,
    account_id: &str,
) -> Result<(), String> {
    match fs::read_to_string(secret_file) {
        Ok(value) => {
            keychain.set(service, account_id, &value)?;
            remove_file_if_present(secret_file)
                .map_err(|err| format!("file_secret_delete_failed: {err}"))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            keychain.delete(service, account_id)
        }
        Err(err) => Err(format!("file_secret_read_failed: {err}")),
    }
}

/// Retires the plaintext secret folder earlier releases used.
///
/// While the folder exists, the file-based releases stored every secret in it
/// and never in the keychain, so each secret is carried over by
/// [`migrate_legacy_secret`]. A marker records each secret that is done, so a
/// value stored in the keychain afterwards is never removed; secrets that
/// fail (for example when keychain access is denied) are retried on the next
/// launch, and their files keep the person signed in meanwhile. The folder is
/// deleted once every secret is done and nothing else is in it.
fn retire_legacy_secret_dir(keychain: &dyn SecretKeychain, dir: &Path, secrets: &[(&str, &str)]) {
    if !dir.is_dir() {
        return;
    }
    let mut markers = HashSet::new();
    let mut all_migrated = true;
    for (service, account_id) in secrets {
        let secret_file = dir.join(format!(
            "{}.{SECRET_FILE_EXTENSION}",
            secret_file_stem(service, account_id)
        ));
        let marker = migrated_marker_path(&secret_file);
        if !marker.exists() {
            let migrated = migrate_legacy_secret(keychain, &secret_file, service, account_id)
                .and_then(|()| {
                    mark_legacy_secret_migrated(&secret_file)
                        .map_err(|err| format!("file_secret_write_failed: {err}"))
                });
            if let Err(err) = migrated {
                eprintln!("[kordi] Cloud secret migration will be retried: {err}");
                all_migrated = false;
            }
        }
        markers.insert(marker);
    }
    if !all_migrated {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let entries: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    // Anything else (for example another instance's secrets) keeps the folder
    // and the markers in place.
    if entries.iter().all(|entry| markers.contains(entry)) {
        for entry in &entries {
            let _ = fs::remove_file(entry);
        }
        if let Err(err) = fs::remove_dir(dir) {
            eprintln!("[kordi] Unable to remove the legacy Cloud secret folder: {err}");
        }
    }
}

/// Runs [`retire_legacy_secret_dir`] at most once per process for the legacy
/// folder of `location`.
fn retire_legacy_secret_dir_once(keychain: &dyn SecretKeychain, location: &SecretLocation) {
    static ATTEMPTED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
    let SecretLocation::Keychain {
        legacy_file: Some(legacy_file),
    } = location
    else {
        return;
    };
    let Some(dir) = legacy_file.parent().filter(|dir| dir.is_dir()) else {
        return;
    };
    {
        let mut attempted = ATTEMPTED.lock().unwrap_or_else(|err| err.into_inner());
        if !attempted
            .get_or_insert_with(HashSet::new)
            .insert(dir.to_path_buf())
        {
            return;
        }
    }
    retire_legacy_secret_dir(keychain, dir, LEGACY_FILE_SECRETS);
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
                } else if let Err(err) = mark_legacy_secret_migrated(path) {
                    eprintln!("[kordi] Unable to record a Cloud secret migration: {err}");
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
            // A legacy file is still here only when moving it into the
            // keychain failed; its value keeps the person signed in until the
            // move succeeds on a later launch.
            if let Some(path) = legacy_file {
                match fs::read_to_string(path) {
                    Ok(value) => return Ok(Some(value)),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        eprintln!("[kordi] Unable to read a legacy plaintext Cloud secret: {err}");
                    }
                }
            }
            keychain.get(service, account_id)
        }
    }
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
            if let (Ok(()), Some(path)) = (&file_result, legacy_file) {
                if let Err(err) = mark_legacy_secret_migrated(path) {
                    eprintln!("[kordi] Unable to record a Cloud secret migration: {err}");
                }
            }
            file_result
        }
    }
}

pub(super) fn secret_store(service: &str, account_id: &str, value: &str) -> Result<(), String> {
    let location = current_secret_location(service, account_id);
    retire_legacy_secret_dir_once(&OsKeychain, &location);
    secret_store_at(&OsKeychain, &location, service, account_id, value)
}

pub(super) fn secret_load(service: &str, account_id: &str) -> Result<Option<String>, String> {
    let location = current_secret_location(service, account_id);
    retire_legacy_secret_dir_once(&OsKeychain, &location);
    secret_load_at(&OsKeychain, &location, service, account_id)
}

pub(super) fn secret_delete(service: &str, account_id: &str) -> Result<(), String> {
    let location = current_secret_location(service, account_id);
    retire_legacy_secret_dir_once(&OsKeychain, &location);
    secret_delete_at(&OsKeychain, &location, service, account_id)
}

#[cfg(test)]
#[path = "secret_store/tests.rs"]
mod tests;
