//! Slack: read and post in the channels the person chose for Kordi.
//!
//! The chosen channels live in the connector settings as
//! `{ "channels": ["C123", ...] }`. Tools refuse any other channel.

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};

use super::http::{cap_text, limit_arg, list_at, required_str, str_arg, ProviderHttp};
use super::{
    ConnectorSecret, ConnectorToolDescriptor, OAuth2ConnectorProvider, PolledEvent, ProviderError,
    ServiceAdapter, ServiceProvider, MAX_POLL_EVENTS, POLL_PAGE_SIZE, SLACK,
};
use crate::connectors::models::ConnectorToolGroup;

pub const API_BASE: &str = "https://slack.com/api";
const MAX_CHANNELS: usize = 50;
/// Channels polled per connector per run.
const MAX_POLLED_CHANNELS: usize = 20;
const MAX_POST_CHARS: usize = 4000;
const MESSAGE_TEXT_CHARS: usize = 2000;

pub const READ_CHANNEL: &str = "slack_read_channel";
pub const POST: &str = "slack_post";

static TOOLS: [ConnectorToolDescriptor; 2] = [
    ConnectorToolDescriptor {
        name: READ_CHANNEL,
        group: ConnectorToolGroup::Read,
        description: "Read recent messages in one of the Slack channels you chose for Kordi.",
    },
    ConnectorToolDescriptor {
        name: POST,
        group: ConnectorToolGroup::Act,
        description: "Post a message as you in one of the Slack channels you chose for Kordi.",
    },
];

pub fn input_schema(tool: &str) -> Option<Value> {
    Some(match tool {
        READ_CHANNEL => json!({
            "type": "object",
            "properties": {
                "channel": { "type": "string", "description": "Channel id, for example C0123ABCD." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
            },
            "required": ["channel"],
            "additionalProperties": false
        }),
        POST => json!({
            "type": "object",
            "properties": {
                "channel": { "type": "string" },
                "text": { "type": "string", "maxLength": MAX_POST_CHARS },
                "threadTs": { "type": "string", "description": "Reply in this thread." }
            },
            "required": ["channel", "text"],
            "additionalProperties": false
        }),
        _ => return None,
    })
}

pub struct SlackAdapter {
    api: ProviderHttp,
}

pub fn provider(http: reqwest::Client, api_base: Option<String>) -> ServiceProvider<SlackAdapter> {
    ServiceProvider::new(
        OAuth2ConnectorProvider::new(&SLACK, http.clone()),
        SlackAdapter {
            api: ProviderHttp::new(http, api_base.unwrap_or_else(|| API_BASE.into()), &[]),
        },
    )
}

/// A Slack channel id: public (C) or private (G). Direct messages (D) are
/// refused: the connector does not ask for `im:history`.
pub fn is_channel_id(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value.starts_with(['C', 'G'])
        && value
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// The chosen channels from validated settings.
pub fn chosen_channels(settings: &Value) -> Vec<String> {
    settings
        .get("channels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Validates `{ "channels": [...] }`: known keys only, at most 50 distinct
/// channel ids.
pub fn validate_slack_settings(settings: &Value) -> Result<Value, String> {
    let map = settings.as_object().ok_or("Settings must be an object.")?;
    if let Some(key) = map.keys().find(|key| key.as_str() != "channels") {
        return Err(format!("Unknown Slack setting {key:?}."));
    }
    let raw = match map.get("channels") {
        None => return Ok(json!({ "channels": [] })),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("channels must be a list of channel ids.".into()),
    };
    let mut channels: Vec<String> = Vec::new();
    for item in raw {
        let id = item
            .as_str()
            .map(str::trim)
            .filter(|id| is_channel_id(id))
            .ok_or("Each channel must be a Slack channel id such as C0123ABCD.")?;
        if !channels.iter().any(|existing| existing == id) {
            channels.push(id.to_string());
        }
    }
    if channels.len() > MAX_CHANNELS {
        return Err(format!("Choose at most {MAX_CHANNELS} channels."));
    }
    Ok(json!({ "channels": channels }))
}

fn chosen_channel<'a>(args: &'a Value, settings: &Value) -> Result<&'a str, ProviderError> {
    let channel = required_str(args, "channel", 32)?;
    if !chosen_channels(settings).iter().any(|id| id == channel) {
        return Err(ProviderError::invalid(
            "This channel is not one you chose for Kordi. Add it in Connectors settings.",
        ));
    }
    Ok(channel)
}

/// Slack answers HTTP 200 with `ok: false`; credential errors become
/// `Unauthorized` so the broker can refresh or ask for a reconnect.
fn slack_ok(body: Value) -> Result<Value, ProviderError> {
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(body);
    }
    let error = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error");
    match error {
        "invalid_auth" | "not_authed" | "token_revoked" | "token_expired" | "account_inactive" => {
            Err(ProviderError::Unauthorized)
        }
        "channel_not_found" | "not_in_channel" | "is_archived" => Err(ProviderError::invalid(
            "Slack could not use that channel. Check that you are a member.",
        )),
        other => Err(ProviderError::Request(cap_text(other, 80))),
    }
}

/// Escapes `<!`, so posted text cannot become a `<!channel>`, `<!here>`, or
/// `<!everyone>` broadcast. Slack decodes `&lt;` back to `<` for display.
pub fn escape_broadcasts(text: &str) -> String {
    text.replace("<!", "&lt;!")
}

/// Slack `ts` ("1712345678.000200") as a time.
pub fn ts_time(ts: &str) -> Option<DateTime<Utc>> {
    let (seconds, micros) = ts.split_once('.').unwrap_or((ts, "0"));
    let seconds = seconds.parse::<i64>().ok()?;
    let micros = format!("{micros:0<6}").get(..6)?.parse::<u32>().ok()?;
    Utc.timestamp_opt(seconds, micros * 1000).single()
}

fn message_summary(message: &Value) -> Value {
    json!({
        "ts": message.get("ts").cloned().unwrap_or(Value::Null),
        "user": message.get("user").cloned().unwrap_or(Value::Null),
        "text": message
            .get("text")
            .and_then(Value::as_str)
            .map(|text| cap_text(text, MESSAGE_TEXT_CHARS)),
        "threadTs": message.get("thread_ts").cloned().unwrap_or(Value::Null),
        "replyCount": message.get("reply_count").cloned().unwrap_or(Value::Null),
    })
}

impl SlackAdapter {
    async fn history(
        &self,
        token: &str,
        channel: &str,
        limit: u64,
        oldest: Option<String>,
        cursor: Option<String>,
    ) -> Result<Value, ProviderError> {
        let mut query = vec![
            ("channel", channel.to_string()),
            ("limit", limit.to_string()),
        ];
        if let Some(oldest) = oldest {
            query.push(("oldest", oldest));
        }
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor));
        }
        slack_ok(
            self.api
                .get("/conversations.history", token, &query)
                .await?,
        )
    }
}

#[async_trait]
impl ServiceAdapter for SlackAdapter {
    fn tools(&self) -> &'static [ConnectorToolDescriptor] {
        &TOOLS
    }

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        settings: &Value,
    ) -> Result<Value, ProviderError> {
        let token = secret.access_token.as_str();
        match tool {
            READ_CHANNEL => {
                let channel = chosen_channel(args, settings)?;
                let limit = limit_arg(args, "limit", 20, 50);
                let body = self.history(token, channel, limit, None, None).await?;
                let messages = list_at(&body, "/messages")
                    .map(message_summary)
                    .collect::<Vec<_>>();
                Ok(json!({ "channel": channel, "messages": messages }))
            }
            POST => {
                let channel = chosen_channel(args, settings)?;
                let text = escape_broadcasts(required_str(args, "text", MAX_POST_CHARS)?);
                let mut body = json!({ "channel": channel, "text": text });
                if let Some(thread) = str_arg(args, "threadTs") {
                    if ts_time(thread).is_none() {
                        return Err(ProviderError::invalid("threadTs is not a Slack timestamp."));
                    }
                    body["thread_ts"] = json!(thread);
                }
                let posted = slack_ok(self.api.post("/chat.postMessage", token, &body).await?)?;
                Ok(json!({
                    "channel": posted.get("channel").cloned().unwrap_or(json!(channel)),
                    "ts": posted.get("ts").cloned().unwrap_or(Value::Null),
                }))
            }
            _ => Err(ProviderError::UnknownTool),
        }
    }

    fn validate_settings(&self, settings: &Value) -> Option<Result<Value, String>> {
        Some(validate_slack_settings(settings))
    }

    /// Messages since `since` in the chosen channels, page by page, at most
    /// [`MAX_POLL_EVENTS`] in all. Polling runs also with the Events API
    /// configured: Slack names one authorization per event, so other
    /// people's connectors in the same workspace only see it here. Both
    /// paths use the same external id, so nothing is stored twice.
    async fn poll(
        &self,
        secret: &ConnectorSecret,
        since: DateTime<Utc>,
        settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        let oldest = format!(
            "{}.{:06}",
            since.timestamp(),
            since.timestamp_subsec_micros()
        );
        let mut events = Vec::new();
        for channel in chosen_channels(settings).iter().take(MAX_POLLED_CHANNELS) {
            let mut cursor = None;
            loop {
                if events.len() >= MAX_POLL_EVENTS {
                    return Ok(events);
                }
                let body = self
                    .history(
                        &secret.access_token,
                        channel,
                        POLL_PAGE_SIZE as u64,
                        Some(oldest.clone()),
                        cursor.take(),
                    )
                    .await?;
                for message in list_at(&body, "/messages") {
                    if let Some(event) = message_event(channel, message) {
                        events.push(event);
                    }
                }
                cursor = body
                    .pointer("/response_metadata/next_cursor")
                    .and_then(Value::as_str)
                    .filter(|next| !next.is_empty() && next.len() <= 512)
                    .map(str::to_string);
                let more = body.get("has_more").and_then(Value::as_bool) == Some(true);
                if !more || cursor.is_none() {
                    break;
                }
            }
        }
        events.truncate(MAX_POLL_EVENTS);
        Ok(events)
    }
}

fn message_event(channel: &str, message: &Value) -> Option<PolledEvent> {
    let ts = message.get("ts").and_then(Value::as_str)?;
    let occurred_at = ts_time(ts)?;
    let mut payload = message_summary(message);
    payload["channel"] = json!(channel);
    Some(PolledEvent {
        kind: "message".into(),
        external_id: format!("message:{channel}:{ts}"),
        occurred_at,
        payload,
    })
}
