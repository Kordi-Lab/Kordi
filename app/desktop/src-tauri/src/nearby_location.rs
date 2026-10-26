//! One foreground location fix, requested by the Nearby screen. Never logs coordinates.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationFix {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    timestamp: f64,
}

#[cfg(target_os = "macos")]
mod macos;

#[tauri::command]
pub async fn desktop_nearby_location(app: tauri::AppHandle) -> Result<LocationFix, String> {
    #[cfg(target_os = "macos")]
    {
        macos::request(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Location is unavailable on this device. Use another signed-in device.".into())
    }
}

/// Permission setup does not publish a location or enable Nearby.
#[tauri::command]
pub async fn desktop_nearby_location_permission(
    app: tauri::AppHandle,
    request: bool,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let status = macos::permission(app.clone()).await?;
        if request && status == "not_determined" {
            let result = macos::request(app.clone()).await;
            let status = macos::permission(app).await?;
            if status == "not_determined" {
                result?;
            }
            Ok(status)
        } else {
            Ok(status)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok("unavailable".into())
    }
}
