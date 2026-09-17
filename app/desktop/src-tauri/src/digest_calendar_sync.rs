//! Automatic device calendar sync on macOS: permission status, exact-occurrence writes and
//! deletes, and the EventKit change observer. Device reads live in `digest_calendar`.
use crate::digest_calendar::CalendarEvent;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenEvent {
    device_id: String,
    external_uid: String,
}
pub const CALENDAR_CHANGED_EVENT: &str = "digest-calendar-changed";

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

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::digest_calendar::native::{access, external_uid, store};
    use chrono::TimeZone;
    use objc2::rc::Retained;
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore,
        EKEventStoreChangedNotification, EKSpan,
    };
    use objc2_foundation::{NSDate, NSNotification, NSNotificationCenter, NSString};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Emitter;
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
    fn local_midnight(date: chrono::NaiveDate) -> i64 {
        let naive = date.and_hms_opt(0, 0, 0).unwrap();
        chrono::Local
            .from_local_datetime(&naive)
            .earliest()
            .map(|d| d.timestamp())
            .unwrap_or_else(|| naive.and_utc().timestamp())
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
