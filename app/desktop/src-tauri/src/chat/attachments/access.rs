//! Decides which local files the attachment commands may read, copy, upload,
//! or open.
//!
//! A file is usable when it is inside Kordi's own attachment storage (files
//! Kordi wrote, including the received-attachment cache), or when it was
//! registered because the person attached it (native picker, paste, or
//! reference), recorded it, or saved a copy of it through Kordi. Paths that
//! only appear in message data are never enough on their own.
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
const MAX_REGISTERED_PATHS: usize = 4096;

/// Returned when a path is outside Kordi's attachment storage and was never
/// attached, recorded, or saved through Kordi. The desktop UI matches this
/// prefix to fall back to the Cloud copy of an attachment.
pub(crate) const ATTACHMENT_ACCESS_DENIED: &str =
    "Kordi no longer has access to this file. Attach it again from its original location.";

const PROTECTED_LOCATION_MESSAGE: &str =
    "Kordi does not attach files from credential or keychain folders.";

/// Home-relative locations that hold credentials. Attaching from these needs
/// the native file picker, so a request that only names a path cannot read
/// them.
const PROTECTED_HOME_LOCATIONS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".config/gcloud",
    ".config/gh",
    "Library/Keychains",
    "Library/Cookies",
];

#[derive(Default)]
struct Registry {
    file: PathBuf,
    order: Vec<PathBuf>,
    paths: HashSet<PathBuf>,
}

impl Registry {
    fn load(file: PathBuf) -> Self {
        let order = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<PathBuf>>(&bytes).ok())
            .unwrap_or_default();
        let paths = order.iter().cloned().collect();
        Self { file, order, paths }
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
        let bytes = serde_json::to_vec(&self.order).map_err(|error| error.to_string())?;
        let temporary = self
            .file
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = options
            .open(&temporary)
            .and_then(|mut file| file.write_all(&bytes).and_then(|_| file.sync_all()))
            .and_then(|_| std::fs::rename(&temporary, &self.file));
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(|error| format!("Unable to remember attachment access: {error}"))
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

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| std::fs::canonicalize(home).ok())
}

fn is_protected_location(canonical: &Path) -> bool {
    let home = home_directory();
    if let Some(home) = &home {
        if PROTECTED_HOME_LOCATIONS
            .iter()
            .any(|location| canonical.starts_with(home.join(location)))
        {
            return true;
        }
    }
    let canonical_env_dir = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .and_then(|dir| std::fs::canonicalize(dir).ok())
    };
    if let Some(app_data) = canonical_env_dir("APP_DATA_DIR") {
        if canonical.starts_with(app_data.join("kordi").join("cloud-secrets")) {
            return true;
        }
    }
    if canonical_env_dir("KORDI_AUTH_PATH").is_some_and(|auth| canonical == auth) {
        return true;
    }
    // Provider credentials live in `auth.json` inside Kordi storage roots.
    let storage_roots = [
        canonical_env_dir("APP_DATA_DIR"),
        canonical_env_dir("KORDI_STORAGE_ROOT"),
        home.and_then(|home| std::fs::canonicalize(home.join(".kordi")).ok()),
    ];
    canonical
        .file_name()
        .is_some_and(|name| name == "auth.json")
        && storage_roots
            .into_iter()
            .flatten()
            .any(|root| canonical.starts_with(root))
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
        if changed {
            registry.persist()
        } else {
            Ok(())
        }
    })?
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

/// Registers a path the desktop UI asked to attach (paste, file reference, or
/// a picker result passed back from the UI). Returns the canonical path.
pub(crate) fn register_requested_attachment(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to read attachment {}: {error}", path.display()))?;
    if is_in_attachment_storage(&canonical) || is_registered(&canonical)? {
        return Ok(canonical);
    }
    if is_protected_location(&canonical) {
        return Err(PROTECTED_LOCATION_MESSAGE.to_string());
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

/// Resolves `path` to a canonical regular file that attachment commands may
/// use, or explains why it cannot be used.
pub(crate) fn authorize_attachment_file(path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_file(path)?;
    if is_in_attachment_storage(&canonical) || is_registered(&canonical)? {
        return Ok(canonical);
    }
    Err(ATTACHMENT_ACCESS_DENIED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedAppDataDir;

    fn outside_file(label: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "kordi-attachment-access-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        std::fs::write(&file, b"notes").unwrap();
        (dir, file)
    }

    #[test]
    fn files_in_attachment_storage_are_usable() {
        let _app_data = ScopedAppDataDir::new("attachment-access-storage");
        let stored = attachment_storage_dir().unwrap().join("stored.txt");
        std::fs::write(&stored, b"stored").unwrap();

        let authorized = authorize_attachment_file(&stored).unwrap();

        assert_eq!(authorized, std::fs::canonicalize(&stored).unwrap());
    }

    #[test]
    fn unregistered_files_outside_storage_are_refused() {
        let _app_data = ScopedAppDataDir::new("attachment-access-refused");
        let (dir, file) = outside_file("refused");

        assert_eq!(
            authorize_attachment_file(&file).unwrap_err(),
            ATTACHMENT_ACCESS_DENIED
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn attached_files_stay_usable_after_the_registry_reloads() {
        let app_data = ScopedAppDataDir::new("attachment-access-persisted");
        let (dir, file) = outside_file("persisted");

        register_requested_attachment(&file).unwrap();
        assert!(authorize_attachment_file(&file).is_ok());

        // Simulate a restart by dropping the in-memory registry.
        *registry().lock().unwrap() = None;
        assert!(authorize_attachment_file(&file).is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let registry_file = std::fs::canonicalize(attachment_storage_dir().unwrap())
                .unwrap()
                .join(REGISTRY_FILE_NAME);
            let mode = std::fs::metadata(registry_file)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        drop(app_data);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn requested_attachments_from_credential_folders_are_refused() {
        let _app_data = ScopedAppDataDir::new("attachment-access-protected");
        let home = std::env::temp_dir().join(format!("kordi-home-{}", uuid::Uuid::new_v4()));
        let key = home.join(".ssh").join("id_ed25519");
        std::fs::create_dir_all(key.parent().unwrap()).unwrap();
        std::fs::write(&key, b"key").unwrap();
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);

        let provider_credentials = home.join(".kordi").join("auth.json");
        let agent_notes = home.join(".kordi").join("agents").join("notes.md");
        std::fs::create_dir_all(agent_notes.parent().unwrap()).unwrap();
        std::fs::write(&provider_credentials, b"{}").unwrap();
        std::fs::write(&agent_notes, b"notes").unwrap();
        let credentials_requested = register_requested_attachment(&provider_credentials);
        let notes_requested = register_requested_attachment(&agent_notes);

        let requested = register_requested_attachment(&key);
        let authorized = authorize_attachment_file(&key);
        // An explicit native-dialog choice is still honored.
        register_native_selection(&[&key]).unwrap();
        let after_native_choice = authorize_attachment_file(&key);

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(&home).ok();

        assert_eq!(
            credentials_requested.unwrap_err(),
            PROTECTED_LOCATION_MESSAGE
        );
        assert!(
            notes_requested.is_ok(),
            "ordinary Kordi files stay attachable"
        );
        assert_eq!(requested.unwrap_err(), PROTECTED_LOCATION_MESSAGE);
        assert_eq!(authorized.unwrap_err(), ATTACHMENT_ACCESS_DENIED);
        assert!(after_native_choice.is_ok());
    }

    #[test]
    fn symlinks_resolve_before_authorization() {
        let _app_data = ScopedAppDataDir::new("attachment-access-symlink");
        let (dir, file) = outside_file("symlink");
        let link = attachment_storage_dir().unwrap().join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        #[cfg(unix)]
        assert_eq!(
            authorize_attachment_file(&link).unwrap_err(),
            ATTACHMENT_ACCESS_DENIED
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn registry_keeps_the_most_recent_paths() {
        let mut registry = Registry::default();
        for index in 0..(MAX_REGISTERED_PATHS + 2) {
            registry.insert(PathBuf::from(format!("/tmp/file-{index}")));
        }
        assert_eq!(registry.order.len(), MAX_REGISTERED_PATHS);
        assert!(!registry.paths.contains(Path::new("/tmp/file-0")));
        assert!(registry.paths.contains(&PathBuf::from(format!(
            "/tmp/file-{}",
            MAX_REGISTERED_PATHS + 1
        ))));
    }

    #[tokio::test]
    async fn reading_requires_the_file_to_be_attached_first() {
        let _app_data = crate::test_support::ScopedAppDataDir::new("attachment-read-access");
        let dir =
            std::env::temp_dir().join(format!("kordi-attachment-access-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create outside dir");
        let file = dir.join("notes.txt");
        std::fs::write(&file, b"notes").expect("write outside file");

        let refused = super::super::desktop_chat_read_attachment(file.display().to_string())
            .await
            .expect_err("unattached files are refused");
        assert_eq!(refused, ATTACHMENT_ACCESS_DENIED);

        super::super::desktop_chat_store_attachment_path(file.display().to_string(), None)
            .await
            .expect("attach file");
        let bytes = super::super::desktop_chat_read_attachment(file.display().to_string())
            .await
            .expect("attached file is readable");
        assert_eq!(bytes, b"notes");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copies_of_received_attachments_are_marked_and_openable() {
        let _app_data = crate::test_support::ScopedAppDataDir::new("attachment-copy-out");
        let received = attachment_storage_dir().unwrap().join("invoice.pdf");
        std::fs::write(&received, b"%PDF-1.7").unwrap();
        let received = std::fs::canonicalize(received).unwrap();
        let target_dir =
            std::env::temp_dir().join(format!("kordi-attachment-copy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("invoice.pdf");

        super::super::save_as::copy_attachment_out(&received, &target).unwrap();

        #[cfg(target_os = "macos")]
        assert!(super::super::quarantine::is_quarantined(&target));
        assert!(super::super::open_local::prepare_local_attachment_open(
            &target.display().to_string()
        )
        .is_ok());
        std::fs::remove_dir_all(target_dir).ok();
    }
}
