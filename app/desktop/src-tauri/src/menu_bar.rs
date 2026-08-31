use tauri::AppHandle;

#[cfg(target_os = "macos")]
use crate::window_lifecycle::show_and_focus_main_window;
#[cfg(target_os = "macos")]
use tauri::tray::TrayIconEvent;
#[cfg(any(target_os = "macos", test))]
use tauri::tray::{MouseButton, MouseButtonState};

#[cfg(target_os = "macos")]
const MENU_BAR_ID: &str = "kordi-menu-bar";

fn unread_title(count: u64) -> String {
    match count {
        0 => String::new(),
        1..=99 => count.to_string(),
        _ => "99+".to_string(),
    }
}

fn unread_tooltip(count: u64) -> String {
    match count {
        0 => "Kordi".to_string(),
        1 => "Kordi, 1 unread message".to_string(),
        _ => format!("Kordi, {count} unread messages"),
    }
}

#[cfg(any(target_os = "macos", test))]
fn should_open_main_window(button: MouseButton, state: MouseButtonState) -> bool {
    button == MouseButton::Left && state == MouseButtonState::Up
}

#[cfg(target_os = "macos")]
pub(crate) fn setup(app: &tauri::App) -> tauri::Result<()> {
    tauri::tray::TrayIconBuilder::with_id(MENU_BAR_ID)
        .icon(tauri::include_image!("./icons/menu-bar-template.png"))
        .icon_as_template(true)
        .tooltip("Kordi")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if should_open_main_window(button, button_state) {
                    show_and_focus_main_window(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn setup(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_set_menu_bar_unread_count(app: AppHandle, count: u64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let tray = app
            .tray_by_id(MENU_BAR_ID)
            .ok_or_else(|| "Kordi menu bar item is unavailable.".to_string())?;
        tray.set_title(Some(unread_title(count)))
            .map_err(|error| error.to_string())?;
        tray.set_tooltip(Some(unread_tooltip(count)))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, count);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{should_open_main_window, unread_title, unread_tooltip};
    use tauri::tray::{MouseButton, MouseButtonState};

    #[test]
    fn formats_menu_bar_unread_state() {
        assert_eq!(unread_title(0), "");
        assert_eq!(unread_title(1), "1");
        assert_eq!(unread_title(99), "99");
        assert_eq!(unread_title(100), "99+");
        assert_eq!(unread_tooltip(0), "Kordi");
        assert_eq!(unread_tooltip(1), "Kordi, 1 unread message");
        assert_eq!(unread_tooltip(12), "Kordi, 12 unread messages");
    }

    #[test]
    fn opens_main_window_only_on_primary_click_release() {
        assert!(should_open_main_window(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        assert!(!should_open_main_window(
            MouseButton::Right,
            MouseButtonState::Up
        ));
        assert!(!should_open_main_window(
            MouseButton::Left,
            MouseButtonState::Down
        ));
    }
}
