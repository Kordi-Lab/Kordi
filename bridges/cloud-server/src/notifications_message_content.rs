use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use uuid::Uuid;

use crate::chat_sync::models::MessageSnapshot;

use super::{
    CLOUD_AGENT_CANCEL_PREFIX, CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_DIRECT_MESSAGE_PREFIX,
    CLOUD_GROUP_PREFIX, MESSAGE_PREVIEW_LIMIT,
};

#[derive(Clone, Debug, PartialEq, Eq)]
enum MessageNotificationContent {
    Visible(Option<String>),
    Hidden,
}

pub(super) fn message_event_id(recipient: &str, message_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("kordi:message:{recipient}:{message_id}").as_bytes(),
    )
}

pub(super) fn is_notifiable_message(message: &MessageSnapshot) -> bool {
    if message.deleted_at.is_some() {
        return false;
    }
    let kind = message.kind.trim().to_ascii_lowercase();
    !kind.is_empty()
        && !kind.contains("control")
        && !kind.contains("snapshot")
        && !kind.contains("cursor")
        && !kind.contains("presence")
        && message_notification_content(message) != MessageNotificationContent::Hidden
}

fn raw_message_text(message: &MessageSnapshot) -> Option<&str> {
    message
        .content
        .get("blocks")
        .and_then(|blocks| blocks.as_array())
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
        .map(str::trim)
        .find(|text| !text.is_empty())
}

fn decoded_envelope(value: &str, prefix: &str) -> Option<serde_json::Value> {
    let encoded = value.trim().strip_prefix(prefix)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn is_agent_authored_message(message: &MessageSnapshot) -> bool {
    let Some(raw_text) = raw_message_text(message) else {
        return false;
    };
    if let Some(envelope) = decoded_envelope(raw_text, CLOUD_AGENT_RESPONSE_PREFIX) {
        return envelope.get("kind").and_then(serde_json::Value::as_str) == Some("agent-response");
    }
    let Some(envelope) = decoded_envelope(raw_text, CLOUD_GROUP_PREFIX) else {
        return false;
    };
    envelope.get("kind").and_then(serde_json::Value::as_str) == Some("group-message")
        && envelope
            .get("message")
            .and_then(|message| message.get("senderKind"))
            .and_then(serde_json::Value::as_str)
            == Some("agent")
}

pub(super) fn notification_sender_display_name(
    message: &MessageSnapshot,
    fallback: String,
) -> String {
    let Some(raw_text) = raw_message_text(message) else {
        return fallback;
    };
    if decoded_envelope(raw_text, CLOUD_AGENT_RESPONSE_PREFIX).is_some_and(|envelope| {
        envelope.get("kind").and_then(serde_json::Value::as_str) == Some("agent-response")
    }) {
        return "Kordi".to_string();
    }
    decoded_envelope(raw_text, CLOUD_GROUP_PREFIX)
        .filter(|envelope| {
            envelope.get("kind").and_then(serde_json::Value::as_str) == Some("group-message")
        })
        .and_then(|envelope| {
            envelope
                .get("message")
                .and_then(|message| message.get("senderDisplayName"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or(fallback)
}

fn visible_envelope_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn message_notification_content(message: &MessageSnapshot) -> MessageNotificationContent {
    let Some(raw_text) = raw_message_text(message) else {
        return MessageNotificationContent::Visible(None);
    };
    if raw_text.starts_with(CLOUD_AGENT_CANCEL_PREFIX) {
        return MessageNotificationContent::Hidden;
    }
    if raw_text.starts_with(CLOUD_DIRECT_MESSAGE_PREFIX) {
        let Some(envelope) = decoded_envelope(raw_text, CLOUD_DIRECT_MESSAGE_PREFIX) else {
            return MessageNotificationContent::Hidden;
        };
        if envelope.get("kind").and_then(serde_json::Value::as_str) != Some("message") {
            return MessageNotificationContent::Hidden;
        }
        return MessageNotificationContent::Visible(visible_envelope_text(&envelope));
    }
    if raw_text.starts_with(CLOUD_AGENT_RESPONSE_PREFIX) {
        let Some(envelope) = decoded_envelope(raw_text, CLOUD_AGENT_RESPONSE_PREFIX) else {
            return MessageNotificationContent::Hidden;
        };
        if envelope.get("kind").and_then(serde_json::Value::as_str) != Some("agent-response") {
            return MessageNotificationContent::Hidden;
        }
        return MessageNotificationContent::Visible(visible_envelope_text(&envelope));
    }
    if raw_text.starts_with(CLOUD_GROUP_PREFIX) {
        let Some(envelope) = decoded_envelope(raw_text, CLOUD_GROUP_PREFIX) else {
            return MessageNotificationContent::Hidden;
        };
        if envelope.get("kind").and_then(serde_json::Value::as_str) != Some("group-message") {
            return MessageNotificationContent::Hidden;
        }
        let text = envelope
            .get("message")
            .and_then(|message| message.get("text"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string);
        return MessageNotificationContent::Visible(text);
    }
    MessageNotificationContent::Visible(Some(raw_text.to_string()))
}

pub(super) fn message_preview(
    message: &MessageSnapshot,
    image_attachment_count: usize,
) -> (String, String) {
    let text = match message_notification_content(message) {
        MessageNotificationContent::Visible(text) => text.map(|text| truncate_preview(&text)),
        MessageNotificationContent::Hidden => None,
    };
    if let Some(text) = text {
        return ("text".to_string(), text);
    }
    match message.attachment_ids.len() {
        0 => ("generic".to_string(), "New message".to_string()),
        1 if image_attachment_count == 1 => ("image".to_string(), "Sent a photo".to_string()),
        1 => ("files".to_string(), "Sent a file".to_string()),
        count if image_attachment_count == count => {
            ("files".to_string(), format!("Sent {count} photos"))
        }
        count => ("files".to_string(), format!("Sent {count} files")),
    }
}

fn truncate_preview(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = compact.chars();
    let preview = characters
        .by_ref()
        .take(MESSAGE_PREVIEW_LIMIT)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}
