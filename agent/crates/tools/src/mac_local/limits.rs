use kordi_core::error::{KordiError, KordiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_EVENTS: usize = 200;
pub const MAX_EVENT_WINDOW_DAYS: i64 = 31;
pub const MAX_CALENDAR_IDS: usize = 50;
pub const MAX_REMINDERS: usize = 200;
pub const MAX_CONTACTS: usize = 50;
pub const DEFAULT_CONTACTS: usize = 10;
pub const MIN_CONTACT_QUERY_CHARS: usize = 2;
pub const MAX_CONTACT_QUERY_CHARS: usize = 100;
pub const MAX_NOTIFICATION_HOURS: u32 = 24;
pub const MAX_NOTIFICATIONS: usize = 100;
pub const DEFAULT_NOTIFICATIONS: usize = 50;
pub const MAX_NOTIFICATION_BODY_CHARS: usize = 500;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacCalendarEventsRequest {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub calendar_ids: Vec<String>,
}

impl MacCalendarEventsRequest {
    /// Parses and bounds the window: `to` after `from`, at most 31 days.
    pub fn window(
        &self,
    ) -> KordiResult<(
        chrono::DateTime<chrono::FixedOffset>,
        chrono::DateTime<chrono::FixedOffset>,
    )> {
        let parse = |value: &str, label: &str| {
            chrono::DateTime::parse_from_rfc3339(value.trim()).map_err(|_| {
                KordiError::Tool(format!(
                    "{label} must be an ISO 8601 instant with a timezone offset"
                ))
            })
        };
        let from = parse(&self.from, "from")?;
        let to = parse(&self.to, "to")?;
        if to <= from {
            return Err(KordiError::Tool("to must be after from".into()));
        }
        if to.signed_duration_since(from) > chrono::Duration::days(MAX_EVENT_WINDOW_DAYS) {
            return Err(KordiError::Tool(format!(
                "Choose a window of at most {MAX_EVENT_WINDOW_DAYS} days"
            )));
        }
        if self.calendar_ids.len() > MAX_CALENDAR_IDS {
            return Err(KordiError::Tool(format!(
                "Choose at most {MAX_CALENDAR_IDS} calendars"
            )));
        }
        Ok((from, to))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacRemindersRequest {
    #[serde(default)]
    pub include_completed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacContactsSearchRequest {
    pub query: String,
    #[serde(default = "default_contacts_limit")]
    pub limit: usize,
}

fn default_contacts_limit() -> usize {
    DEFAULT_CONTACTS
}

impl MacContactsSearchRequest {
    pub fn validate(&self) -> KordiResult<()> {
        let query = self.query.trim();
        // osascript treats a leading dash as an option, so a query must never
        // start with one even though the host also passes `--`.
        if query.starts_with('-') {
            return Err(KordiError::Tool("query must not start with '-'".into()));
        }
        let chars = query.chars().count();
        if chars < MIN_CONTACT_QUERY_CHARS {
            return Err(KordiError::Tool(format!(
                "query must have at least {MIN_CONTACT_QUERY_CHARS} characters; contacts cannot be listed in full"
            )));
        }
        if chars > MAX_CONTACT_QUERY_CHARS {
            return Err(KordiError::Tool(format!(
                "query must have at most {MAX_CONTACT_QUERY_CHARS} characters"
            )));
        }
        if self.limit == 0 || self.limit > MAX_CONTACTS {
            return Err(KordiError::Tool(format!(
                "limit must be between 1 and {MAX_CONTACTS}"
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacNotificationsRequest {
    #[serde(default = "default_notification_hours")]
    pub hours: u32,
    #[serde(default = "default_notifications_limit")]
    pub limit: usize,
}

fn default_notification_hours() -> u32 {
    MAX_NOTIFICATION_HOURS
}

fn default_notifications_limit() -> usize {
    DEFAULT_NOTIFICATIONS
}

impl MacNotificationsRequest {
    pub fn validate(&self) -> KordiResult<()> {
        if self.hours == 0 || self.hours > MAX_NOTIFICATION_HOURS {
            return Err(KordiError::Tool(format!(
                "hours must be between 1 and {MAX_NOTIFICATION_HOURS}"
            )));
        }
        if self.limit == 0 || self.limit > MAX_NOTIFICATIONS {
            return Err(KordiError::Tool(format!(
                "limit must be between 1 and {MAX_NOTIFICATIONS}"
            )));
        }
        Ok(())
    }
}

/// Truncates `value[key]` to `max` entries and marks the result as truncated.
pub fn cap_items(mut value: Value, key: &str, max: usize) -> Value {
    if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut)
        && items.len() > max
    {
        items.truncate(max);
        value["truncated"] = json!(true);
    }
    value
}

/// Shortens a string to at most `max` characters, including the trailing
/// ellipsis, on a character boundary.
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept = max.saturating_sub(1);
    let end = text
        .char_indices()
        .nth(kept)
        .map_or(text.len(), |(index, _)| index);
    format!("{}\u{2026}", &text[..end])
}

pub(super) fn cap_notification_bodies(mut value: Value) -> Value {
    if let Some(items) = value.get_mut("notifications").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(body) = item.get("body").and_then(Value::as_str) {
                let capped = truncate_chars(body, MAX_NOTIFICATION_BODY_CHARS);
                item["body"] = json!(capped);
            }
        }
    }
    value
}
