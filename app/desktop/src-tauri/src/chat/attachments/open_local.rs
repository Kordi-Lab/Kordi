//! Opens a local attachment with the system's default app, limited to files
//! the attachment access policy allows and to types that cannot run code.

use std::io::Read;
use std::path::Path;

use super::access::{authorize_attachment_file, is_in_attachment_storage};
use super::quarantine::mark_quarantined;

pub(crate) const RUNNABLE_ATTACHMENT_MESSAGE: &str =
    "This file can run code, so Kordi will not open it directly. Use Show in Finder if you trust it.";

/// Extensions of files that run code, install software, or launch other
/// files when opened.
const RUNNABLE_EXTENSIONS: &str = concat!(
    // macOS apps, bundles, and installers
    "app action bundle framework kext mpkg osax pkg plugin prefpane qlgenerator mdimporter ",
    "saver systemextension workflow xpc dylib so mobileconfig shortcut terminal ",
    // scripts
    "command tool sh bash zsh csh tcsh ksh fish py pyc rb pl php lua tcl scpt scptd ",
    "applescript jar jnlp ",
    // location files that open other targets
    "fileloc inetloc webloc url desktop lnk ",
    // other platforms' executables
    "exe msi bat cmd com scr ps1 vbs vbe wsf hta cpl appimage run",
);

fn has_runnable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| {
            RUNNABLE_EXTENSIONS
                .split_whitespace()
                .any(|runnable| runnable == extension)
        })
}

fn has_runnable_contents(path: &Path) -> bool {
    let mut header = [0_u8; 4];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    let header = &header[..read];
    const MACHO_MAGICS: [[u8; 4]; 6] = [
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
        [0xbe, 0xba, 0xfe, 0xca],
    ];
    header.starts_with(b"#!")
        || header.starts_with(b"MZ")
        || header.starts_with(b"\x7fELF")
        || MACHO_MAGICS.iter().any(|magic| header == magic)
}

fn has_executable_permission(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// True for files Kordi must not hand to the default app because opening
/// them can run code.
pub(crate) fn is_runnable_attachment(path: &Path) -> bool {
    has_runnable_extension(path) || has_executable_permission(path) || has_runnable_contents(path)
}

fn open_with_default_app(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("--");
        command
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
    } else {
        std::process::Command::new("xdg-open")
    };
    crate::run_external_command(command.arg(path))
}

/// Validates `path` and returns the canonical file to open.
pub(crate) fn prepare_local_attachment_open(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Attachment path is required.".to_string());
    }
    let canonical = authorize_attachment_file(Path::new(trimmed))?;
    if is_runnable_attachment(&canonical) {
        return Err(RUNNABLE_ATTACHMENT_MESSAGE.to_string());
    }
    if is_in_attachment_storage(&canonical) {
        // Files cached before quarantine marking existed get it now.
        mark_quarantined(&canonical)?;
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn desktop_open_local_attachment(path: String) -> Result<String, String> {
    let canonical = prepare_local_attachment_open(&path)?;
    open_with_default_app(&canonical)?;
    Ok(canonical.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::attachments::access::ATTACHMENT_ACCESS_DENIED;
    use crate::chat::attachments::attachment_storage_dir;
    use crate::test_support::ScopedAppDataDir;

    #[test]
    fn runnable_types_are_refused_even_inside_attachment_storage() {
        let _app_data = ScopedAppDataDir::new("open-local-runnable");
        let storage = attachment_storage_dir().unwrap();
        for name in [
            "run.command",
            "Setup.PKG",
            "script.sh",
            "link.fileloc",
            "tool.app",
        ] {
            let path = storage.join(name);
            std::fs::write(&path, b"data").unwrap();
            assert_eq!(
                prepare_local_attachment_open(&path.display().to_string()).unwrap_err(),
                RUNNABLE_ATTACHMENT_MESSAGE,
                "{name}"
            );
        }

        let shebang = storage.join("notes.txt");
        std::fs::write(&shebang, b"#!/bin/sh\necho hi\n").unwrap();
        assert_eq!(
            prepare_local_attachment_open(&shebang.display().to_string()).unwrap_err(),
            RUNNABLE_ATTACHMENT_MESSAGE
        );

        let macho = storage.join("binary");
        std::fs::write(&macho, [0xcf, 0xfa, 0xed, 0xfe, 0, 0]).unwrap();
        assert_eq!(
            prepare_local_attachment_open(&macho.display().to_string()).unwrap_err(),
            RUNNABLE_ATTACHMENT_MESSAGE
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = storage.join("report.pdf");
            std::fs::write(&executable, b"%PDF-1.7").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                prepare_local_attachment_open(&executable.display().to_string()).unwrap_err(),
                RUNNABLE_ATTACHMENT_MESSAGE
            );
        }
    }

    #[test]
    fn documents_in_attachment_storage_are_quarantined_before_opening() {
        let _app_data = ScopedAppDataDir::new("open-local-document");
        let document = attachment_storage_dir().unwrap().join("report.pdf");
        std::fs::write(&document, b"%PDF-1.7").unwrap();

        let prepared = prepare_local_attachment_open(&document.display().to_string()).unwrap();

        assert_eq!(prepared, std::fs::canonicalize(&document).unwrap());
        #[cfg(target_os = "macos")]
        assert!(crate::chat::attachments::quarantine::is_quarantined(
            &prepared
        ));
    }

    #[test]
    fn files_outside_attachment_access_are_refused() {
        let _app_data = ScopedAppDataDir::new("open-local-outside");
        let dir = std::env::temp_dir().join(format!("kordi-open-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let document = dir.join("report.pdf");
        std::fs::write(&document, b"%PDF-1.7").unwrap();

        assert_eq!(
            prepare_local_attachment_open(&document.display().to_string()).unwrap_err(),
            ATTACHMENT_ACCESS_DENIED
        );
        assert!(prepare_local_attachment_open(&dir.display().to_string()).is_err());
        assert!(prepare_local_attachment_open("   ").is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
