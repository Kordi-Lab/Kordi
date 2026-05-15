use std::fs;
use std::path::Path;

/// Write raw bytes from a Scratch download (PNG/SVG/PDF/MD/DOCX) to the
/// user-chosen path. The frontend ([`features/scratch/download/save.ts`])
/// opens a native Save dialog first via `@tauri-apps/plugin-dialog`, then
/// invokes this command with the picked path. Tauri's webview ignores
/// `<a download>`, so the web shell still uses the anchor trick.
#[tauri::command]
pub async fn desktop_scratch_download_blob(
    path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(target, &bytes).map_err(|err| err.to_string())?;
    Ok(target.display().to_string())
}
