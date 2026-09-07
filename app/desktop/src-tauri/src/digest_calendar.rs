use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
static REMINDER_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
pub struct DeviceCalendar {
    id: String,
    title: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub external_uid: Option<String>,
    pub revision: i64,
}

#[tauri::command]
pub async fn desktop_digest_calendars() -> Result<Vec<DeviceCalendar>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(native::calendars)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Device calendars are available on macOS. Import an ICS file instead.".into())
    }
}
#[tauri::command]
pub async fn desktop_digest_calendar_events(
    calendar_ids: Vec<String>,
    from: String,
    to: String,
) -> Result<Vec<CalendarEvent>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || native::events(calendar_ids, from, to))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (calendar_ids, from, to);
        Err("Device calendars are unavailable.".into())
    }
}
#[tauri::command]
pub async fn desktop_digest_reminders(
    account_id: String,
    events: Vec<CalendarEvent>,
    request_permission: bool,
) -> Result<String, String> {
    let current =
        crate::cloud_session::cloud_session_load()?.ok_or("Sign in to schedule reminders.")?;
    if current.account_id != account_id {
        return Err("The reminder account changed.".into());
    }
    #[cfg(target_os = "macos")]
    {
        use mac_usernotifications::{AuthorizationStatus, Notification};
        if request_permission {
            mac_usernotifications::request_auth()
                .await
                .map_err(|e| e.to_string())?;
        }
        let settings = mac_usernotifications::get_notification_settings()
            .await
            .map_err(|e| e.to_string())?;
        let granted = matches!(
            settings.authorization_status,
            AuthorizationStatus::Authorized
                | AuthorizationStatus::Provisional
                | AuthorizationStatus::Ephemeral
        );
        let prefix = format!(
            "kordi-calendar:{}:",
            hex::encode(Sha256::digest(account_id.as_bytes()))
        );
        // One OS notification queue per app: serialize scheduling and account cleanup.
        let _guard = REMINDER_QUEUE.lock().await;
        if crate::cloud_session::cloud_session_load()?
            .is_none_or(|session| session.account_id != account_id)
        {
            return Err("The reminder account changed.".into());
        }
        let pending = mac_usernotifications::get_pending_notification_ids().await;
        let now = chrono::Utc::now();
        let mut future: Vec<_> = events
            .into_iter()
            .filter_map(|event| {
                let at =
                    chrono::DateTime::parse_from_rfc3339(event.reminder_at.as_deref()?).ok()?;
                let delay = at.signed_duration_since(now).to_std().ok()?;
                let id = format!(
                    "{prefix}{}:{}",
                    hex::encode(Sha256::digest(event.id.as_bytes())),
                    event.revision
                );
                Some((id, delay))
            })
            .collect();
        future.sort_by_key(|(_, delay)| *delay);
        // Native notification queues are bounded. Refreshing the calendar schedules the next batch.
        future.truncate(60);
        for id in &pending {
            if id.starts_with("kordi-calendar:")
                && (!granted || !future.iter().any(|(wanted, _)| wanted == id))
            {
                mac_usernotifications::cancel_pending(id).await;
            }
        }
        if !granted {
            return Ok("denied".into());
        }
        for (id, delay) in future {
            if !pending.contains(&id) {
                Notification::new()
                    .id(&id)
                    .title("Kordi calendar")
                    .message("You have a calendar reminder.")
                    .default_sound()
                    .schedule_in(delay)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok("granted".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (events, request_permission);
        Ok("unavailable".into())
    }
}
pub async fn clear_reminders(account_id: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        if mac_usernotifications::check_bundle().is_err() {
            return;
        }
        let _guard = REMINDER_QUEUE.lock().await;
        let prefix = account_id
            .map(|id| {
                format!(
                    "kordi-calendar:{}:",
                    hex::encode(Sha256::digest(id.as_bytes()))
                )
            })
            .unwrap_or_else(|| "kordi-calendar:".into());
        for id in mac_usernotifications::get_pending_notification_ids().await {
            if id.starts_with(&prefix) {
                mac_usernotifications::cancel_pending(&id).await;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = account_id;
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{rc::Retained, runtime::Bool, sel, AnyThread};
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore};
    use objc2_foundation::{NSArray, NSDate, NSError, NSObjectProtocol};
    use std::time::Duration;
    fn store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::init(EKEventStore::alloc()) }
    }
    fn access(store: &EKEventStore) -> Result<(), String> {
        unsafe {
            if EKEventStore::authorizationStatusForEntityType(EKEntityType::Event)
                == EKAuthorizationStatus::FullAccess
            {
                return Ok(());
            }
            if !store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
                return Err(
                    "Calendar connection requires macOS 14 or later. You can import ICS instead."
                        .into(),
                );
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let callback = block2::RcBlock::new(move |granted: Bool, _error: *mut NSError| {
                let _ = tx.send(granted.as_bool());
            });
            store.requestFullAccessToEventsWithCompletion(&*callback as *const _ as *mut _);
            if !rx
                .recv_timeout(Duration::from_secs(120))
                .map_err(|_| "Calendar permission request timed out.")?
            {
                return Err("Calendar access is off. Allow Kordi in Privacy & Security → Calendars, or import ICS.".into());
            }
        }
        Ok(())
    }
    pub fn calendars() -> Result<Vec<DeviceCalendar>, String> {
        let store = store();
        access(&store)?;
        // EventKit objects stay on this blocking thread; only owned strings cross the boundary.
        Ok(unsafe { store.calendarsForEntityType(EKEntityType::Event) }
            .iter()
            .map(|c| unsafe {
                DeviceCalendar {
                    id: c.calendarIdentifier().to_string(),
                    title: c.title().to_string(),
                }
            })
            .collect())
    }
    pub fn events(
        ids: Vec<String>,
        from: String,
        to: String,
    ) -> Result<Vec<CalendarEvent>, String> {
        if ids.is_empty() || ids.len() > 50 {
            return Err("Choose between one and fifty calendars.".into());
        }
        let start =
            chrono::DateTime::parse_from_rfc3339(&from).map_err(|_| "Invalid start date.")?;
        let end = chrono::DateTime::parse_from_rfc3339(&to).map_err(|_| "Invalid end date.")?;
        if end <= start || end.signed_duration_since(start) > chrono::Duration::days(366) {
            return Err("Choose a range of up to one year.".into());
        }
        let store = store();
        if unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) }
            != EKAuthorizationStatus::FullAccess
        {
            return Err("Calendar permission was revoked.".into());
        }
        let selected: Vec<_> = unsafe { store.calendarsForEntityType(EKEntityType::Event) }
            .iter()
            .filter(|c| ids.contains(&unsafe { c.calendarIdentifier() }.to_string()))
            .collect();
        if selected.len() != ids.len() {
            return Err("One of the selected calendars is no longer available.".into());
        }
        let selected = NSArray::from_retained_slice(&selected);
        let predicate = unsafe {
            store.predicateForEventsWithStartDate_endDate_calendars(
                &NSDate::dateWithTimeIntervalSince1970(start.timestamp() as f64),
                &NSDate::dateWithTimeIntervalSince1970(end.timestamp() as f64),
                Some(&selected),
            )
        };
        let events = unsafe { store.eventsMatchingPredicate(&predicate) };
        if events.len() > 1000 {
            return Err("More than 1,000 events. Choose fewer calendars.".into());
        }
        events
            .iter()
            .map(|e| unsafe {
                let start = chrono::DateTime::from_timestamp(
                    e.startDate().timeIntervalSince1970() as i64,
                    0,
                )
                .ok_or("Invalid event start.")?;
                let end =
                    chrono::DateTime::from_timestamp(e.endDate().timeIntervalSince1970() as i64, 0)
                        .ok_or("Invalid event end.")?;
                let all_day = e.isAllDay();
                let format = |date: chrono::DateTime<chrono::Utc>| {
                    if all_day {
                        format!(
                            "{}T00:00:00Z",
                            date.with_timezone(&chrono::Local).date_naive()
                        )
                    } else {
                        date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                    }
                };
                let start_at = format(start);
                let end_at = format(end);
                let uid = format!(
                    "device:{}:{}",
                    e.calendarItemExternalIdentifier()
                        .unwrap_or_else(|| e.calendarItemIdentifier()),
                    start_at
                );
                Ok(CalendarEvent {
                    id: format!("calendar-{}", hex::encode(Sha256::digest(uid.as_bytes()))),
                    title: e.title().to_string(),
                    start_at,
                    end_at: Some(end_at),
                    all_day,
                    description: e
                        .notes()
                        .map(|n| n.to_string())
                        .unwrap_or_default()
                        .chars()
                        .take(5000)
                        .collect(),
                    source_ids: vec![],
                    external_uid: Some(uid),
                    revision: 0,
                    reminder_at: None,
                })
            })
            .collect()
    }
}

#[tauri::command]
pub async fn desktop_digest_fetch_ics(url: String) -> Result<String, String> {
    use futures_util::StreamExt;
    let url = url.replacen("webcal://", "https://", 1);
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Enter a valid calendar link.")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Use an HTTPS calendar link without embedded login credentials.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not prepare the calendar download.")?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "Could not download the calendar. Choose its ICS file instead.")?;
    if !response.status().is_success() {
        return Err("This link is unavailable or redirects to another page. Use the final ICS link or choose the file.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > 1_000_000)
    {
        return Err("Choose a calendar smaller than 1 MB.".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Calendar download was interrupted.")?;
        if bytes.len() + chunk.len() > 1_000_000 {
            return Err("Choose a calendar smaller than 1 MB.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "The calendar is not UTF-8 text.".into())
}
