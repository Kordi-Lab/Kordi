//! Read-only Mac-local connectors (Calendar, Reminders, Contacts, Notification
//! Center). The host supplies the readers per turn and only for owner-local
//! runs on macOS; every tool fails closed when the runtime is absent.
use std::{future::Future, pin::Pin, sync::Arc};

use kordi_core::error::KordiResult;
use serde_json::Value;

use crate::Tool;

mod limits;
#[cfg(test)]
mod tests;
mod tools;

pub use limits::*;
pub use tools::*;

pub const MAC_CALENDAR_READ_EVENTS: &str = "mac_calendar_read_events";
pub const MAC_CALENDAR_READ_REMINDERS: &str = "mac_calendar_read_reminders";
pub const MAC_CONTACTS_SEARCH: &str = "mac_contacts_search";
pub const MAC_NOTIFICATION_CENTER_RECENT: &str = "mac_notification_center_recent";

/// Every Mac-local tool name, in registration order.
pub const MAC_LOCAL_TOOL_NAMES: [&str; 4] = [
    MAC_CALENDAR_READ_EVENTS,
    MAC_CALENDAR_READ_REMINDERS,
    MAC_CONTACTS_SEARCH,
    MAC_NOTIFICATION_CENTER_RECENT,
];

pub const MAC_LOCAL_UNAVAILABLE: &str = "This Mac source is not available for this request. Mac-local connectors work only in a chat the owner started on their own Mac, with the source turned on in Settings > Connectors and allowed in macOS Privacy & Security. This is not an empty result; do not claim that no data exists.";

pub type MacLocalFuture = Pin<Box<dyn Future<Output = KordiResult<Value>> + Send>>;
pub type MacLocalFn<R> = Arc<dyn Fn(R) -> MacLocalFuture + Send + Sync>;

/// Host-supplied readers. Each returns a JSON object with one array field
/// (`events`, `reminders`, `contacts`, `notifications`). The tools cap the
/// arrays again, so a reader bug cannot widen what reaches the model.
#[derive(Clone)]
pub struct MacLocalRuntime {
    pub read_events: MacLocalFn<MacCalendarEventsRequest>,
    pub read_reminders: MacLocalFn<MacRemindersRequest>,
    pub search_contacts: MacLocalFn<MacContactsSearchRequest>,
    pub recent_notifications: MacLocalFn<MacNotificationsRequest>,
    /// Calendar and Reminders are turned on in Connectors.
    pub calendar_enabled: bool,
    /// Contacts is turned on in Connectors.
    pub contacts_enabled: bool,
    /// Experimental reader: on in Connectors and Full Disk Access present.
    pub notification_center_enabled: bool,
}

/// Tools the harness registers for this runtime. Empty without a runtime, and
/// a source that is off contributes no tool.
pub fn mac_local_tools(runtime: Option<&MacLocalRuntime>) -> Vec<Box<dyn Tool>> {
    let Some(runtime) = runtime else {
        return Vec::new();
    };
    let mut tools: Vec<Box<dyn Tool>> = Vec::new();
    if runtime.calendar_enabled {
        tools.push(Box::new(MacCalendarReadEventsTool));
        tools.push(Box::new(MacCalendarReadRemindersTool));
    }
    if runtime.contacts_enabled {
        tools.push(Box::new(MacContactsSearchTool));
    }
    if runtime.notification_center_enabled {
        tools.push(Box::new(MacNotificationCenterRecentTool));
    }
    tools
}
