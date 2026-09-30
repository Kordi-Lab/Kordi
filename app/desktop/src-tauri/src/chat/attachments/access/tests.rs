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

/// Points `HOME` at a fresh temporary folder until dropped. Callers must hold
/// the process environment lock (for example through `ScopedAppDataDir`).
struct ScopedHome {
    home: PathBuf,
    previous: Option<std::ffi::OsString>,
}

impl ScopedHome {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("kordi-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        Self { home, previous }
    }

    fn file(&self, relative: &str, contents: &[u8]) -> PathBuf {
        let path = self.home.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for ScopedHome {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(&self.home).ok();
    }
}

/// Uses `database` as the local session history for the seeding step.
struct ScopedSessionDatabase;

impl ScopedSessionDatabase {
    fn new(database: &Path) -> Self {
        *TEST_SESSION_DATABASE.lock().unwrap() = Some(database.to_path_buf());
        Self
    }
}

impl Drop for ScopedSessionDatabase {
    fn drop(&mut self) {
        *TEST_SESSION_DATABASE.lock().unwrap() = None;
    }
}

fn record_sent_attachments(conn: &rusqlite::Connection, session_id: &str, paths: &[&Path]) {
    let attachments: Vec<serde_json::Value> = paths
        .iter()
        .map(|path| {
            serde_json::json!({
                "kind": "file",
                "name": path.file_name().unwrap().to_string_lossy(),
                "localPath": path.display().to_string(),
            })
        })
        .collect();
    let entry = kordi_core::types::SessionEntry::CustomMessage {
        base: kordi_core::types::EntryBase {
            id: kordi_core::types::EntryId::generate(),
            parent_id: None,
            timestamp: chrono::Utc::now(),
        },
        custom_type: ATTACHMENT_CONTEXT_CUSTOM_TYPE.to_string(),
        content: Vec::new(),
        display: false,
        details: Some(serde_json::json!({ "attachments": attachments })),
    };
    kordi_session::store::append_entry(conn, session_id, &entry).unwrap();
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
    assert_eq!(
        authorize_attachment_path(&dir).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );

    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn attached_files_stay_usable_after_the_registry_reloads() {
    let app_data = ScopedAppDataDir::new("attachment-access-persisted");
    let (dir, file) = outside_file("persisted");

    register_referenced_attachment(&file).unwrap();
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
    let home = ScopedHome::new();
    let key = home.file(".ssh/id_ed25519", b"key");
    let provider_credentials = home.file(".kordi/auth.json", b"{}");
    let agent_notes = home.file(".kordi/agents/notes.md", b"notes");

    assert_eq!(
        register_referenced_attachment(&provider_credentials).unwrap_err(),
        PROTECTED_LOCATION_MESSAGE
    );
    assert!(
        register_referenced_attachment(&agent_notes).is_ok(),
        "ordinary Kordi files stay attachable"
    );
    assert_eq!(
        register_referenced_attachment(&key).unwrap_err(),
        PROTECTED_LOCATION_MESSAGE
    );
    assert_eq!(
        authorize_pasted_attachment(&key, std::slice::from_ref(&key)).unwrap_err(),
        PROTECTED_LOCATION_MESSAGE,
        "a pasted file URL does not unlock a credential folder"
    );
    assert_eq!(
        authorize_attachment_file(&key).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );

    // An explicit native-dialog choice is still honored.
    register_native_selection(&[&key]).unwrap();
    assert!(authorize_attachment_file(&key).is_ok());
}

#[test]
fn token_history_and_browser_profile_locations_are_protected() {
    let _app_data = ScopedAppDataDir::new("attachment-access-protected-list");
    let home = ScopedHome::new();
    for relative in [
        ".npmrc",
        ".pypirc",
        ".cargo/credentials.toml",
        ".codex/auth.json",
        ".zsh_history",
        ".bash_history",
        "Library/Application Support/Google/Chrome/Default/Cookies",
        "Library/Application Support/Firefox/Profiles/default/logins.json",
    ] {
        let path = home.file(relative, b"secret");
        assert!(is_protected_location(&path), "{relative} is protected");
        assert_eq!(
            register_referenced_attachment(&path).unwrap_err(),
            PROTECTED_LOCATION_MESSAGE,
            "{relative} cannot be attached by path"
        );
    }
    let ordinary = home.file("Documents/report.md", b"report");
    assert!(!is_protected_location(&ordinary));
}

#[cfg(target_os = "macos")]
#[test]
fn protected_locations_match_every_spelling_of_the_same_folder() {
    let _app_data = ScopedAppDataDir::new("attachment-access-firmlink");
    let home = ScopedHome::new();
    let key = home.file(".ssh/id_ed25519", b"key");
    let credentials = home.file(".kordi/auth.json", b"{}");

    for path in [&key, &credentials] {
        // `/private` (which holds the temporary folder) is a firmlink into the
        // data volume, so this is a second canonical spelling of the file.
        let data_volume_spelling = Path::new("/System/Volumes/Data").join(
            std::fs::canonicalize(path)
                .unwrap()
                .strip_prefix("/")
                .unwrap(),
        );
        assert!(
            data_volume_spelling.exists(),
            "{} should exist",
            data_volume_spelling.display()
        );
        assert_ne!(
            std::fs::canonicalize(&data_volume_spelling).unwrap(),
            std::fs::canonicalize(path).unwrap(),
            "canonicalize keeps both spellings"
        );

        assert!(is_protected_location(&data_volume_spelling));
        assert_eq!(
            register_referenced_attachment(&data_volume_spelling).unwrap_err(),
            PROTECTED_LOCATION_MESSAGE
        );
        assert_eq!(
            ensure_previewable_location(&data_volume_spelling).unwrap_err(),
            PROTECTED_PREVIEW_MESSAGE
        );
        assert_eq!(
            authorize_attachment_file(&data_volume_spelling).unwrap_err(),
            ATTACHMENT_ACCESS_DENIED
        );
    }
}

#[test]
fn pasted_paths_need_a_matching_file_url_on_the_pasteboard() {
    let _app_data = ScopedAppDataDir::new("attachment-access-paste");
    let (dir, pasted) = outside_file("paste");
    let other = dir.join("other.txt");
    std::fs::write(&other, b"other").unwrap();

    assert_eq!(
        authorize_pasted_attachment(&other, std::slice::from_ref(&pasted)).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED,
        "a path that is not on the pasteboard is refused"
    );
    assert_eq!(
        authorize_pasted_attachment(&pasted, &[]).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );

    let authorized = authorize_pasted_attachment(&pasted, std::slice::from_ref(&pasted)).unwrap();
    assert_eq!(authorized, std::fs::canonicalize(&pasted).unwrap());
    assert!(authorize_attachment_file(&pasted).is_ok());
    assert_eq!(
        authorize_attachment_file(&other).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );

    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn files_sent_in_earlier_local_sessions_stay_usable() {
    let app_data = ScopedAppDataDir::new("attachment-access-history");
    let home = ScopedHome::new();
    let (dir, sent) = outside_file("history");
    let never_sent = dir.join("never-sent.txt");
    std::fs::write(&never_sent, b"never sent").unwrap();
    let sent_key = home.file(".ssh/id_ed25519", b"key");
    let later = dir.join("later.txt");
    std::fs::write(&later, b"later").unwrap();

    let database = dir.join("sessions.db");
    let conn = kordi_session::store::open_db(&database).unwrap();
    let session_id =
        kordi_session::store::create_session(&conn, &dir.display().to_string()).unwrap();
    record_sent_attachments(&conn, &session_id, &[&sent, &sent_key]);
    let _history = ScopedSessionDatabase::new(&database);

    assert!(authorize_attachment_file(&sent).is_ok());
    assert_eq!(
        authorize_attachment_file(&never_sent).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );
    assert_eq!(
        authorize_attachment_file(&sent_key).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED,
        "earlier sends never unlock protected locations"
    );

    // Seeding runs once per database: sends recorded afterwards are
    // registered when they are attached, not by the history.
    record_sent_attachments(&conn, &session_id, &[&later]);
    *registry().lock().unwrap() = None;
    assert!(authorize_attachment_file(&sent).is_ok());
    assert_eq!(
        authorize_attachment_file(&later).unwrap_err(),
        ATTACHMENT_ACCESS_DENIED
    );

    drop(conn);
    drop(app_data);
    std::fs::remove_dir_all(dir).ok();
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

#[test]
fn copies_of_received_attachments_are_marked_and_openable() {
    let _app_data = ScopedAppDataDir::new("attachment-copy-out");
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
    assert!(
        super::super::open_local::prepare_local_attachment_open(&target.display().to_string())
            .is_ok()
    );
    std::fs::remove_dir_all(target_dir).ok();
}
