//! Mac-local connectors: Calendar and Reminders (EventKit), Contacts
//! (AppleScript), and the experimental Notification Center reader. Each source
//! is off until the person turns it on from Settings > Connectors, and every
//! read stays on this Mac; nothing read here is saved.
use std::path::Path;

use kordi_core::settings::{MacLocalConnectorSettings, Settings};
use serde::Serialize;
use serde_json::{json, Value};

pub(crate) mod contacts;
#[cfg(target_os = "macos")]
pub(crate) mod eventkit;
pub(crate) mod notification_center;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MacLocalPermission {
    Granted,
    Denied,
    NotDetermined,
    FullDiskAccessMissing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MacLocalSource {
    Calendar,
    Contacts,
    NotificationCenter,
}

impl MacLocalSource {
    fn parse(source: &str) -> Result<Self, String> {
        match source {
            "calendar" => Ok(Self::Calendar),
            "contacts" => Ok(Self::Contacts),
            "notification_center" => Ok(Self::NotificationCenter),
            _ => Err(format!("Unknown Mac source: {source}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MacLocalSourceState {
    pub enabled: bool,
    pub permission: MacLocalPermission,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MacLocalConnectorsState {
    pub calendar: MacLocalSourceState,
    pub contacts: MacLocalSourceState,
    pub notification_center: MacLocalSourceState,
}

pub(crate) fn load_settings() -> MacLocalConnectorSettings {
    Settings::load_global().connectors.mac_local
}

fn set_source(settings: &mut Settings, source: MacLocalSource, enabled: bool) {
    let mac_local = &mut settings.connectors.mac_local;
    match source {
        MacLocalSource::Calendar => mac_local.calendar = enabled,
        MacLocalSource::Contacts => mac_local.contacts = enabled,
        MacLocalSource::NotificationCenter => mac_local.notification_center = enabled,
    }
}

/// Updates one source in an existing settings file. A file that cannot be
/// read or parsed is an error; it is never replaced with defaults.
fn update_enabled(
    load: impl FnOnce() -> std::io::Result<Settings>,
    save: impl FnOnce(&Settings) -> std::io::Result<()>,
    source: MacLocalSource,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = load().map_err(|error| {
        format!("Could not read Kordi settings, so the change was not saved: {error}")
    })?;
    set_source(&mut settings, source, enabled);
    save(&settings).map_err(|error| error.to_string())
}

fn save_enabled(source: MacLocalSource, enabled: bool) -> Result<(), String> {
    update_enabled(
        || {
            let _ = kordi_core::config::migrate_legacy_global_config();
            Settings::load_from_file_result(&kordi_core::config::global_settings_path())
        },
        Settings::save_global,
        source,
        enabled,
    )
}

pub(crate) fn calendar_permission() -> MacLocalPermission {
    #[cfg(target_os = "macos")]
    {
        eventkit::permission(objc2_event_kit::EKEntityType::Event)
    }
    #[cfg(not(target_os = "macos"))]
    {
        MacLocalPermission::Unavailable
    }
}

pub(crate) fn notification_center_permission(db_path: Option<&Path>) -> MacLocalPermission {
    if !cfg!(target_os = "macos") {
        return MacLocalPermission::Unavailable;
    }
    match db_path {
        Some(path) if notification_center::is_readable(path) => MacLocalPermission::Granted,
        _ => MacLocalPermission::FullDiskAccessMissing,
    }
}

/// The Notification Center tool exists only when the setting is on and the
/// database is readable (Full Disk Access present).
pub(crate) fn notification_center_enabled(
    settings: &MacLocalConnectorSettings,
    db_path: Option<&Path>,
) -> bool {
    settings.notification_center && db_path.is_some_and(notification_center::is_readable)
}

fn current_state() -> MacLocalConnectorsState {
    let settings = load_settings();
    let db_path = notification_center::default_db_path();
    MacLocalConnectorsState {
        calendar: MacLocalSourceState {
            enabled: settings.calendar,
            permission: calendar_permission(),
        },
        contacts: MacLocalSourceState {
            enabled: settings.contacts,
            permission: contacts::permission(),
        },
        notification_center: MacLocalSourceState {
            enabled: settings.notification_center,
            permission: notification_center_permission(db_path.as_deref()),
        },
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_mac_local_connectors_state() -> Result<MacLocalConnectorsState, String> {
    blocking(current_state).await
}

/// Turning a source on asks macOS for its permission where an in-app prompt
/// exists. Full Disk Access cannot be requested in-app, so Notification
/// Center turns on only when the database is already readable.
#[tauri::command]
pub async fn desktop_mac_local_connectors_set_enabled(
    source: String,
    enabled: bool,
) -> Result<MacLocalConnectorsState, String> {
    let source = MacLocalSource::parse(&source)?;
    if enabled {
        let permission = match source {
            MacLocalSource::Calendar => {
                #[cfg(target_os = "macos")]
                {
                    blocking(|| {
                        use objc2_event_kit::EKEntityType;
                        let store = eventkit::store();
                        let _ = eventkit::request_full_access(&store, EKEntityType::Event);
                        let _ = eventkit::request_full_access(&store, EKEntityType::Reminder);
                    })
                    .await?;
                    calendar_permission()
                }
                #[cfg(not(target_os = "macos"))]
                return Err("Calendar connectors are available on macOS.".into());
            }
            MacLocalSource::Contacts => {
                if !cfg!(target_os = "macos") {
                    return Err("Contacts connectors are available on macOS.".into());
                }
                contacts::probe().await.0
            }
            MacLocalSource::NotificationCenter => {
                let db_path = notification_center::default_db_path();
                let permission = notification_center_permission(db_path.as_deref());
                if permission != MacLocalPermission::Granted {
                    return Err("Notification Center needs Full Disk Access. Allow Kordi in System Settings > Privacy & Security > Full Disk Access, then check again.".into());
                }
                permission
            }
        };
        if !should_persist_enable(permission) {
            // Refused or unanswered: keep the source off and report the
            // missing permission instead of leaving it on with no access.
            return blocking(current_state).await;
        }
    }
    blocking(move || save_enabled(source, enabled)).await??;
    blocking(current_state).await
}

/// A source is saved as on only after macOS granted its permission.
fn should_persist_enable(permission: MacLocalPermission) -> bool {
    permission == MacLocalPermission::Granted
}

#[tauri::command]
pub async fn desktop_mac_local_connectors_recheck() -> Result<MacLocalConnectorsState, String> {
    blocking(current_state).await
}

/// A small bounded sample for the settings page. Contacts reports only a count.
#[tauri::command]
pub async fn desktop_mac_local_connectors_preview(source: String) -> Result<Value, String> {
    let source = MacLocalSource::parse(&source)?;
    let settings = blocking(load_settings).await?;
    match source {
        MacLocalSource::Calendar => {
            if !settings.calendar {
                return Err("Turn on Calendar and Reminders first.".into());
            }
            #[cfg(target_os = "macos")]
            {
                blocking(|| {
                    let now = chrono::Local::now().fixed_offset();
                    let request = kordi_tools::mac_local::MacCalendarEventsRequest {
                        from: now.to_rfc3339(),
                        to: (now + chrono::Duration::days(7)).to_rfc3339(),
                        calendar_ids: Vec::new(),
                    };
                    let mut events = eventkit::read_events(&request)?;
                    let mut reminders = eventkit::read_reminders(
                        &kordi_tools::mac_local::MacRemindersRequest::default(),
                    )
                    .unwrap_or_else(|_| json!({ "reminders": [] }));
                    let events = kordi_tools::mac_local::cap_items(events.take(), "events", 3);
                    let reminders =
                        kordi_tools::mac_local::cap_items(reminders.take(), "reminders", 3);
                    Ok(json!({ "events": events["events"], "reminders": reminders["reminders"] }))
                })
                .await?
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("Calendar connectors are available on macOS.".into())
            }
        }
        MacLocalSource::Contacts => {
            if !settings.contacts {
                return Err("Turn on Contacts first.".into());
            }
            match contacts::probe().await {
                (MacLocalPermission::Granted, count) => Ok(json!({ "count": count })),
                _ => Err(contacts::ContactsError::PermissionDenied.message()),
            }
        }
        MacLocalSource::NotificationCenter => {
            if !settings.notification_center {
                return Err("Turn on Notification Center first.".into());
            }
            let path = notification_center::default_db_path()
                .ok_or("Notification Center is unavailable on this Mac.")?;
            let mut value = blocking(move || {
                notification_center::read_recent(
                    &path,
                    &kordi_tools::mac_local::MacNotificationsRequest {
                        hours: 24,
                        limit: 3,
                    },
                )
            })
            .await??;
            // The settings page shows the source and title only.
            if let Some(items) = value["notifications"].as_array_mut() {
                for item in items {
                    if let Some(object) = item.as_object_mut() {
                        object.remove("body");
                        object.remove("subtitle");
                    }
                }
            }
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_local_source_names_match_the_settings_keys() {
        assert_eq!(
            MacLocalSource::parse("calendar"),
            Ok(MacLocalSource::Calendar)
        );
        assert_eq!(
            MacLocalSource::parse("contacts"),
            Ok(MacLocalSource::Contacts)
        );
        assert_eq!(
            MacLocalSource::parse("notification_center"),
            Ok(MacLocalSource::NotificationCenter)
        );
        assert!(MacLocalSource::parse("mail").is_err());
        let state = MacLocalSourceState {
            enabled: true,
            permission: MacLocalPermission::FullDiskAccessMissing,
        };
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            json!({ "enabled": true, "permission": "full_disk_access_missing" })
        );
    }

    #[test]
    fn mac_local_enable_is_saved_only_when_permission_is_granted() {
        assert!(should_persist_enable(MacLocalPermission::Granted));
        for permission in [
            MacLocalPermission::Denied,
            MacLocalPermission::NotDetermined,
            MacLocalPermission::FullDiskAccessMissing,
            MacLocalPermission::Unavailable,
        ] {
            assert!(!should_persist_enable(permission), "{permission:?}");
        }
    }

    #[test]
    fn mac_local_save_never_replaces_unreadable_settings_with_defaults() {
        let dir = std::env::temp_dir().join(format!("kordi-mac-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        let error = update_enabled(
            || Settings::load_from_file_result(&path),
            |settings| settings.save_to_file(&path),
            MacLocalSource::Contacts,
            true,
        )
        .unwrap_err();
        assert!(error.contains("not saved"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");

        std::fs::write(&path, "{}").unwrap();
        update_enabled(
            || Settings::load_from_file_result(&path),
            |settings| settings.save_to_file(&path),
            MacLocalSource::Contacts,
            true,
        )
        .unwrap();
        let saved = Settings::load_from_file_result(&path).unwrap();
        assert!(saved.connectors.mac_local.contacts);
        assert!(!saved.connectors.mac_local.calendar);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
