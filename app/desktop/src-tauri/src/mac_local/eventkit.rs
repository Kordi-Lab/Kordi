//! Shared EventKit access for the digest calendar sync and the Mac-local
//! Calendar and Reminders connector. EventKit objects stay on the calling
//! blocking thread; only owned values cross thread boundaries.
use std::time::Duration;

use kordi_tools::mac_local::{
    MacCalendarEventsRequest, MacRemindersRequest, MAX_EVENTS, MAX_REMINDERS,
};
use objc2::{rc::Retained, runtime::Bool, sel, AnyThread};
use objc2_event_kit::{
    EKAuthorizationStatus, EKCalendarItem, EKEntityType, EKEvent, EKEventStore, EKReminder,
};
use objc2_foundation::{NSArray, NSDate, NSDateComponentUndefined, NSError, NSObjectProtocol};
use serde_json::{json, Value};

use super::MacLocalPermission;

const MAX_ATTENDEES: usize = 50;

pub(crate) fn store() -> Retained<EKEventStore> {
    unsafe { EKEventStore::init(EKEventStore::alloc()) }
}

pub(crate) fn status(entity: EKEntityType) -> EKAuthorizationStatus {
    unsafe { EKEventStore::authorizationStatusForEntityType(entity) }
}

pub(crate) fn permission(entity: EKEntityType) -> MacLocalPermission {
    let status = status(entity);
    if status == EKAuthorizationStatus::FullAccess {
        MacLocalPermission::Granted
    } else if status == EKAuthorizationStatus::NotDetermined {
        MacLocalPermission::NotDetermined
    } else {
        // Denied, Restricted, and WriteOnly all block reads.
        MacLocalPermission::Denied
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AccessApi {
    FullAccess,
    ExistingLegacyGrant,
}

fn access_api(modern: bool, authorization: EKAuthorizationStatus) -> Result<AccessApi, String> {
    if modern {
        Ok(AccessApi::FullAccess)
    } else if authorization == EKAuthorizationStatus::FullAccess {
        Ok(AccessApi::ExistingLegacyGrant)
    } else {
        Err("Calendar connection requires macOS 14 or later. You can import ICS instead.".into())
    }
}

/// Initializes access on this store. New grants use the modern API; macOS
/// 12/13 can only reuse an existing grant through its legacy completion API.
pub(crate) fn request_full_access(
    store: &EKEventStore,
    entity: EKEntityType,
) -> Result<bool, String> {
    // A global grant does not initialize a newly created store. Complete the
    // access request on this instance even when macOS already granted access.
    let events = entity == EKEntityType::Event;
    let selector = if events {
        sel!(requestFullAccessToEventsWithCompletion:)
    } else {
        sel!(requestFullAccessToRemindersWithCompletion:)
    };
    let api = access_api(store.respondsToSelector(selector), status(entity))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let callback = block2::RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        if api == AccessApi::ExistingLegacyGrant {
            #[allow(deprecated)]
            store.requestAccessToEntityType_completion(entity, &*callback as *const _ as *mut _);
        } else if events {
            store.requestFullAccessToEventsWithCompletion(&*callback as *const _ as *mut _);
        } else {
            store.requestFullAccessToRemindersWithCompletion(&*callback as *const _ as *mut _);
        }
    }
    rx.recv_timeout(Duration::from_secs(120))
        .map_err(|_| "Calendar permission request timed out.".to_string())
}

/// Refreshes never ask for a new grant. Only an already-authorized entity may
/// initialize a store, and revocation during initialization prevents a read.
fn initialize_for_read<T>(
    authorization: impl Fn() -> EKAuthorizationStatus,
    create: impl FnOnce() -> T,
    initialize: impl FnOnce(&T) -> Result<bool, String>,
    denied: &str,
) -> Result<T, String> {
    if authorization() != EKAuthorizationStatus::FullAccess {
        return Err(denied.into());
    }
    let store = create();
    if !initialize(&store)? || authorization() != EKAuthorizationStatus::FullAccess {
        return Err(denied.into());
    }
    Ok(store)
}

fn authorized_store(entity: EKEntityType) -> Result<Retained<EKEventStore>, String> {
    let denied = if entity == EKEntityType::Event {
        "Calendar access is off. Allow Kordi in System Settings > Privacy & Security > Calendars."
    } else {
        "Reminders access is off. Allow Kordi in System Settings > Privacy & Security > Reminders."
    };
    initialize_for_read(
        || status(entity),
        store,
        |store| request_full_access(store, entity),
        denied,
    )
}

fn timestamp(date: &NSDate) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::from_timestamp(date.timeIntervalSince1970() as i64, 0)
        .map(|date| date.with_timezone(&chrono::Local))
}

fn calendar_name(item: &EKCalendarItem) -> String {
    unsafe { item.calendar() }
        .map(|calendar| unsafe { calendar.title() }.to_string())
        .unwrap_or_default()
}

fn map_event(event: &EKEvent) -> Option<(i64, Value)> {
    let start = timestamp(&*unsafe { event.startDate() })?;
    let end = timestamp(&*unsafe { event.endDate() })?;
    let all_day = unsafe { event.isAllDay() };
    let (start_text, end_text) = if all_day {
        // All-day events are reported as local dates; the end date is the last day.
        (start.date_naive().to_string(), end.date_naive().to_string())
    } else {
        (
            start.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            end.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        )
    };
    let item: &EKCalendarItem = event;
    let title = unsafe { item.title() }.to_string();
    let attendees = unsafe { item.attendees() }
        .map(|attendees| {
            attendees
                .iter()
                .filter_map(|attendee| unsafe { attendee.name() }.map(|name| name.to_string()))
                .filter(|name| !name.trim().is_empty())
                .take(MAX_ATTENDEES)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((
        start.timestamp(),
        json!({
            "title": if title.trim().is_empty() { "Event".to_string() } else { title },
            "start": start_text,
            "end": end_text,
            "allDay": all_day,
            "location": unsafe { item.location() }.map(|location| location.to_string()).filter(|location| !location.trim().is_empty()),
            "calendar": calendar_name(item),
            "attendees": attendees,
        }),
    ))
}

pub(crate) fn read_events(request: &MacCalendarEventsRequest) -> Result<Value, String> {
    let (from, to) = request.window().map_err(|error| error.to_string())?;
    let store = authorized_store(EKEntityType::Event)?;
    let calendars = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
    let selected = if request.calendar_ids.is_empty() {
        None
    } else {
        let selected: Vec<_> = calendars
            .iter()
            .filter(|calendar| {
                request
                    .calendar_ids
                    .contains(&unsafe { calendar.calendarIdentifier() }.to_string())
            })
            .collect();
        if selected.is_empty() {
            return Err("None of the requested calendars exist on this Mac.".into());
        }
        Some(NSArray::from_retained_slice(&selected))
    };
    let predicate = unsafe {
        store.predicateForEventsWithStartDate_endDate_calendars(
            &NSDate::dateWithTimeIntervalSince1970(from.timestamp() as f64),
            &NSDate::dateWithTimeIntervalSince1970(to.timestamp() as f64),
            selected.as_deref(),
        )
    };
    let mut events: Vec<_> = unsafe { store.eventsMatchingPredicate(&predicate) }
        .iter()
        .filter_map(|event| map_event(&event))
        .collect();
    events.sort_by_key(|(start, _)| *start);
    let truncated = events.len() > MAX_EVENTS;
    events.truncate(MAX_EVENTS);
    Ok(json!({
        "events": events.into_iter().map(|(_, event)| event).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

fn due_text(reminder: &EKReminder) -> Option<String> {
    let components = unsafe { reminder.dueDateComponents() }?;
    let defined = |value: isize| (value != NSDateComponentUndefined).then_some(value);
    let (year, month, day) = (
        defined(components.year())?,
        defined(components.month())?,
        defined(components.day())?,
    );
    let date = chrono::NaiveDate::from_ymd_opt(year as i32, month as u32, day as u32)?;
    match (defined(components.hour()), defined(components.minute())) {
        (Some(hour), minute) => Some(format!("{date}T{hour:02}:{:02}", minute.unwrap_or(0))),
        (None, _) => Some(date.to_string()),
    }
}

fn map_reminder(reminder: &EKReminder) -> Value {
    let item: &EKCalendarItem = reminder;
    let title = unsafe { item.title() }.to_string();
    json!({
        "title": if title.trim().is_empty() { "Reminder".to_string() } else { title },
        "due": due_text(reminder),
        "completed": unsafe { reminder.isCompleted() },
        "list": calendar_name(item),
    })
}

pub(crate) fn read_reminders(request: &MacRemindersRequest) -> Result<Value, String> {
    let store = authorized_store(EKEntityType::Reminder)?;
    let predicate = unsafe {
        if request.include_completed {
            store.predicateForRemindersInCalendars(None)
        } else {
            store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(
                None, None, None,
            )
        }
    };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<Value>>();
    let callback = block2::RcBlock::new(move |reminders: *mut NSArray<EKReminder>| {
        // The completion runs on an EventKit queue; map to owned JSON there.
        let mapped = unsafe { reminders.as_ref() }
            .map(|reminders| {
                reminders
                    .iter()
                    .map(|reminder| map_reminder(&reminder))
                    .collect()
            })
            .unwrap_or_default();
        let _ = tx.send(mapped);
    });
    let fetch = unsafe { store.fetchRemindersMatchingPredicate_completion(&predicate, &callback) };
    let mut reminders = match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(reminders) => reminders,
        Err(_) => {
            unsafe { store.cancelFetchRequest(&fetch) };
            return Err("Reading reminders timed out.".into());
        }
    };
    // Open reminders first, then by due date; reminders without a due date last.
    reminders.sort_by_key(|reminder| {
        (
            reminder["completed"].as_bool().unwrap_or(false),
            reminder["due"].is_null(),
            reminder["due"].as_str().unwrap_or_default().to_string(),
        )
    });
    let truncated = reminders.len() > MAX_REMINDERS;
    reminders.truncate(MAX_REMINDERS);
    Ok(json!({ "reminders": reminders, "truncated": truncated }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn legacy_api_is_only_used_for_an_existing_full_access_grant() {
        assert_eq!(
            access_api(false, EKAuthorizationStatus::FullAccess),
            Ok(AccessApi::ExistingLegacyGrant)
        );
        for authorization in [
            EKAuthorizationStatus::FullAccess,
            EKAuthorizationStatus::NotDetermined,
            EKAuthorizationStatus::Denied,
            EKAuthorizationStatus::Restricted,
            EKAuthorizationStatus::WriteOnly,
        ] {
            assert_eq!(access_api(true, authorization), Ok(AccessApi::FullAccess));
            if authorization != EKAuthorizationStatus::FullAccess {
                assert!(access_api(false, authorization).is_err());
            }
        }
    }

    #[test]
    fn granted_access_initializes_each_store_before_it_can_be_read() {
        let operations = RefCell::new(Vec::new());
        for _ in 0..2 {
            let initialized = initialize_for_read(
                || EKAuthorizationStatus::FullAccess,
                || {
                    operations.borrow_mut().push("create");
                    Cell::new(false)
                },
                |store| {
                    operations.borrow_mut().push("initialize");
                    store.set(true);
                    Ok(true)
                },
                "Access is off",
            )
            .unwrap();
            assert!(initialized.get());
            operations.borrow_mut().push("read");
        }
        assert_eq!(
            *operations.borrow(),
            [
                "create",
                "initialize",
                "read",
                "create",
                "initialize",
                "read"
            ]
        );
    }

    #[test]
    fn refresh_never_initializes_a_store_or_requests_access_without_full_access() {
        for status in [
            EKAuthorizationStatus::NotDetermined,
            EKAuthorizationStatus::Denied,
            EKAuthorizationStatus::Restricted,
            EKAuthorizationStatus::WriteOnly,
        ] {
            let result = initialize_for_read(
                || status,
                || panic!("A refresh must not create an unauthorized store"),
                |_: &()| panic!("A refresh must never request a new grant"),
                "Access is off",
            );
            assert_eq!(result, Err("Access is off".into()));
        }
    }

    #[test]
    fn initialization_failure_or_revocation_prevents_returning_a_readable_store() {
        let status = Cell::new(EKAuthorizationStatus::FullAccess);
        let revoked = initialize_for_read(
            || status.get(),
            || (),
            |_| {
                status.set(EKAuthorizationStatus::Denied);
                Ok(true)
            },
            "Access is off",
        );
        assert_eq!(revoked, Err("Access is off".into()));
        for result in [Ok(false), Err("Initialization failed".into())] {
            let expected = if result.is_err() {
                "Initialization failed"
            } else {
                "Access is off"
            };
            assert_eq!(
                initialize_for_read(
                    || EKAuthorizationStatus::FullAccess,
                    || (),
                    |_| result,
                    "Access is off",
                ),
                Err(expected.into())
            );
        }
    }
}
