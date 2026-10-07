//! Builds the per-turn Mac-local connector runtime. Only owner-local turns
//! get one; cloud-lease turns, other people's requests, and turns with every
//! source off get `None`, so the harness registers no Mac-local tool.
use std::path::PathBuf;
use std::sync::Arc;

use kordi_core::error::KordiError;
use kordi_core::settings::MacLocalConnectorSettings;
use kordi_tools::mac_local::{MacLocalFn, MacLocalRuntime};

use crate::mac_local::{self, notification_center};

pub(super) fn build(owner_local: bool) -> Option<MacLocalRuntime> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    build_with(
        owner_local,
        &mac_local::load_settings(),
        notification_center::default_db_path(),
    )
}

/// Settings are read when the turn starts and again inside every call, so a
/// source turned off mid-turn stops answering immediately.
pub(super) fn build_with(
    owner_local: bool,
    settings: &MacLocalConnectorSettings,
    notification_db: Option<PathBuf>,
) -> Option<MacLocalRuntime> {
    if !owner_local {
        return None;
    }
    let notification_center_enabled =
        mac_local::notification_center_enabled(settings, notification_db.as_deref());
    if !settings.calendar && !settings.contacts && !notification_center_enabled {
        return None;
    }
    Some(MacLocalRuntime {
        read_events: blocking_reader(
            |settings| settings.calendar,
            |request| read_events(&request),
        ),
        read_reminders: blocking_reader(
            |settings| settings.calendar,
            |request| read_reminders(&request),
        ),
        search_contacts: Arc::new(|request| {
            Box::pin(async move {
                ensure_enabled(|settings| settings.contacts).await?;
                mac_local::contacts::search(request)
                    .await
                    .map_err(KordiError::Tool)
            })
        }),
        recent_notifications: {
            let path = notification_db.clone();
            blocking_reader(
                |settings| settings.notification_center,
                move |request| match path.as_deref() {
                    Some(path) => notification_center::read_recent(path, &request),
                    None => Err("Notification Center is unavailable on this Mac.".into()),
                },
            )
        },
        calendar_enabled: settings.calendar,
        contacts_enabled: settings.contacts,
        notification_center_enabled,
    })
}

const SOURCE_OFF: &str =
    "This Mac source was turned off in Settings > Connectors. This is not an empty result.";

async fn ensure_enabled(enabled: fn(&MacLocalConnectorSettings) -> bool) -> Result<(), KordiError> {
    let on = tokio::task::spawn_blocking(move || enabled(&mac_local::load_settings()))
        .await
        .unwrap_or(false);
    if on {
        Ok(())
    } else {
        Err(KordiError::Tool(SOURCE_OFF.into()))
    }
}

fn blocking_reader<R: Send + 'static>(
    enabled: fn(&MacLocalConnectorSettings) -> bool,
    read: impl Fn(R) -> Result<serde_json::Value, String> + Clone + Send + Sync + 'static,
) -> MacLocalFn<R> {
    Arc::new(move |request| {
        let read = read.clone();
        Box::pin(async move {
            ensure_enabled(enabled).await?;
            tokio::task::spawn_blocking(move || read(request))
                .await
                .map_err(|error| KordiError::Tool(error.to_string()))?
                .map_err(KordiError::Tool)
        })
    })
}

#[cfg(target_os = "macos")]
fn read_events(
    request: &kordi_tools::mac_local::MacCalendarEventsRequest,
) -> Result<serde_json::Value, String> {
    mac_local::eventkit::read_events(request)
}

#[cfg(not(target_os = "macos"))]
fn read_events(
    _request: &kordi_tools::mac_local::MacCalendarEventsRequest,
) -> Result<serde_json::Value, String> {
    Err("Calendar connectors are available on macOS.".into())
}

#[cfg(target_os = "macos")]
fn read_reminders(
    request: &kordi_tools::mac_local::MacRemindersRequest,
) -> Result<serde_json::Value, String> {
    mac_local::eventkit::read_reminders(request)
}

#[cfg(not(target_os = "macos"))]
fn read_reminders(
    _request: &kordi_tools::mac_local::MacRemindersRequest,
) -> Result<serde_json::Value, String> {
    Err("Reminders connectors are available on macOS.".into())
}

/// Exposed for tests that check the database path handling.
#[cfg(test)]
fn notification_flag(settings: &MacLocalConnectorSettings, path: &std::path::Path) -> bool {
    build_with(true, settings, Some(path.to_path_buf()))
        .is_some_and(|runtime| runtime.notification_center_enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kordi-mac-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings(calendar: bool, notification_center: bool) -> MacLocalConnectorSettings {
        MacLocalConnectorSettings {
            calendar,
            contacts: false,
            notification_center,
        }
    }

    #[test]
    fn notification_center_flag_is_false_when_the_setting_is_off() {
        let dir = temp_dir();
        let db = dir.join("db");
        std::fs::write(&db, b"SQLite format 3\0").unwrap();
        assert!(!notification_flag(&settings(true, false), &db));
        assert!(notification_flag(&settings(true, true), &db));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn notification_center_flag_is_false_when_the_database_is_unreadable() {
        let dir = temp_dir();
        // A missing file and a directory both stand in for a database that
        // Full Disk Access would otherwise make readable.
        assert!(!notification_flag(&settings(true, true), &dir.join("db")));
        assert!(!notification_flag(&settings(true, true), &dir));
        assert!(build_with(true, &settings(false, true), Some(dir.join("db"))).is_none());
        assert!(build_with(true, &settings(false, true), None).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mac_local_runtime_is_absent_off_owner_local_turns_and_when_all_sources_are_off() {
        assert!(build_with(false, &settings(true, false), None).is_none());
        assert!(build_with(true, &settings(false, false), None).is_none());
        let runtime = build_with(true, &settings(true, false), None).unwrap();
        assert!(runtime.calendar_enabled);
        assert!(!runtime.contacts_enabled);
        assert!(!runtime.notification_center_enabled);
        let names = kordi_tools::mac_local::mac_local_tools(Some(&runtime))
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                kordi_tools::mac_local::MAC_CALENDAR_READ_EVENTS,
                kordi_tools::mac_local::MAC_CALENDAR_READ_REMINDERS,
            ]
        );
    }
}
