use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
static REMINDER_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCalendar {
    id: String,
    title: String,
    allows_modifications: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenEvent {
    device_id: String,
    external_uid: String,
}
pub const CALENDAR_CHANGED_EVENT: &str = "digest-calendar-changed";
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
    /// Device-store identity and metadata. Present only on events read from the device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
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
/// Reports calendar permission; `request` prompts only while the system still reports "not determined".
#[tauri::command]
pub async fn desktop_digest_calendar_access(request: bool) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || native::access_status(request))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok("unavailable".into())
    }
}
/// Creates or updates one event in the device calendar and returns its device identity.
#[tauri::command]
///
/// `event.external_uid` identifies an occurrence of a repeating event, and `device_start_at`
/// is where the device copy currently starts; together they locate the exact occurrence.
pub async fn desktop_digest_calendar_write(
    event: CalendarEvent,
    device_id: Option<String>,
    calendar_id: Option<String>,
    device_start_at: Option<String>,
) -> Result<WrittenEvent, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            native::write(event, device_id, calendar_id, device_start_at)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (event, device_id, calendar_id, device_start_at);
        Err("Device calendars are unavailable.".into())
    }
}
/// Removes exactly one device event, or one occurrence of a repeating event.
#[tauri::command]
pub async fn desktop_digest_calendar_delete(
    device_id: String,
    external_uid: Option<String>,
    start_at: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            native::delete(device_id, external_uid, start_at)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (device_id, external_uid, start_at);
        Err("Device calendars are unavailable.".into())
    }
}
/// Starts forwarding device calendar changes to the webview as `digest-calendar-changed`. Idempotent.
#[tauri::command]
pub async fn desktop_digest_calendar_observe(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        native::observe(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
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
    use chrono::TimeZone;
    use objc2::{rc::Retained, runtime::Bool, sel, AnyThread};
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore,
        EKEventStoreChangedNotification, EKSpan,
    };
    use objc2_foundation::{
        NSArray, NSDate, NSError, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString,
    };
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri::Emitter;
    fn store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::init(EKEventStore::alloc()) }
    }
    fn status() -> EKAuthorizationStatus {
        unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) }
    }
    fn status_name(status: EKAuthorizationStatus) -> &'static str {
        if status == EKAuthorizationStatus::FullAccess {
            "granted"
        } else if status == EKAuthorizationStatus::WriteOnly {
            "writeOnly"
        } else if status == EKAuthorizationStatus::Denied {
            "denied"
        } else if status == EKAuthorizationStatus::Restricted {
            "restricted"
        } else {
            "notDetermined"
        }
    }
    pub fn access_status(request: bool) -> String {
        if request && status() == EKAuthorizationStatus::NotDetermined {
            let store = store();
            let _ = access(&store);
        }
        status_name(status()).into()
    }
    /// Stable identity for a device event. Occurrences of a repeating event share the item
    /// identifier, so the original occurrence date tells them apart and survives a reschedule.
    fn external_uid(event: &EKEvent) -> String {
        let base = unsafe {
            event
                .calendarItemExternalIdentifier()
                .unwrap_or_else(|| event.calendarItemIdentifier())
        }
        .to_string();
        if unsafe { event.hasRecurrenceRules() || event.isDetached() } {
            if let Some(date) = unsafe { event.occurrenceDate() } {
                return format!(
                    "device:{base}:occurrence:{}",
                    date.timeIntervalSince1970() as i64
                );
            }
        }
        format!("device:{base}")
    }
    fn local_midnight(date: chrono::NaiveDate) -> i64 {
        let naive = date.and_hms_opt(0, 0, 0).unwrap();
        chrono::Local
            .from_local_datetime(&naive)
            .earliest()
            .map(|d| d.timestamp())
            .unwrap_or_else(|| naive.and_utc().timestamp())
    }
    fn map_event(e: &EKEvent) -> Result<CalendarEvent, String> {
        unsafe {
            let start =
                chrono::DateTime::from_timestamp(e.startDate().timeIntervalSince1970() as i64, 0)
                    .ok_or("Invalid event start.")?;
            let end =
                chrono::DateTime::from_timestamp(e.endDate().timeIntervalSince1970() as i64, 0)
                    .ok_or("Invalid event end.")?;
            let all_day = e.isAllDay();
            let (start_at, end_at) = if all_day {
                // The device store ends an all-day event late on its last day; Kordi stores the exclusive next date.
                let start_local = start.with_timezone(&chrono::Local);
                let end_local = end.with_timezone(&chrono::Local);
                let mut last = end_local.date_naive();
                if end_local.time() != chrono::NaiveTime::MIN {
                    last = last.succ_opt().unwrap_or(last);
                }
                if last <= start_local.date_naive() {
                    last = start_local.date_naive().succ_opt().unwrap_or(last);
                }
                (
                    format!("{}T00:00:00Z", start_local.date_naive()),
                    format!("{last}T00:00:00Z"),
                )
            } else {
                (
                    start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                )
            };
            let uid = external_uid(e);
            let title = e.title().to_string();
            Ok(CalendarEvent {
                id: format!("calendar-{}", hex::encode(Sha256::digest(uid.as_bytes()))),
                title: if title.trim().is_empty() {
                    "Event".into()
                } else {
                    title
                },
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
                device_id: e.eventIdentifier().map(|s| s.to_string()),
                calendar_id: e.calendar().map(|c| c.calendarIdentifier().to_string()),
                modified_at: e.lastModifiedDate().and_then(|d| {
                    chrono::DateTime::from_timestamp(d.timeIntervalSince1970() as i64, 0)
                        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                }),
            })
        }
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
                    allows_modifications: c.allowsContentModifications(),
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
        events.iter().map(|e| map_event(&e)).collect()
    }
    fn writable_calendar(
        store: &EKEventStore,
        id: Option<String>,
    ) -> Result<Retained<EKCalendar>, String> {
        let chosen = id.and_then(|id| unsafe {
            store
                .calendarsForEntityType(EKEntityType::Event)
                .iter()
                .find(|c| {
                    c.calendarIdentifier().to_string() == id && c.allowsContentModifications()
                })
        });
        chosen
            .or_else(|| unsafe { store.defaultCalendarForNewEvents() })
            .filter(|c| unsafe { c.allowsContentModifications() })
            .ok_or_else(|| "No writable calendar is available on this Mac.".to_string())
    }
    /// The occurrence timestamp encoded in a device identity, when the event repeats.
    pub(super) fn occurrence_ts(uid: &str) -> Option<i64> {
        uid.rsplit_once(":occurrence:")
            .and_then(|(_, ts)| ts.parse().ok())
    }
    /// Finds exactly the event a device identity names. `eventWithIdentifier` returns the FIRST
    /// occurrence of a repeating event, so an occurrence is searched for by its original date,
    /// near both that date and where the device copy currently starts (it may have been moved).
    fn resolve(
        store: &EKEventStore,
        device_id: &str,
        uid: Option<&str>,
        current_start: Option<&str>,
    ) -> Option<Retained<EKEvent>> {
        let Some(ts) = uid.and_then(occurrence_ts) else {
            return unsafe { store.eventWithIdentifier(&NSString::from_str(device_id)) };
        };
        let mut anchors = vec![ts];
        if let Some(start) =
            current_start.and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        {
            if (start.timestamp() - ts).abs() > 86_400 {
                anchors.push(start.timestamp());
            }
        }
        anchors.into_iter().find_map(|anchor| unsafe {
            let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
                &NSDate::dateWithTimeIntervalSince1970((anchor - 2 * 86_400) as f64),
                &NSDate::dateWithTimeIntervalSince1970((anchor + 2 * 86_400) as f64),
                None,
            );
            store.eventsMatchingPredicate(&predicate).iter().find(|e| {
                e.eventIdentifier()
                    .is_some_and(|id| id.to_string() == device_id)
                    && e.occurrenceDate()
                        .is_some_and(|d| d.timeIntervalSince1970() as i64 == ts)
            })
        })
    }
    pub fn write(
        event: CalendarEvent,
        device_id: Option<String>,
        calendar_id: Option<String>,
        device_start_at: Option<String>,
    ) -> Result<WrittenEvent, String> {
        if status() != EKAuthorizationStatus::FullAccess {
            return Err("Calendar permission was revoked.".into());
        }
        let start = chrono::DateTime::parse_from_rfc3339(&event.start_at)
            .map_err(|_| "Invalid start date.")?;
        let end = event
            .end_at
            .as_deref()
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "Invalid end date.")
            })
            .transpose()?;
        let (start_ts, end_ts) = if event.all_day {
            let first = start.date_naive();
            let last = end
                .map(|d| d.date_naive())
                .filter(|d| *d > first)
                .unwrap_or_else(|| first.succ_opt().unwrap_or(first));
            // The device store expects the last day itself, not the exclusive boundary.
            (local_midnight(first), local_midnight(last) - 1)
        } else {
            let end_ts = end
                .map(|d| d.timestamp())
                .filter(|ts| *ts > start.timestamp())
                .unwrap_or(start.timestamp() + 30 * 60);
            (start.timestamp(), end_ts)
        };
        let store = store();
        let existing = match device_id.as_deref() {
            Some(id) => Some(
                resolve(
                    &store,
                    id,
                    event.external_uid.as_deref(),
                    device_start_at.as_deref(),
                )
                .ok_or("The device calendar event is no longer available.")?,
            ),
            None => None,
        };
        let target = match existing {
            Some(existing) => {
                if unsafe {
                    existing
                        .calendar()
                        .is_some_and(|c| !c.allowsContentModifications())
                } {
                    return Err("This device calendar is read-only.".into());
                }
                existing
            }
            None => {
                let created = unsafe { EKEvent::eventWithEventStore(&store) };
                let calendar = writable_calendar(&store, calendar_id)?;
                unsafe { created.setCalendar(Some(&calendar)) };
                created
            }
        };
        unsafe {
            target.setTitle(Some(&NSString::from_str(event.title.trim())));
            let notes = event.description.trim();
            let notes = (!notes.is_empty()).then(|| NSString::from_str(notes));
            target.setNotes(notes.as_deref());
            target.setAllDay(event.all_day);
            target.setStartDate(Some(&NSDate::dateWithTimeIntervalSince1970(
                start_ts as f64,
            )));
            target.setEndDate(Some(&NSDate::dateWithTimeIntervalSince1970(end_ts as f64)));
            store
                .saveEvent_span_commit_error(&target, EKSpan::ThisEvent, true)
                .map_err(|error| error.localizedDescription().to_string())?;
        }
        Ok(WrittenEvent {
            device_id: unsafe { target.eventIdentifier() }
                .map(|s| s.to_string())
                .ok_or("The saved event has no identifier.")?,
            external_uid: external_uid(&target),
        })
    }
    pub fn delete(
        device_id: String,
        external_uid: Option<String>,
        start_at: Option<String>,
    ) -> Result<(), String> {
        if status() != EKAuthorizationStatus::FullAccess {
            return Err("Calendar permission was revoked.".into());
        }
        let store = store();
        let Some(event) = resolve(
            &store,
            &device_id,
            external_uid.as_deref(),
            start_at.as_deref(),
        ) else {
            return Ok(());
        };
        unsafe { store.removeEvent_span_commit_error(&event, EKSpan::ThisEvent, true) }
            .map_err(|error| error.localizedDescription().to_string())
    }
    static OBSERVING: AtomicBool = AtomicBool::new(false);
    pub fn observe(app: tauri::AppHandle) {
        if OBSERVING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            // A live store is what makes the process receive change notifications at all.
            let store = store();
            let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
                let _ = app.emit(CALENDAR_CHANGED_EVENT, ());
            });
            let token = unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(EKEventStoreChangedNotification),
                    None,
                    None,
                    &block,
                )
            };
            // Intentionally kept for the process lifetime.
            std::mem::forget(token);
            std::mem::forget(block);
            std::mem::forget(store);
        });
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
