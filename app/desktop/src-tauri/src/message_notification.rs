use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::window_lifecycle::MAIN_WINDOW_LABEL;

pub const MESSAGE_NOTIFICATION_OPENED_EVENT: &str = "kordi://message-notification-opened";

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

#[tauri::command]
pub fn desktop_show_message_notification(
    app: tauri::AppHandle,
    request: DesktopMessageNotificationRequest,
) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&request.title).body(&request.body);
    if request.sound {
        notification.sound_name("default");
    }

    #[cfg(target_os = "macos")]
    {
        let application = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        };
        notify_rust::set_application(application).map_err(|error| error.to_string())?;
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
