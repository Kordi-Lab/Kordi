//! Marks files Kordi writes from conversation content with the macOS
//! quarantine attribute, the same way browsers mark downloads, so Gatekeeper
//! checks them before anything in them can run.

use std::path::Path;

#[cfg(target_os = "macos")]
const QUARANTINE_ATTRIBUTE: &str = "com.apple.quarantine";

#[cfg(target_os = "macos")]
fn quarantine_value() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    // flags;timestamp;agent;event id. These are the flags browsers write for
    // downloaded files; the "user approved" bit stays clear so Gatekeeper
    // still evaluates the file on first open.
    format!(
        "0081;{seconds:08x};Kordi;{}",
        uuid::Uuid::new_v4().hyphenated().to_string().to_uppercase()
    )
}

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::{c_char, c_int, c_void};

    unsafe extern "C" {
        pub fn setxattr(
            path: *const c_char,
            name: *const c_char,
            value: *const c_void,
            size: usize,
            position: u32,
            options: c_int,
        ) -> c_int;
        pub fn getxattr(
            path: *const c_char,
            name: *const c_char,
            value: *mut c_void,
            size: usize,
            position: u32,
            options: c_int,
        ) -> isize;
    }
}

#[cfg(target_os = "macos")]
fn c_path(path: &Path) -> Result<std::ffi::CString, String> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "Attachment path is invalid.".to_string())
}

/// Adds the quarantine attribute to `path`. Existing quarantine data is kept.
#[cfg(target_os = "macos")]
pub(crate) fn mark_quarantined(path: &Path) -> Result<(), String> {
    if is_quarantined(path) {
        return Ok(());
    }
    let path_c = c_path(path)?;
    let name = std::ffi::CString::new(QUARANTINE_ATTRIBUTE).expect("static attribute name");
    let value = quarantine_value();
    // SAFETY: all pointers reference live, NUL-terminated buffers (or a byte
    // buffer with its exact length) for the duration of the call.
    let result = unsafe {
        ffi::setxattr(
            path_c.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Unable to mark attachment as downloaded: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn is_quarantined(path: &Path) -> bool {
    let (Ok(path_c), Ok(name)) = (c_path(path), std::ffi::CString::new(QUARANTINE_ATTRIBUTE))
    else {
        return false;
    };
    // SAFETY: a null value buffer with size 0 asks only for the attribute size.
    let size = unsafe {
        ffi::getxattr(
            path_c.as_ptr(),
            name.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    size > 0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn mark_quarantined(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_quarantined(_path: &Path) -> bool {
    false
}

/// Best-effort variant for write paths where failing the whole operation
/// would lose the received content.
pub(crate) fn mark_quarantined_or_log(path: &Path) {
    if let Err(error) = mark_quarantined(path) {
        eprintln!("[kordi] {error}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn marks_files_with_a_download_quarantine_attribute() {
        let path =
            std::env::temp_dir().join(format!("kordi-quarantine-{}.command", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"echo hello").unwrap();
        assert!(!is_quarantined(&path));

        mark_quarantined(&path).unwrap();
        assert!(is_quarantined(&path));

        let output = std::process::Command::new("/usr/bin/xattr")
            .args(["-p", QUARANTINE_ATTRIBUTE])
            .arg(&path)
            .output()
            .unwrap();
        let value = String::from_utf8_lossy(&output.stdout);
        assert!(value.starts_with("0081;"), "unexpected value: {value}");
        assert!(value.contains(";Kordi;"), "unexpected value: {value}");

        // Marking again keeps the original record.
        mark_quarantined(&path).unwrap();
        let again = std::process::Command::new("/usr/bin/xattr")
            .args(["-p", QUARANTINE_ATTRIBUTE])
            .arg(&path)
            .output()
            .unwrap();
        assert_eq!(output.stdout, again.stdout);
        std::fs::remove_file(path).ok();
    }
}
