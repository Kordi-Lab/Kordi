//! Google Calendar: list events, answer invitations, and create events.
//!
//! Calendar push notifications are plain HTTPS channel callbacks, not
//! Pub/Sub, so this connector uses the polling fallback for events.

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use reqwest::Method;
use serde_json::{json, Value};

use super::http::{
    cap_text, list_at, path_segment, required_str, str_arg, text_at, ProviderHttp, MAX_LIST_ITEMS,
    MAX_TEXT_CHARS,
};
use super::{
    ConnectorSecret, ConnectorToolDescriptor, OAuth2ConnectorProvider, PolledEvent, ProviderError,
    ServiceAdapter, ServiceProvider, GOOGLE_CALENDAR,
};
use crate::connectors::models::ConnectorToolGroup;

pub const API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const MAX_WINDOW_DAYS: i64 = 31;
const DEFAULT_WINDOW_DAYS: i64 = 7;
const MAX_ATTENDEES: usize = 50;

pub const LIST_EVENTS: &str = "calendar_list_events";
pub const RESPOND: &str = "calendar_respond";
pub const CREATE_EVENT: &str = "calendar_create_event";

static TOOLS: [ConnectorToolDescriptor; 3] = [
    ConnectorToolDescriptor {
        name: LIST_EVENTS,
        group: ConnectorToolGroup::Read,
        description:
            "List calendar events in a time window of at most 31 days (default: the next 7 days).",
    },
    ConnectorToolDescriptor {
        name: RESPOND,
        group: ConnectorToolGroup::Act,
        description: "Accept, decline, or tentatively accept an invitation.",
    },
    ConnectorToolDescriptor {
        name: CREATE_EVENT,
        group: ConnectorToolGroup::Act,
        description: "Create a calendar event and invite attendees.",
    },
];

pub fn input_schema(tool: &str) -> Option<Value> {
    Some(match tool {
        LIST_EVENTS => json!({
            "type": "object",
            "properties": {
                "timeMin": { "type": "string", "description": "RFC 3339 start; default now." },
                "timeMax": { "type": "string", "description": "RFC 3339 end; at most 31 days after timeMin." },
                "calendarId": { "type": "string", "description": "Default: primary." },
                "query": { "type": "string", "description": "Free-text filter." }
            },
            "additionalProperties": false
        }),
        RESPOND => json!({
            "type": "object",
            "properties": {
                "eventId": { "type": "string" },
                "response": { "type": "string", "enum": ["accepted", "declined", "tentative"] },
                "calendarId": { "type": "string" }
            },
            "required": ["eventId", "response"],
            "additionalProperties": false
        }),
        CREATE_EVENT => json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string" },
                "start": { "type": "string", "description": "RFC 3339 start." },
                "end": { "type": "string", "description": "RFC 3339 end." },
                "timeZone": { "type": "string", "description": "IANA time zone." },
                "description": { "type": "string" },
                "location": { "type": "string" },
                "attendees": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_ATTENDEES },
                "calendarId": { "type": "string" }
            },
            "required": ["summary", "start", "end"],
            "additionalProperties": false
        }),
        _ => return None,
    })
}

pub struct GoogleCalendarAdapter {
    api: ProviderHttp,
}

pub fn provider(
    http: reqwest::Client,
    api_base: Option<String>,
) -> ServiceProvider<GoogleCalendarAdapter> {
    ServiceProvider::new(
        OAuth2ConnectorProvider::new(&GOOGLE_CALENDAR, http.clone()),
        GoogleCalendarAdapter {
            api: ProviderHttp::new(http, api_base.unwrap_or_else(|| API_BASE.into()), &[]),
        },
    )
}

fn time_arg(args: &Value, key: &str) -> Result<Option<DateTime<Utc>>, ProviderError> {
    str_arg(args, key)
        .map(|raw| {
            DateTime::parse_from_rfc3339(raw)
                .map(|time| time.with_timezone(&Utc))
                .map_err(|_| ProviderError::invalid(format!("{key} must be an RFC 3339 time.")))
        })
        .transpose()
}

/// The list window: default now to 7 days; at most 31 days long.
pub fn list_window(
    args: &Value,
    now: DateTime<Utc>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), ProviderError> {
    let start = time_arg(args, "timeMin")?.unwrap_or(now);
    let end =
        time_arg(args, "timeMax")?.unwrap_or(start + ChronoDuration::days(DEFAULT_WINDOW_DAYS));
    if end <= start {
        return Err(ProviderError::invalid("timeMax must be after timeMin."));
    }
    if end - start > ChronoDuration::days(MAX_WINDOW_DAYS) {
        return Err(ProviderError::invalid(
            "The time window can be at most 31 days.",
        ));
    }
    Ok((start, end))
}

fn calendar_path(args: &Value) -> Result<String, ProviderError> {
    let id = str_arg(args, "calendarId").unwrap_or("primary");
    if id.len() > 256 {
        return Err(ProviderError::invalid("calendarId is too long."));
    }
    Ok(format!("/calendars/{}", path_segment(id)))
}

fn self_response(event: &Value) -> Value {
    list_at(event, "/attendees")
        .find(|attendee| attendee.get("self").and_then(Value::as_bool) == Some(true))
        .and_then(|attendee| attendee.get("responseStatus").cloned())
        .unwrap_or(Value::Null)
}

fn event_summary(event: &Value) -> Value {
    json!({
        "id": event.get("id").cloned().unwrap_or(Value::Null),
        "summary": text_at(event, "/summary", 300),
        "status": event.get("status").cloned().unwrap_or(Value::Null),
        "start": event.pointer("/start/dateTime").or_else(|| event.pointer("/start/date")).cloned(),
        "end": event.pointer("/end/dateTime").or_else(|| event.pointer("/end/date")).cloned(),
        "location": text_at(event, "/location", 300),
        "organizer": event.pointer("/organizer/email").cloned().unwrap_or(Value::Null),
        "attendeeCount": event.get("attendees").and_then(Value::as_array).map(Vec::len),
        "myResponse": self_response(event),
        "url": event.get("htmlLink").cloned().unwrap_or(Value::Null),
    })
}

impl GoogleCalendarAdapter {
    async fn list_events(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let (start, end) = list_window(args, Utc::now())?;
        let mut query = vec![
            ("timeMin", start.to_rfc3339()),
            ("timeMax", end.to_rfc3339()),
            ("singleEvents", "true".to_string()),
            ("orderBy", "startTime".to_string()),
            ("maxResults", MAX_LIST_ITEMS.to_string()),
        ];
        if let Some(text) = str_arg(args, "query") {
            query.push(("q", cap_text(text, 200)));
        }
        let path = format!("{}/events", calendar_path(args)?);
        let body = self.api.get(&path, token, &query).await?;
        let events = list_at(&body, "/items").map(|event| {
            let mut summary = event_summary(event);
            summary["description"] = json!(text_at(event, "/description", MAX_TEXT_CHARS));
            summary
        });
        Ok(json!({
            "timeMin": start.to_rfc3339(),
            "timeMax": end.to_rfc3339(),
            "events": events.collect::<Vec<_>>(),
        }))
    }

    async fn respond(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let event_id = required_str(args, "eventId", 1024)?;
        let response = required_str(args, "response", 20)?;
        if !matches!(response, "accepted" | "declined" | "tentative") {
            return Err(ProviderError::invalid(
                "response must be accepted, declined, or tentative.",
            ));
        }
        let path = format!("{}/events/{}", calendar_path(args)?, path_segment(event_id));
        let event = self.api.get(&path, token, &[]).await?;
        let mut attendees = event
            .get("attendees")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let me = attendees
            .iter_mut()
            .find(|attendee| attendee.get("self").and_then(Value::as_bool) == Some(true))
            .ok_or_else(|| ProviderError::invalid("You are not invited to this event."))?;
        me["responseStatus"] = json!(response);
        let patched = self
            .api
            .send(
                Method::PATCH,
                &path,
                token,
                &[("sendUpdates", "all".into())],
                Some(&json!({ "attendees": attendees })),
            )
            .await?;
        Ok(json!({
            "eventId": event_id,
            "summary": text_at(&patched, "/summary", 300),
            "myResponse": self_response(&patched),
        }))
    }

    async fn create_event(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let summary = required_str(args, "summary", 300)?;
        let start =
            time_arg(args, "start")?.ok_or_else(|| ProviderError::invalid("start is required."))?;
        let end =
            time_arg(args, "end")?.ok_or_else(|| ProviderError::invalid("end is required."))?;
        if end <= start {
            return Err(ProviderError::invalid("end must be after start."));
        }
        let time_zone = str_arg(args, "timeZone");
        let at = |time: DateTime<Utc>| match time_zone {
            Some(zone) => json!({ "dateTime": time.to_rfc3339(), "timeZone": zone }),
            None => json!({ "dateTime": time.to_rfc3339() }),
        };
        let mut body = json!({ "summary": summary, "start": at(start), "end": at(end) });
        if let Some(description) = str_arg(args, "description") {
            body["description"] = json!(cap_text(description, 8000));
        }
        if let Some(location) = str_arg(args, "location") {
            body["location"] = json!(cap_text(location, 500));
        }
        if let Some(list) = args.get("attendees").and_then(Value::as_array) {
            if list.len() > MAX_ATTENDEES {
                return Err(ProviderError::invalid("At most 50 attendees."));
            }
            let mut attendees = Vec::new();
            for email in list {
                let email = email
                    .as_str()
                    .map(str::trim)
                    .filter(|email| super::gmail::is_email(email))
                    .ok_or_else(|| ProviderError::invalid("Each attendee must be an email."))?;
                attendees.push(json!({ "email": email }));
            }
            body["attendees"] = json!(attendees);
        }
        let path = format!("{}/events", calendar_path(args)?);
        let created = self
            .api
            .send(
                Method::POST,
                &path,
                token,
                &[("sendUpdates", "all".into())],
                Some(&body),
            )
            .await?;
        Ok(event_summary(&created))
    }
}

#[async_trait]
impl ServiceAdapter for GoogleCalendarAdapter {
    fn tools(&self) -> &'static [ConnectorToolDescriptor] {
        &TOOLS
    }

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        _settings: &Value,
    ) -> Result<Value, ProviderError> {
        let token = secret.access_token.as_str();
        match tool {
            LIST_EVENTS => self.list_events(args, token).await,
            RESPOND => self.respond(args, token).await,
            CREATE_EVENT => self.create_event(args, token).await,
            _ => Err(ProviderError::UnknownTool),
        }
    }

    async fn account_identity(
        &self,
        secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        let calendar = self
            .api
            .get("/calendars/primary", &secret.access_token, &[])
            .await?;
        Ok(calendar
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase))
    }

    async fn poll(
        &self,
        secret: &ConnectorSecret,
        since: DateTime<Utc>,
        _settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        let query = [
            ("updatedMin", since.to_rfc3339()),
            ("singleEvents", "true".to_string()),
            ("orderBy", "updated".to_string()),
            ("maxResults", MAX_LIST_ITEMS.to_string()),
        ];
        let body = self
            .api
            .get("/calendars/primary/events", &secret.access_token, &query)
            .await?;
        Ok(list_at(&body, "/items")
            .filter_map(|event| {
                let id = event.get("id").and_then(Value::as_str)?;
                let updated = event.get("updated").and_then(Value::as_str)?;
                let occurred_at = DateTime::parse_from_rfc3339(updated).ok()?;
                Some(PolledEvent {
                    kind: "event.updated".into(),
                    external_id: format!("event:{id}:{updated}"),
                    occurred_at: occurred_at.with_timezone(&Utc),
                    payload: event_summary(event),
                })
            })
            .collect())
    }
}
