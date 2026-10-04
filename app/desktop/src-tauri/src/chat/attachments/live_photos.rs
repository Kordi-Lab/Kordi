#[tauri::command]
pub async fn desktop_chat_prepare_live_photos(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        if paths.len() > 16 {
            return Err("Select at most eight Live Photo pairs at a time.".into());
        }
        let directory = super::attachment_storage_dir()?;
        for path in &paths {
            let source = super::ensure_attachment_file_path(std::path::Path::new(path))?;
            // Pairs come from the native picker or a paste, so the same access
            // rules as attaching a single file apply.
            super::authorize_requested_path(&source, || {
                super::pasteboard::general_pasteboard_file_paths(&app)
            })
            .await?;
        }
        tokio::task::spawn_blocking(move || {
            use std::ffi::{c_char, CStr, CString};
            unsafe extern "C" {
                fn kordi_prepare_live_photos(input: *const c_char) -> *mut c_char;
                fn kordi_free_live_photo_result(result: *mut c_char);
            }
            let input = CString::new(
                serde_json::json!({ "paths": paths, "directory": directory }).to_string(),
            )
            .map_err(|_| "Invalid Live Photo paths".to_string())?;
            // The Swift bridge returns an owned, null-terminated UTF-8 JSON string.
            let result = unsafe { kordi_prepare_live_photos(input.as_ptr()) };
            if result.is_null() {
                return Err("Could not prepare Live Photos.".into());
            }
            let json = unsafe { CStr::from_ptr(result) }.to_bytes().to_vec();
            unsafe { kordi_free_live_photo_result(result) };
            let value: serde_json::Value = serde_json::from_slice(&json)
                .map_err(|_| "Invalid Live Photo result".to_string())?;
            if let Some(error) = value["error"].as_str() {
                return Err(error.to_string());
            }
            Ok(value["photos"].clone())
        })
        .await
        .map_err(|_| "Live Photo preparation stopped unexpectedly.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paths);
        Ok(serde_json::json!([]))
    }
}
