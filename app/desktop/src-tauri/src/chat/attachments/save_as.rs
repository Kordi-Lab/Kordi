use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

use super::{ensure_attachment_file_path, safe_attachment_name};

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[tauri::command]
pub async fn desktop_save_attachment_as(
    path: String,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let source = ensure_attachment_file_path(Path::new(&path))?;
    let fallback_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin");
    let requested_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name);
    let save_name = safe_attachment_name(requested_name);

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "POSIX path of (choose file name with prompt \"Save As\" default name {})",
            applescript_string(&save_name)
        );
        let output = tauri::async_runtime::spawn_blocking(move || {
            Command::new("osascript").arg("-e").arg(script).output()
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| format!("Unable to open the save dialog: {err}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("-128") {
                return Ok(None);
            }
            return Err(format!("Save dialog failed: {}", stderr.trim()));
        }
        let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if target.is_empty() {
            return Ok(None);
        }
        let target_path = PathBuf::from(&target);
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        std::fs::copy(&source, &target_path).map_err(|err| err.to_string())?;
        Ok(Some(target))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let target = super::unique_download_path(&save_name)?;
        std::fs::copy(&source, &target).map_err(|err| err.to_string())?;
        Ok(Some(target.display().to_string()))
    }
}
