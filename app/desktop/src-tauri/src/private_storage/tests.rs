use super::*;
use std::os::unix::fs::PermissionsExt;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "kordi-private-storage-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        Self(root)
    }

    fn join(&self, path: &str) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("set mode");
}

#[test]
fn open_directories_become_owner_only() {
    let root = TempRoot::new("dir");
    let dir = root.join("data");
    std::fs::create_dir(&dir).unwrap();
    set_mode(&dir, 0o755);

    restrict_private_dir(&dir).unwrap();

    assert_eq!(mode(&dir), 0o700);
}

#[test]
fn symlinked_directories_keep_their_target_mode() {
    let root = TempRoot::new("dir-link");
    let target = root.join("target");
    let link = root.join("link");
    std::fs::create_dir(&target).unwrap();
    set_mode(&target, 0o755);
    std::os::unix::fs::symlink(&target, &link).unwrap();

    restrict_private_dir(&link).unwrap();

    assert_eq!(mode(&target), 0o755);
}

#[test]
fn missing_paths_and_files_are_ignored_by_the_directory_helper() {
    let root = TempRoot::new("dir-missing");
    restrict_private_dir(&root.join("missing")).unwrap();
    let file = root.join("file.txt");
    std::fs::write(&file, b"data").unwrap();
    set_mode(&file, 0o644);

    restrict_private_dir(&file).unwrap();

    assert_eq!(mode(&file), 0o644);
}

#[test]
fn files_lose_group_and_other_access() {
    let root = TempRoot::new("file");
    let readable = root.join("readable.sqlite3");
    let executable = root.join("tool");
    std::fs::write(&readable, b"data").unwrap();
    std::fs::write(&executable, b"#!/bin/sh\n").unwrap();
    set_mode(&readable, 0o644);
    set_mode(&executable, 0o755);

    restrict_private_file(&readable).unwrap();
    restrict_private_file(&executable).unwrap();

    assert_eq!(mode(&readable), 0o600);
    assert_eq!(mode(&executable), 0o700);
}

#[test]
fn symlinked_files_keep_their_target_mode() {
    let root = TempRoot::new("file-link");
    let target = root.join("target.txt");
    let link = root.join("link.txt");
    std::fs::write(&target, b"data").unwrap();
    set_mode(&target, 0o644);
    std::os::unix::fs::symlink(&target, &link).unwrap();

    restrict_private_file(&link).unwrap();

    assert_eq!(mode(&target), 0o644);
}

#[test]
fn broad_roots_are_never_private_roots() {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = &home {
        assert!(!is_safe_private_root(home));
        if let Some(parent) = home.parent() {
            assert!(!is_safe_private_root(parent));
        }
    }
    assert!(!is_safe_private_root(Path::new("/")));
    assert!(!is_safe_private_root(Path::new("/tmp")));
    assert!(!is_safe_private_root(&std::env::temp_dir()));
    assert!(!is_safe_private_root(Path::new("relative/data/dir")));

    let root = TempRoot::new("safe");
    assert!(is_safe_private_root(&root.0));
    assert!(is_safe_private_root(&root.join("nested/data")));
}

#[test]
fn aliases_of_broad_roots_are_refused() {
    let root = TempRoot::new("alias");
    let alias = root.join("alias");
    // A path that resolves to the temporary directory itself is refused even
    // though it is spelled differently.
    std::os::unix::fs::symlink(std::env::temp_dir(), &alias).unwrap();
    assert!(!is_safe_private_root(&alias.join(".")));
    assert!(!is_safe_private_root(&root.0.join("..")));
}

#[test]
fn ensure_private_dir_creates_nested_owner_only_directories() {
    let root = TempRoot::new("ensure");
    let leaf = root.join("a/b/c");

    ensure_private_dir(&leaf).unwrap();

    assert!(leaf.is_dir());
    assert_eq!(mode(&leaf), 0o700);
    assert_eq!(mode(&root.join("a")), 0o700);
}

#[test]
fn ensure_private_dir_tightens_an_existing_directory() {
    let root = TempRoot::new("ensure-existing");
    let dir = root.join("existing");
    std::fs::create_dir(&dir).unwrap();
    set_mode(&dir, 0o775);

    ensure_private_dir(&dir).unwrap();

    assert_eq!(mode(&dir), 0o700);
}

#[test]
fn ensure_private_dir_accepts_a_symlinked_directory_without_changing_it() {
    let root = TempRoot::new("ensure-link");
    let target = root.join("target");
    let link = root.join("link");
    std::fs::create_dir(&target).unwrap();
    set_mode(&target, 0o755);
    std::os::unix::fs::symlink(&target, &link).unwrap();

    ensure_private_dir(&link).unwrap();

    assert_eq!(mode(&target), 0o755);
}

#[test]
fn ensure_owned_private_dir_creates_a_private_directory() {
    let root = TempRoot::new("owned");
    let dir = root.join("attachments");

    ensure_owned_private_dir(&dir).unwrap();

    assert_eq!(mode(&dir), 0o700);
}

#[test]
fn ensure_owned_private_dir_tightens_an_owned_open_directory() {
    let root = TempRoot::new("owned-open");
    let dir = root.join("attachments");
    std::fs::create_dir(&dir).unwrap();
    set_mode(&dir, 0o777);

    ensure_owned_private_dir(&dir).unwrap();

    assert_eq!(mode(&dir), 0o700);
}

#[test]
fn ensure_owned_private_dir_refuses_a_symlinked_directory() {
    let root = TempRoot::new("owned-link");
    let target = root.join("target");
    let link = root.join("attachments");
    std::fs::create_dir(&target).unwrap();
    set_mode(&target, 0o755);
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let error = ensure_owned_private_dir(&link).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(mode(&target), 0o755);
}

#[test]
fn ensure_owned_private_dir_refuses_broad_roots() {
    assert!(ensure_owned_private_dir(&std::env::temp_dir()).is_err());
}

#[test]
fn local_storage_roots_lists_existing_data_roots_once() {
    let _guard = crate::test_support::lock_process_environment();
    let root = TempRoot::new("roots");
    let app_data = root.join("app-data");
    let storage = root.join("storage");
    std::fs::create_dir_all(&app_data).unwrap();
    std::fs::create_dir_all(storage.join(".bb-agent")).unwrap();
    let previous_app_data = std::env::var_os("APP_DATA_DIR");
    let previous_storage = std::env::var_os("KORDI_STORAGE_ROOT");
    std::env::set_var("APP_DATA_DIR", &app_data);
    std::env::set_var("KORDI_STORAGE_ROOT", &storage);

    let roots = local_storage_roots();

    match previous_app_data {
        Some(value) => std::env::set_var("APP_DATA_DIR", value),
        None => std::env::remove_var("APP_DATA_DIR"),
    }
    match previous_storage {
        Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
        None => std::env::remove_var("KORDI_STORAGE_ROOT"),
    }
    assert_eq!(roots[0], app_data);
    // KORDI_STORAGE_ROOT is also the preferred settings directory; it appears once.
    assert_eq!(roots.iter().filter(|path| **path == storage).count(), 1);
    assert!(roots.contains(&storage.join(".bb-agent")));
    assert!(roots.iter().all(|path| path.exists()));
}

#[test]
fn local_storage_roots_skip_missing_paths() {
    let _guard = crate::test_support::lock_process_environment();
    let root = TempRoot::new("roots-missing");
    let previous_storage = std::env::var_os("KORDI_STORAGE_ROOT");
    std::env::set_var("KORDI_STORAGE_ROOT", root.join("missing"));

    let roots = local_storage_roots();

    match previous_storage {
        Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
        None => std::env::remove_var("KORDI_STORAGE_ROOT"),
    }
    assert!(!roots.contains(&root.join("missing")));
    assert!(!roots.contains(&root.join("missing").join(".bb-agent")));
}
