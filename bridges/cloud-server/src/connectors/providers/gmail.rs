//! Gmail: search, read one message, and send mail as the person.

use async_trait::async_trait;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};

use super::http::{
    cap_text, limit_arg, list_at, path_segment, required_str, str_arg, ProviderHttp, MAX_TEXT_CHARS,
};
use super::{
    ConnectorHooks, ConnectorSecret, ConnectorToolDescriptor, OAuth2ConnectorProvider, PolledEvent,
    ProviderError, ServiceAdapter, ServiceProvider, GMAIL, MAX_POLL_EVENTS, POLL_PAGE_SIZE,
};
use crate::connectors::models::ConnectorToolGroup;

pub const API_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_SEARCH_RESULTS: u64 = 25;
const MAX_RECIPIENTS: usize = 20;
const MAX_SEND_BODY_CHARS: usize = 20_000;

pub const SEARCH: &str = "gmail_search";
pub const READ_MESSAGE: &str = "gmail_read_message";
pub const SEND: &str = "gmail_send";

static TOOLS: [ConnectorToolDescriptor; 3] = [
    ConnectorToolDescriptor {
        name: SEARCH,
        group: ConnectorToolGroup::Read,
        description: "Search your mail with Gmail search syntax (at most 25 results).",
    },
    ConnectorToolDescriptor {
        name: READ_MESSAGE,
        group: ConnectorToolGroup::Read,
        description: "Read one message: headers and its text body.",
    },
    ConnectorToolDescriptor {
        name: SEND,
        group: ConnectorToolGroup::Act,
        description: "Send a plain-text email as you.",
    },
];

pub fn input_schema(tool: &str) -> Option<Value> {
    Some(match tool {
        SEARCH => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Gmail search, for example is:unread from:alex." },
                "maxResults": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_RESULTS }
            },
            "required": ["query"],
            "additionalProperties": false
        }),
        READ_MESSAGE => json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "Message id from gmail_search." } },
            "required": ["id"],
            "additionalProperties": false
        }),
        SEND => json!({
            "type": "object",
            "properties": {
                "to": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_RECIPIENTS },
                "cc": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_RECIPIENTS },
                "subject": { "type": "string", "maxLength": 300 },
                "body": { "type": "string", "maxLength": MAX_SEND_BODY_CHARS }
            },
            "required": ["to", "subject", "body"],
            "additionalProperties": false
        }),
        _ => return None,
    })
}

pub struct GmailAdapter {
    api: ProviderHttp,
}

pub fn provider(http: reqwest::Client, api_base: Option<String>) -> ServiceProvider<GmailAdapter> {
    ServiceProvider::new(
        OAuth2ConnectorProvider::new(&GMAIL, http.clone()),
        GmailAdapter {
            api: ProviderHttp::new(http, api_base.unwrap_or_else(|| API_BASE.into()), &[]),
        },
    )
}

/// A plain email address with no display name and nothing that could break
/// a header line.
pub fn is_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    value.len() <= 254
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
        && value
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '<' | '>' | ',' | ';' | '"' | '\\'))
}

fn recipients(args: &Value, key: &str, required: bool) -> Result<Vec<String>, ProviderError> {
    let values: Vec<&Value> = match args.get(key) {
        None | Some(Value::Null) if !required => Vec::new(),
        Some(Value::String(_)) => vec![&args[key]],
        Some(Value::Array(items)) => items.iter().collect(),
        _ => return Err(ProviderError::invalid(format!("{key} is required."))),
    };
    let list = values
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|email| is_email(email))
                .map(str::to_string)
                .ok_or_else(|| {
                    ProviderError::invalid(format!("Each {key} entry must be an email."))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if (required && list.is_empty()) || list.len() > MAX_RECIPIENTS {
        return Err(ProviderError::invalid(format!(
            "{key} needs 1 to {MAX_RECIPIENTS} addresses."
        )));
    }
    Ok(list)
}

/// RFC 2047 encoding for a non-ASCII subject.
fn encode_subject(subject: &str) -> String {
    if subject.is_ascii() {
        subject.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(subject.as_bytes()))
    }
}

/// Builds the base64url `raw` message for `users.messages.send`.
pub fn build_raw_message(
    to: &[String],
    cc: &[String],
    subject: &str,
    body: &str,
) -> Result<String, ProviderError> {
    if subject.contains(['\r', '\n']) {
        return Err(ProviderError::invalid("subject must be one line."));
    }
    let mut message = format!("To: {}\r\n", to.join(", "));
    if !cc.is_empty() {
        message.push_str(&format!("Cc: {}\r\n", cc.join(", ")));
    }
    message.push_str(&format!("Subject: {}\r\n", encode_subject(subject)));
    message.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n");
    message.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
    message.push_str(&STANDARD.encode(body.replace("\r\n", "\n").replace('\n', "\r\n")));
    Ok(URL_SAFE_NO_PAD.encode(message.as_bytes()))
}

fn header(message: &Value, name: &str) -> Option<String> {
    list_at(message, "/payload/headers")
        .find(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case(name))
        })
        .and_then(|item| item.get("value").and_then(Value::as_str))
        .map(|value| cap_text(value, 500))
}

fn decode_part(part: &Value) -> Option<String> {
    let data = part.pointer("/body/data").and_then(Value::as_str)?;
    let bytes = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The first part with `mime`, depth first, bounded.
fn find_part<'a>(part: &'a Value, mime: &str, depth: usize) -> Option<&'a Value> {
    if part.get("mimeType").and_then(Value::as_str) == Some(mime) {
        return Some(part);
    }
    if depth == 0 {
        return None;
    }
    list_at(part, "/parts").find_map(|child| find_part(child, mime, depth - 1))
}

fn strip_tags(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    text
}

/// The text body of a full message, capped.
pub fn text_body(message: &Value) -> Option<String> {
    let payload = message.get("payload")?;
    let text = match find_part(payload, "text/plain", 6).and_then(decode_part) {
        Some(text) => text,
        None => strip_tags(&find_part(payload, "text/html", 6).and_then(decode_part)?),
    };
    Some(cap_text(text.trim(), MAX_TEXT_CHARS))
}

fn received_at(message: &Value) -> Option<DateTime<Utc>> {
    let millis = message.get("internalDate")?.as_str()?.parse::<i64>().ok()?;
    Utc.timestamp_millis_opt(millis).single()
}

fn metadata_summary(message: &Value) -> Value {
    json!({
        "id": message.get("id").cloned().unwrap_or(Value::Null),
        "threadId": message.get("threadId").cloned().unwrap_or(Value::Null),
        "from": header(message, "From"),
        "subject": header(message, "Subject"),
        "date": header(message, "Date"),
        "snippet": message.get("snippet").and_then(Value::as_str).map(|text| cap_text(text, 300)),
        "labels": message.get("labelIds").cloned().unwrap_or(Value::Null),
    })
}

impl GmailAdapter {
    async fn search_ids(
        &self,
        token: &str,
        query: &str,
        max: u64,
    ) -> Result<Vec<String>, ProviderError> {
        Ok(self.search_page(token, query, max, None).await?.0)
    }

    /// One page of message ids and the next page token.
    async fn search_page(
        &self,
        token: &str,
        query: &str,
        max: u64,
        page_token: Option<String>,
    ) -> Result<(Vec<String>, Option<String>), ProviderError> {
        let mut params = vec![("q", query.to_string()), ("maxResults", max.to_string())];
        if let Some(page_token) = page_token {
            params.push(("pageToken", page_token));
        }
        let body = self.api.get("/messages", token, &params).await?;
        let ids = list_at(&body, "/messages")
            .take(max as usize)
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .filter(|id| id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric()))
            .map(str::to_string)
            .collect();
        let next = body
            .get("nextPageToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty() && token.len() <= 512)
            .map(str::to_string);
        Ok((ids, next))
    }

    async fn metadata(&self, token: &str, id: &str) -> Result<Value, ProviderError> {
        let params = [
            ("format", "metadata".to_string()),
            ("metadataHeaders", "From".to_string()),
            ("metadataHeaders", "Subject".to_string()),
            ("metadataHeaders", "Date".to_string()),
        ];
        self.api
            .get(&format!("/messages/{}", path_segment(id)), token, &params)
            .await
    }
}

#[async_trait]
impl ServiceAdapter for GmailAdapter {
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
            SEARCH => {
                let query = required_str(args, "query", 500)?;
                let max = limit_arg(args, "maxResults", 10, MAX_SEARCH_RESULTS);
                let mut messages = Vec::new();
                for id in self.search_ids(token, query, max).await? {
                    messages.push(metadata_summary(&self.metadata(token, &id).await?));
                }
                Ok(json!({ "messages": messages }))
            }
            READ_MESSAGE => {
                let id = required_str(args, "id", 64)?;
                let path = format!("/messages/{}", path_segment(id));
                let message = self
                    .api
                    .get(&path, token, &[("format", "full".into())])
                    .await?;
                let mut summary = metadata_summary(&message);
                summary["to"] = json!(header(&message, "To"));
                summary["cc"] = json!(header(&message, "Cc"));
                summary["body"] = json!(text_body(&message));
                Ok(summary)
            }
            SEND => {
                let to = recipients(args, "to", true)?;
                let cc = recipients(args, "cc", false)?;
                let subject = str_arg(args, "subject").unwrap_or_default();
                if subject.chars().count() > 300 {
                    return Err(ProviderError::invalid("subject is too long."));
                }
                let body = required_str(args, "body", MAX_SEND_BODY_CHARS)?;
                let raw = build_raw_message(&to, &cc, subject, body)?;
                let sent = self
                    .api
                    .post("/messages/send", token, &json!({ "raw": raw }))
                    .await?;
                Ok(json!({
                    "id": sent.get("id").cloned().unwrap_or(Value::Null),
                    "threadId": sent.get("threadId").cloned().unwrap_or(Value::Null),
                    "to": to,
                    "subject": subject,
                }))
            }
            _ => Err(ProviderError::UnknownTool),
        }
    }

    async fn account_identity(
        &self,
        secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        let profile = self.api.get("/profile", &secret.access_token, &[]).await?;
        Ok(profile
            .get("emailAddress")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase))
    }

    fn live_subscription(&self, hooks: &ConnectorHooks) -> bool {
        hooks.gmail_push_enabled()
    }

    /// `users.watch`; it lasts seven days, so the polling job renews it.
    async fn subscribe(
        &self,
        secret: &ConnectorSecret,
        hooks: &ConnectorHooks,
    ) -> Result<(), ProviderError> {
        let Some(topic) = hooks.gmail_pubsub_topic.as_deref() else {
            return Ok(());
        };
        let body = json!({ "topicName": topic, "labelIds": ["INBOX"] });
        self.api.post("/watch", &secret.access_token, &body).await?;
        Ok(())
    }

    /// Inbox messages received since `since`, page by page, at most
    /// [`MAX_POLL_EVENTS`]. Polling runs also with push configured: a push
    /// only says the mailbox changed, and the messages come from here.
    async fn poll(
        &self,
        secret: &ConnectorSecret,
        since: DateTime<Utc>,
        _settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        let token = secret.access_token.as_str();
        let query = format!("in:inbox after:{}", since.timestamp());
        let mut ids = Vec::new();
        let mut page_token = None;
        while ids.len() < MAX_POLL_EVENTS {
            let (page, next) = self
                .search_page(token, &query, POLL_PAGE_SIZE as u64, page_token)
                .await?;
            ids.extend(page);
            page_token = next;
            if page_token.is_none() {
                break;
            }
        }
        ids.truncate(MAX_POLL_EVENTS);
        let mut events = Vec::new();
        for id in ids {
            let message = self.metadata(token, &id).await?;
            events.push(PolledEvent {
                kind: "message.received".into(),
                external_id: format!("message:{id}"),
                occurred_at: received_at(&message).unwrap_or(since),
                payload: metadata_summary(&message),
            });
        }
        Ok(events)
    }
}
