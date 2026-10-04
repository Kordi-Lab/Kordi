//! Local sandbox file access that never follows symbolic links.
//!
//! Sandbox commands can create links, and the runner may have more
//! privileges than the commands it starts. Every path is therefore opened one
//! component at a time from the sandbox root with `O_NOFOLLOW`, so a planted
//! link cannot send a runner file operation outside the sandbox, even when it
//! is swapped in while the operation runs. Only regular files are read or
//! written, which also keeps a named pipe from blocking the runner.

use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::{Component, Path};

use super::SandboxIdentity;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn c_name(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| invalid("path contains a NUL byte"))
}

fn open_at(dir: &File, name: &OsStr, flags: libc::c_int, mode: libc::c_uint) -> io::Result<File> {
    let name = c_name(name)?;
    // SAFETY: `dir` is an open directory descriptor and `name` is a valid
    // NUL-terminated string that outlives the call.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is a newly opened descriptor that nothing else owns.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn is_link_at(dir: &File, name: &OsStr) -> bool {
    let Ok(name) = c_name(name) else {
        return false;
    };
    // SAFETY: an all-zero `stat` is a valid value for `fstatat` to fill in.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: as in `open_at`; `status` is a writable `stat`.
    let result = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut status,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    result == 0 && status.st_mode & libc::S_IFMT == libc::S_IFLNK
}

/// Opens a directory entry as a directory. A link is reported as `ELOOP` on
/// every platform; some report `ENOTDIR` for a link opened with
/// `O_DIRECTORY | O_NOFOLLOW`.
fn open_dir_at(dir: &File, name: &OsStr) -> io::Result<File> {
    open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0).map_err(|error| {
        if error.raw_os_error() == Some(libc::ENOTDIR) && is_link_at(dir, name) {
            io::Error::from_raw_os_error(libc::ELOOP)
        } else {
            error
        }
    })
}

/// Opens `name` in `dir` as a directory, creating it for `owner` if missing.
fn open_or_create_dir_at(
    dir: &File,
    name: &OsStr,
    owner: Option<SandboxIdentity>,
) -> io::Result<File> {
    match open_dir_at(dir, name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let c_name = c_name(name)?;
            // SAFETY: as in `open_at`.
            if unsafe { libc::mkdirat(dir.as_raw_fd(), c_name.as_ptr(), 0o755) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            let created = open_dir_at(dir, name)?;
            chown(&created, owner)?;
            Ok(created)
        }
        opened => opened,
    }
}

fn names(relative: &Path) -> Vec<&OsStr> {
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect()
}

fn regular(file: File) -> io::Result<File> {
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(invalid("not a regular file"))
    }
}

fn chown(file: &File, owner: Option<SandboxIdentity>) -> io::Result<()> {
    match owner {
        Some(owner) => std::os::unix::fs::fchown(file, Some(owner.uid), Some(owner.gid)),
        None => Ok(()),
    }
}

/// Reads a regular file beneath `root`, at most `limit` bytes when given.
pub(super) fn read(root: &Path, relative: &Path, limit: Option<u64>) -> io::Result<Vec<u8>> {
    let names = names(relative);
    let (name, directories) = names
        .split_last()
        .ok_or_else(|| invalid("a file path is required"))?;
    let mut dir = File::open(root)?;
    for directory in directories {
        dir = open_dir_at(&dir, directory)?;
    }
    let file = regular(open_at(&dir, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?)?;
    let mut bytes = Vec::new();
    match limit {
        Some(limit) => file.take(limit).read_to_end(&mut bytes)?,
        None => (&file).read_to_end(&mut bytes)?,
    };
    Ok(bytes)
}

/// Lists a directory beneath `root`.
pub(super) fn list(root: &Path, relative: &Path) -> io::Result<Vec<String>> {
    let mut dir = File::open(root)?;
    for directory in names(relative) {
        dir = open_dir_at(&dir, directory)?;
    }
    // Read the directory that was opened, not whatever the path names now.
    #[cfg(target_os = "linux")]
    let listed = std::path::PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()));
    #[cfg(not(target_os = "linux"))]
    let listed = root.join(relative);
    let mut entries = std::fs::read_dir(listed)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<io::Result<Vec<_>>>()?;
    drop(dir);
    entries.sort();
    Ok(entries)
}

/// Opens (creating if needed) a directory beneath `root`, giving directories
/// it creates to `owner`.
pub(super) fn ensure_dir(
    root: &Path,
    relative: &Path,
    owner: Option<SandboxIdentity>,
) -> io::Result<File> {
    let mut dir = File::open(root)?;
    for name in names(relative) {
        dir = open_or_create_dir_at(&dir, name, owner)?;
    }
    Ok(dir)
}

/// Writes a regular file beneath `root`, creating parent directories, and
/// gives new directories and the file to `owner`.
pub(super) fn write(
    root: &Path,
    relative: &Path,
    content: &[u8],
    owner: Option<SandboxIdentity>,
) -> io::Result<()> {
    let names = names(relative);
    let (name, directories) = names
        .split_last()
        .ok_or_else(|| invalid("a file path is required"))?;
    let mut dir = File::open(root)?;
    for directory in directories {
        dir = open_or_create_dir_at(&dir, directory, owner)?;
    }
    let mut output = regular(open_at(
        &dir,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK,
        0o644,
    )?)?;
    // A second name for a file elsewhere must not be truncated or given away.
    if owner.is_some() && output.metadata()?.nlink() > 1 {
        return Err(invalid("file has more than one link"));
    }
    output.set_len(0)?;
    chown(&output, owner)?;
    output.write_all(content)?;
    Ok(())
}

/// Gives `root` and everything beneath it to `owner` when `root` belongs to
/// someone else, as a sandbox created before its commands ran as `owner`
/// does. Children are changed before their directory and links are changed
/// but never followed; until `root` itself changes, `owner`'s commands cannot
/// rename anything in the tree.
pub(super) fn adopt(root: &Path, owner: SandboxIdentity) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(root)?;
    if !metadata.is_dir() {
        return Err(invalid("sandbox root is not a directory"));
    }
    if metadata.uid() == owner.uid && metadata.gid() == owner.gid {
        return Ok(());
    }
    adopt_children(root, owner)?;
    std::os::unix::fs::lchown(root, Some(owner.uid), Some(owner.gid))
}

fn adopt_children(dir: &Path, owner: SandboxIdentity) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if std::fs::symlink_metadata(&path)?.is_dir() {
            adopt_children(&path, owner)?;
        }
        std::os::unix::fs::lchown(&path, Some(owner.uid), Some(owner.gid))?;
    }
    Ok(())
}
