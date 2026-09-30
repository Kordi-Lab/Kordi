//! Decides which local files the attachment commands may read, copy, upload,
//! or open.
//!
//! A file is usable when it is inside Kordi's own attachment storage (files
//! Kordi wrote, including the received-attachment cache), or when native code
//! registered it:
//!
//! - the person chose it in the native file picker,
//! - it was pasted and native code found it among the file URLs on the system
//!   pasteboard,
//! - Kordi itself recorded or saved it (voice messages, saved copies),
//! - an earlier version of Kordi on this device sent it in a local agent
//!   session (registered once, so older transcripts keep working), or
//! - the person picked it from the `@` file reference menu.
//!
//! The `@` file reference registration is still requested by the desktop UI
//! alone. Until it gets its own native confirmation, credential, keychain,
//! browser profile, and shell history locations are refused for it (and for
//! pastes). That list is a stopgap, not a complete boundary. Paths that only
//! appear in message data are never enough on their own.
//!
//! Registrations are kept in a small owner-only file inside the attachment
//! storage directory so drafts, resumable uploads, and sent attachments keep
//! working after a restart.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::attachment_storage_dir;

const REGISTRY_FILE_NAME: &str = "attachment-access.json";
/// Lists the local session databases whose sent attachments were registered.
const HISTORY_SEED_FILE_NAME: &str = "attachment-access-history.json";
const MAX_REGISTERED_PATHS: usize = 4096;

/// Returned when a path is outside Kordi's attachment storage and was never
/// attached, recorded, or saved through Kordi. The desktop UI matches this
/// prefix to fall back to the Cloud copy of an attachment.
pub(crate) const ATTACHMENT_ACCESS_DENIED: &str =
    "Kordi can no longer use this file from its original location. Use Show in Finder to open it, or attach it again.";

pub(crate) const PROTECTED_LOCATION_MESSAGE: &str =
    "Kordi does not attach files from credential, keychain, browser profile, or shell history locations. Use Choose Files to attach this file.";

pub(crate) const PROTECTED_PREVIEW_MESSAGE: &str =
    "Kordi does not show files from credential, keychain, browser profile, or shell history locations.";

/// Home-relative locations that hold credentials, browser profiles, or shell
/// history. Requests that only name a path (pastes, `@` references, artifact
/// previews) cannot use them; the native file picker still can.
const PROTECTED_HOME_LOCATIONS: &[&str] = &[
    // SSH, GPG, and cloud or cluster credentials
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".oci",
    ".config/gcloud",
    ".config/gh",
    ".config/hub",
    ".config/op",
    ".config/git/credentials",
    ".terraform.d/credentials.tfrc.json",
    ".vault-token",
    ".password-store",
    ".local/share/keyrings",
    // Package registry and tool tokens
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".gem/credentials",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".codex/auth.json",
    ".claude/.credentials.json",
    // Shell and REPL history
    ".bash_history",
    ".zsh_history",
    ".zsh_sessions",
    ".history",
    ".python_history",
    ".node_repl_history",
    ".psql_history",
    ".mysql_history",
    ".sqlite_history",
    // Keychains, cookies, and browser profiles
    "Library/Keychains",
    "Library/Cookies",
    "Library/Safari",
    "Library/Containers/com.apple.Safari",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Chromium",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Application Support/Vivaldi",
    "Library/Application Support/com.operasoftware.Opera",
    "Library/Application Support/Firefox",
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
];

#[derive(Default)]
struct Registry {
    file: PathBuf,
    order: Vec<PathBuf>,
    paths: HashSet<PathBuf>,
    seeded_histories: HashSet<PathBuf>,
}

fn read_path_list(file: &Path) -> Vec<PathBuf> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<PathBuf>>(&bytes).ok())
        .unwrap_or_default()
}

fn write_owner_only_json(file: &Path, value: &impl serde::Serialize) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options
        .open(&temporary)
        .and_then(|mut handle| handle.write_all(&bytes).and_then(|_| handle.sync_all()))
        .and_then(|_| std::fs::rename(&temporary, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

impl Registry {
    fn load(file: PathBuf) -> Self {
        let order = read_path_list(&file);
        let paths = order.iter().cloned().collect();
        let seeded_histories = read_path_list(&file.with_file_name(HISTORY_SEED_FILE_NAME))
            .into_iter()
            .collect();
        Self {
            file,
            order,
            paths,
            seeded_histories,
        }
    }

    fn insert(&mut self, path: PathBuf) -> bool {
        if self.paths.contains(&path) {
            return false;
        }
        self.paths.insert(path.clone());
        self.order.push(path);
        while self.order.len() > MAX_REGISTERED_PATHS {
            let oldest = self.order.remove(0);
            self.paths.remove(&oldest);
        }
        true
    }

    fn persist(&self) -> Result<(), String> {
        write_owner_only_json(&self.file, &self.order)
            .map_err(|error| format!("Unable to remember attachment access: {error}"))
    }

    fn persist_seeded_histories(&self) -> Result<(), String> {
        let mut seeded: Vec<&PathBuf> = self.seeded_histories.iter().collect();
        seeded.sort();
        write_owner_only_json(&self.file.with_file_name(HISTORY_SEED_FILE_NAME), &seeded)
            .map_err(|error| format!("Unable to remember earlier attachments: {error}"))
    }
}

fn registry() -> &'static Mutex<Option<Registry>> {
    static REGISTRY: OnceLock<Mutex<Option<Registry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(None))
}

/// Runs `action` against the registry for the current attachment storage
/// directory, reloading it when the storage directory changed.
fn with_registry<T>(action: impl FnOnce(&mut Registry) -> T) -> Result<T, String> {
    let file = storage_root()?.join(REGISTRY_FILE_NAME);
    let mut guard = registry()
        .lock()
        .map_err(|_| "Attachment access state is unavailable.".to_string())?;
    if guard.as_ref().is_none_or(|current| current.file != file) {
        *guard = Some(Registry::load(file));
    }
    Ok(action(guard.as_mut().expect("registry loaded")))
}

fn storage_root() -> Result<PathBuf, String> {
    std::fs::canonicalize(attachment_storage_dir()?).map_err(|error| error.to_string())
}

fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to read attachment {}: {error}", path.display()))
}

fn canonical_file(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to read attachment file {}: {error}", path.display()))?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        format!(
            "Unable to read attachment metadata {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("Attachment is not a file: {}", path.display()));
    }
    Ok(canonical)
}

/// True when `path` (already canonical) is inside Kordi's attachment storage.
pub(crate) fn is_in_attachment_storage(path: &Path) -> bool {
    storage_root().is_ok_and(|root| path.starts_with(root))
}

/// Identifies a file or folder independently of how its path is spelled.
/// On macOS, firmlinks give one folder two canonical spellings (for example
/// `/Users/<name>` and `/System/Volumes/Data/Users/<name>`), so comparing
/// path prefixes is not enough.
#[cfg(unix)]
type LocationKey = (u64, u64);
#[cfg(not(unix))]
type LocationKey = PathBuf;

#[cfg(unix)]
fn location_key(path: &Path) -> Option<LocationKey> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn location_key(path: &Path) -> Option<LocationKey> {
    std::fs::canonicalize(path).ok()
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn protected_location_keys() -> HashSet<LocationKey> {
    let mut locations: Vec<PathBuf> = Vec::new();
    if let Some(home) = env_path("HOME") {
        locations.extend(
            PROTECTED_HOME_LOCATIONS
                .iter()
                .map(|location| home.join(location)),
        );
    }
    if let Some(app_data) = env_path("APP_DATA_DIR") {
        locations.push(app_data.join("kordi").join("cloud-secrets"));
    }
    locations.extend(env_path("KORDI_AUTH_PATH"));
    locations
        .iter()
        .filter_map(|path| location_key(path))
        .collect()
}

/// Kordi storage roots whose `auth.json` files hold provider credentials.
fn credential_storage_root_keys() -> HashSet<LocationKey> {
    [
        env_path("APP_DATA_DIR"),
        env_path("KORDI_STORAGE_ROOT"),
        env_path("HOME").map(|home| home.join(".kordi")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path| location_key(&path))
    .collect()
}

/// True when `path` is, or is inside, a credential, keychain, browser
/// profile, or shell history location. Locations are compared by file
/// identity, so every spelling of the same folder matches.
pub(crate) fn is_protected_location(path: &Path) -> bool {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    let protected = protected_location_keys();
    let storage_roots = credential_storage_root_keys();
    let is_auth_file = canonical
        .file_name()
        .is_some_and(|name| name == "auth.json");
    canonical.ancestors().any(|ancestor| {
        location_key(ancestor).is_some_and(|key| {
            protected.contains(&key) || (is_auth_file && storage_roots.contains(&key))
        })
    })
}

/// Refuses artifact previews and folder listings of protected locations.
pub(crate) fn ensure_previewable_location(path: &Path) -> Result<(), String> {
    if is_protected_location(path) {
        return Err(PROTECTED_PREVIEW_MESSAGE.to_string());
    }
    Ok(())
}

fn register_canonical(paths: Vec<PathBuf>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    with_registry(|registry| {
        let mut changed = false;
        for path in paths {
            changed |= registry.insert(path);
        }
        // The in-memory registration already applies to this session; a
        // failed write only means it will not survive a restart.
        if changed {
            if let Err(error) = registry.persist() {
                eprintln!("[kordi] {error}");
            }
        }
    })
}

/// Registers files the person chose in a native dialog. The dialog is the
/// person's explicit choice, so protected locations are accepted here.
pub(crate) fn register_native_selection<P: AsRef<Path>>(paths: &[P]) -> Result<(), String> {
    let canonical = paths
        .iter()
        .filter_map(|path| std::fs::canonicalize(path.as_ref()).ok())
        .collect();
    register_canonical(canonical)
}

/// Registers a file the person picked from the `@` file reference menu and
/// returns its canonical path.
///
/// This is the one registration the desktop UI can still request on its own,
/// so protected locations are refused.
pub(crate) fn register_referenced_attachment(path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_path(path)?;
    if is_usable(&canonical)? {
        return Ok(canonical);
    }
    if is_protected_location(&canonical) {
        return Err(PROTECTED_LOCATION_MESSAGE.to_string());
    }
    register_canonical(vec![canonical.clone()])?;
    Ok(canonical)
}

/// Authorizes a path the desktop UI asked to attach after a paste and
/// returns its canonical path. Unless the path is already usable, it must be
/// one of `pasteboard_paths`, the file URLs native code just read from the
/// system pasteboard.
pub(crate) fn authorize_pasted_attachment(
    path: &Path,
    pasteboard_paths: &[PathBuf],
) -> Result<PathBuf, String> {
    let canonical = canonical_path(path)?;
    if is_usable(&canonical)? {
        return Ok(canonical);
    }
    if is_protected_location(&canonical) {
        return Err(PROTECTED_LOCATION_MESSAGE.to_string());
    }
    let on_pasteboard = pasteboard_paths
        .iter()
        .filter_map(|pasted| std::fs::canonicalize(pasted).ok())
        .any(|pasted| pasted == canonical);
    if !on_pasteboard {
        return Err(ATTACHMENT_ACCESS_DENIED.to_string());
    }
    register_canonical(vec![canonical.clone()])?;
    Ok(canonical)
}

/// Registers a file Kordi itself just wrote outside attachment storage, such
/// as a voice recording or a saved copy.
pub(crate) fn register_created_file(path: &Path) -> Result<(), String> {
    register_native_selection(&[path])
}

fn is_registered(canonical: &Path) -> Result<bool, String> {
    with_registry(|registry| registry.paths.contains(canonical))
}

fn is_usable(canonical: &Path) -> Result<bool, String> {
    if is_in_attachment_storage(canonical) || is_registered(canonical)? {
        return Ok(true);
    }
    if seed_from_local_history()? {
        return is_registered(canonical);
    }
    Ok(false)
}

/// Resolves `path` to a canonical regular file that attachment commands may
/// use, or explains why it cannot be used.
pub(crate) fn authorize_attachment_file(path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_file(path)?;
    if is_usable(&canonical)? {
        return Ok(canonical);
    }
    Err(ATTACHMENT_ACCESS_DENIED.to_string())
}

/// Like [`authorize_attachment_file`], but also accepts registered folders.
pub(crate) fn authorize_attachment_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_path(path)?;
    if is_usable(&canonical)? {
        return Ok(canonical);
    }
    Err(ATTACHMENT_ACCESS_DENIED.to_string())
}

const ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";

/// Local paths of the attachments this device sent in local agent sessions,
/// read from the session database's attachment context entries.
fn recorded_attachment_paths(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT payload FROM entries \
             WHERE type = 'custom_message' AND instr(payload, ?1) > 0",
        )
        .map_err(|error| error.to_string())?;
    let payloads = statement
        .query_map([ATTACHMENT_CONTEXT_CUSTOM_TYPE], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for payload in payloads.flatten() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        if entry["custom_type"] != ATTACHMENT_CONTEXT_CUSTOM_TYPE {
            continue;
        }
        let Some(attachments) = entry["details"]["attachments"].as_array() else {
            continue;
        };
        paths.extend(
            attachments
                .iter()
                .filter_map(|attachment| attachment["localPath"].as_str())
                .filter(|path| !path.trim().is_empty())
                .map(str::to_string),
        );
    }
    Ok(paths)
}

fn read_recorded_attachment_paths(database: &Path) -> Result<Vec<String>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    recorded_attachment_paths(&conn)
}

/// The local session database for the active Kordi storage root.
#[cfg(not(test))]
fn local_session_database() -> Option<PathBuf> {
    let settings = kordi_core::settings::Settings::load_global();
    let database = kordi_core::config::session_db_path(&settings.storage);
    database.is_file().then_some(database)
}

#[cfg(test)]
static TEST_SESSION_DATABASE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
fn local_session_database() -> Option<PathBuf> {
    TEST_SESSION_DATABASE
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// Registers, once per local session database, the attachments this device
/// sent in local agent sessions before access tracking existed, so actions on
/// older transcripts keep working. Returns true when that added anything.
fn seed_from_local_history() -> Result<bool, String> {
    let Some(database) = local_session_database() else {
        return Ok(false);
    };
    if with_registry(|registry| registry.seeded_histories.contains(&database))? {
        return Ok(false);
    }
    let recorded = read_recorded_attachment_paths(&database).unwrap_or_else(|error| {
        eprintln!("[kordi] Unable to read earlier attachments: {error}");
        Vec::new()
    });
    let usable: Vec<PathBuf> = recorded
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| !is_protected_location(path))
        .collect();
    with_registry(|registry| {
        if !registry.seeded_histories.insert(database) {
            return false;
        }
        let mut changed = false;
        for path in usable {
            changed |= registry.insert(path);
        }
        if changed {
            if let Err(error) = registry.persist() {
                eprintln!("[kordi] {error}");
            }
        }
        if let Err(error) = registry.persist_seeded_histories() {
            eprintln!("[kordi] {error}");
        }
        changed
    })
}

#[cfg(test)]
#[path = "access/tests.rs"]
mod tests;
