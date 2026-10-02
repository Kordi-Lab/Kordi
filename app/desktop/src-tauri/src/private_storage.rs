//! Owner-only permissions for the directories and files that hold Kordi data.
//!
//! On Unix, Kordi data directories become `0700` and the canonical SQLite files
//! become `0600`, so other accounts on the same machine cannot list or read
//! cached messages and attachments without administrator access. The helpers:
//!
//! - never touch broad roots: the home directory, `/`, the system temporary
//!   directory itself, their ancestors, relative paths, or paths with fewer
//!   than three components;
//! - never follow symbolic links: a symlinked data directory keeps the mode of
//!   its target, and a directory that is swapped for a link while it is being
//!   checked is left alone;
//! - only tighten the directory itself. Files below a data root keep their
//!   modes (except the canonical database, see `canonical_sessions::database`)
//!   because package and extension folders there contain executables; a
//!   private root already keeps other accounts out of everything below it.
//!
//! `ensure_owned_private_dir` is the strict variant for shared locations such
//! as the temporary attachment fallback: it fails unless the directory is a
//! real directory that this account owns and that is private afterwards.
//!
//! On other platforms the permission changes are no-ops; the `ensure_*`
//! helpers still create the directory so callers behave the same everywhere.

use std::io;
use std::path::{Path, PathBuf};

const MIN_PRIVATE_ROOT_COMPONENTS: usize = 3;
#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const GROUP_AND_OTHER_BITS: u32 = 0o077;
const LEGACY_AGENT_DIR_NAME: &str = ".bb-agent";

/// Whether `path` is narrow enough to restrict to the current account.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn is_safe_private_root(path: &Path) -> bool {
    if !path.is_absolute() || path.components().count() < MIN_PRIVATE_ROOT_COMPONENTS {
        return false;
    }
    let canonical = std::fs::canonicalize(path).ok();
    protected_roots().iter().all(|protected| {
        let canonical_protected = std::fs::canonicalize(protected).ok();
        !covers(path, protected)
            && match (&canonical, &canonical_protected) {
                (Some(path), Some(protected)) => !covers(path, protected),
                _ => true,
            }
    })
}

/// True when `path` is `protected` itself or one of its ancestors.
#[cfg_attr(not(unix), allow(dead_code))]
fn covers(path: &Path, protected: &Path) -> bool {
    protected.starts_with(path)
}

#[cfg_attr(not(unix), allow(dead_code))]
fn protected_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/"), std::env::temp_dir()];
    for name in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            roots.push(PathBuf::from(home));
        }
    }
    roots
}

/// Sets an existing, real data directory to `0700`. Symlinks, missing paths,
/// non-directories, and unsafe roots are left unchanged.
pub(crate) fn restrict_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mode = metadata.permissions().mode();
        if !metadata.file_type().is_dir()
            || mode & 0o777 == PRIVATE_DIR_MODE
            || !is_safe_private_root(path)
        {
            return Ok(());
        }
        set_dir_mode_if_unchanged(path, &metadata, private_dir_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Creates a data directory (new components are created owner-only) and
/// tightens an existing one. Only creation errors are returned: tightening is
/// best effort, so a data directory on a file system without Unix modes keeps
/// working.
pub(crate) fn ensure_private_dir(path: &Path) -> io::Result<()> {
    create_dir_all_private(path)?;
    let _ = restrict_private_dir(path);
    Ok(())
}

/// Strict variant for shared locations. Succeeds only when `path` is a real
/// directory (not a symlink) owned by this account whose group and other
/// permission bits are clear afterwards.
pub(crate) fn ensure_owned_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !is_safe_private_root(path) {
            return Err(not_private());
        }
        create_dir_all_private(path)?;
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.file_type().is_dir() {
            return Err(not_private());
        }
        // Only the owner may change a mode, even to the same value, so a
        // successful change also proves this account owns the directory.
        let mode = metadata.permissions().mode();
        set_dir_mode_if_unchanged(path, &metadata, private_dir_mode(mode))?;
        let after = std::fs::symlink_metadata(path)?;
        if !after.file_type().is_dir()
            || file_identity(&after) != file_identity(&metadata)
            || after.permissions().mode() & GROUP_AND_OTHER_BITS != 0
        {
            return Err(not_private());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// Removes group and other permission bits from a regular file. Symlinks and
/// other file types are left unchanged.
pub(crate) fn restrict_private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mode = metadata.permissions().mode();
        if !metadata.file_type().is_file() || mode & GROUP_AND_OTHER_BITS == 0 {
            return Ok(());
        }
        // Change the mode by path. Opening a second descriptor on a SQLite
        // database and closing it again would release the POSIX locks that
        // other connections in this process hold on the same file.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o700))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Best-effort startup pass over the existing local data roots. Failures are
/// logged once without paths and never block startup.
pub(crate) fn harden_local_storage_roots() {
    let mut failed = false;
    for root in local_storage_roots() {
        failed |= restrict_private_dir(&root).is_err();
    }
    if failed {
        eprintln!("[kordi] Unable to restrict access to some local data directories");
    }
}

fn local_storage_roots() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = ["APP_DATA_DIR", "KORDI_STORAGE_ROOT"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect();
    candidates.push(kordi_core::config::preferred_global_settings_dir());
    let legacy = kordi_core::config::global_dir();
    if legacy.file_name() == Some(std::ffi::OsStr::new(LEGACY_AGENT_DIR_NAME)) {
        candidates.push(legacy);
    }
    candidates.push(std::env::temp_dir().join(crate::chat::attachments::TEMP_ATTACHMENT_DIR_NAME));
    let mut roots: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if !roots.contains(&candidate) && std::fs::symlink_metadata(&candidate).is_ok() {
            roots.push(candidate);
        }
    }
    roots
}

fn create_dir_all_private(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(PRIVATE_DIR_MODE);
    }
    builder.create(path)
}

#[cfg(unix)]
fn private_dir_mode(mode: u32) -> u32 {
    (mode & !0o777) | PRIVATE_DIR_MODE
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

/// Changes a directory's mode through a descriptor, after checking that the
/// descriptor refers to the same directory that was inspected. A path that was
/// replaced by a symlink in the meantime is never followed.
#[cfg(unix)]
fn set_dir_mode_if_unchanged(
    path: &Path,
    inspected: &std::fs::Metadata,
    mode: u32,
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::fs::File::open(path)?;
    let opened = directory.metadata()?;
    if !opened.is_dir() || file_identity(&opened) != file_identity(inspected) {
        return Err(not_private());
    }
    directory.set_permissions(std::fs::Permissions::from_mode(mode))
}

#[cfg(unix)]
fn not_private() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "directory is not a private directory owned by this account",
    )
}

#[cfg(all(test, unix))]
mod tests;
