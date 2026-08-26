use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use mac_usernotifications::AuthorizationStatus;
#[cfg(target_os = "macos")]
use std::time::Duration;

use crate::window_lifecycle::MAIN_WINDOW_LABEL;

pub const MESSAGE_NOTIFICATION_OPENED_EVENT: &str = "kordi://message-notification-opened";

#[cfg(target_os = "macos")]
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMessageNotificationRequest {
    title: String,
    body: String,
    sound: bool,
    session_id: String,
    message_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMessageNotificationRoute {
    session_id: String,
    message_id: String,
}

#[cfg(target_os = "macos")]
fn permission_state_label(status: AuthorizationStatus) -> Result<&'static str, String> {
    match status {
        AuthorizationStatus::NotDetermined => Ok("default"),
        AuthorizationStatus::Denied => Ok("denied"),
        AuthorizationStatus::Authorized
        | AuthorizationStatus::Provisional
        | AuthorizationStatus::Ephemeral => Ok("granted"),
        AuthorizationStatus::Unknown => {
            Err("macOS returned an unknown notification permission state.".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
async fn native_notification_permission_state() -> Result<String, String> {
    let settings = tokio::time::timeout(
        PERMISSION_TIMEOUT,
        mac_usernotifications::get_notification_settings(),
    )
    .await
    .map_err(|_| "Notification permission check timed out.".to_string())?
    .map_err(|error| format!("Notification permission check failed: {error}"))?;
    permission_state_label(settings.authorization_status).map(str::to_string)
}

#[cfg(not(target_os = "macos"))]
async fn native_notification_permission_state() -> Result<String, String> {
    Ok("granted".to_string())
}

#[cfg(target_os = "macos")]
async fn request_native_notification_permission() -> Result<String, String> {
    let granted = tokio::time::timeout(PERMISSION_TIMEOUT, mac_usernotifications::request_auth())
        .await
        .map_err(|_| "Notification permission request timed out.".to_string())?
        .map_err(|error| format!("Notification permission request failed: {error}"))?;
    Ok(if granted { "granted" } else { "denied" }.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn request_native_notification_permission() -> Result<String, String> {
    Ok("granted".to_string())
}

#[tauri::command]
pub async fn desktop_notification_permission_state() -> Result<String, String> {
    native_notification_permission_state().await
}

#[tauri::command]
pub async fn desktop_request_notification_permission() -> Result<String, String> {
    request_native_notification_permission().await
}

#[tauri::command]
pub async fn desktop_show_message_notification(
    app: tauri::AppHandle,
    request: DesktopMessageNotificationRequest,
) -> Result<(), String> {
    if native_notification_permission_state().await? != "granted" {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || show_message_notification(app, request))
        .await
        .map_err(|error| error.to_string())?
}

fn show_message_notification(
    app: tauri::AppHandle,
    request: DesktopMessageNotificationRequest,
) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&request.title).body(&request.body);
    if request.sound {
        notification.sound_name("default");
    }

    let handle = notification.show().map_err(|error| error.to_string())?;
    let route = DesktopMessageNotificationRoute {
        session_id: request.session_id,
        message_id: request.message_id,
    };
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action == "__closed" {
                return;
            }
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit(MESSAGE_NOTIFICATION_OPENED_EVENT, route);
        });
    });
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use mac_usernotifications::AuthorizationStatus;

    use super::permission_state_label;

    #[test]
    fn maps_macos_notification_permission_states() {
        assert_eq!(
            permission_state_label(AuthorizationStatus::NotDetermined).unwrap(),
            "default"
        );
        assert_eq!(
            permission_state_label(AuthorizationStatus::Denied).unwrap(),
            "denied"
        );
        for status in [
            AuthorizationStatus::Authorized,
            AuthorizationStatus::Provisional,
            AuthorizationStatus::Ephemeral,
        ] {
            assert_eq!(permission_state_label(status).unwrap(), "granted");
        }
        assert!(permission_state_label(AuthorizationStatus::Unknown).is_err());
    }
}
