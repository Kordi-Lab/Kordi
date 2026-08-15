use a2::{
    request::payload::PayloadLike, Error as ApnsError, NotificationOptions, Priority, PushType,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use crate::chat_sync::models::MessageSnapshot;

use super::PushNotificationService;

const MESSAGE_CATEGORY: &str = "KORDI_MESSAGE";
const MESSAGE_PREVIEW_LIMIT: usize = 140;
const MESSAGE_DELIVERY_RETRY_DELAY: Duration = Duration::from_secs(31);
const MESSAGE_DELIVERY_ATTEMPTS: usize = 3;
const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";
const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const CLOUD_AGENT_CANCEL_PREFIX: &str = "kordi-cloud-agent-cancel:";
const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageAttentionEvent {
    pub event_id: Uuid,
    pub account_id: String,
    pub session_id: Uuid,
    pub message_id: Uuid,
    pub message_sequence: i64,
    pub conversation_kind: String,
    pub sender_display_name: String,
    pub preview_kind: String,
    pub preview_text: String,
    pub absolute_unread_count: u32,
}

#[derive(Debug, Serialize)]
struct MessagePushAlert<'a> {
    title: &'a str,
    body: &'a str,
}

#[derive(Debug, Serialize)]
struct MessagePushAps<'a> {
    alert: MessagePushAlert<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    badge: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sound: Option<&'static str>,
    category: &'static str,
    #[serde(rename = "thread-id")]
    thread_id: &'a str,
}

#[derive(Clone, Debug)]
struct MessageDevicePreferences {
    device_id: String,
    device_token: String,
    sound_enabled: bool,
    previews_enabled: bool,
    badge_enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum MessageNotificationContent {
    Visible(Option<String>),
    Hidden,
}

#[derive(Debug, Serialize)]
struct MessagePushPayload<'a> {
    aps: MessagePushAps<'a>,
    notification_type: &'static str,
    account_id: &'a str,
    session_id: &'a str,
    message_id: &'a str,
    #[serde(skip_serializing)]
    options: NotificationOptions<'a>,
    #[serde(skip_serializing)]
    device_token: &'a str,
}

impl PayloadLike for MessagePushPayload<'_> {
    fn get_device_token(&self) -> &str {
        self.device_token
    }

    fn get_options(&self) -> &NotificationOptions<'_> {
        &self.options
    }
}

impl PushNotificationService {
    pub async fn send_message_attention(&self, pool: &PgPool, message: &MessageSnapshot) {
        if !is_notifiable_message(message) {
            return;
        }
        let recipients = match register_message_notification_events(pool, message).await {
            Ok(recipients) => recipients,
            Err(error) => {
                eprintln!("[notifications] could not register message events: {error}");
                return;
            }
        };

        for recipient in recipients {
            let service = self.clone();
            let pool = pool.clone();
            let message = message.clone();
            tokio::spawn(async move {
                for attempt in 0..MESSAGE_DELIVERY_ATTEMPTS {
                    match service
                        .send_message_attention_to_recipient(&pool, &message, &recipient)
                        .await
                    {
                        Ok(false) => return,
                        Ok(true) if attempt + 1 < MESSAGE_DELIVERY_ATTEMPTS => {
                            sleep(MESSAGE_DELIVERY_RETRY_DELAY).await;
                        }
                        Ok(true) => return,
                        Err(error) => {
                            let event_id = message_event_id(&recipient, message.id);
                            eprintln!("[notifications] message event {event_id} failed: {error}");
                            return;
                        }
                    }
                }
            });
        }
    }

    async fn send_message_attention_to_recipient(
        &self,
        pool: &PgPool,
        message: &MessageSnapshot,
        recipient: &str,
    ) -> Result<bool, sqlx_core::Error> {
        let claimed: Option<(i32,)> = query_as(
            "UPDATE cloud_message_notification_events \
             SET attempt_count = attempt_count + 1, last_attempt_at = NOW() \
             WHERE recipient_account_id = $1 AND message_id = $2 AND accepted_at IS NULL \
               AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '30 seconds') \
             RETURNING attempt_count",
        )
        .bind(recipient)
        .bind(message.id)
        .fetch_optional(pool)
        .await?;
        if claimed.is_none() {
            return Ok(false);
        }

        let context: Option<(String, String, i64, i64)> = query_as(
            "SELECT COALESCE(sender.display_name, 'Kordi'), conversation.kind, \
                    (SELECT COUNT(*) \
                     FROM cloud_chat_conversation_members membership \
                     JOIN cloud_chat_messages unread \
                       ON unread.conversation_id = membership.conversation_id \
                      AND unread.conversation_sequence > membership.last_read_sequence \
                      AND unread.sender_account_id <> membership.account_id \
                      AND unread.deleted_at IS NULL \
                     WHERE membership.account_id = $1 \
                       AND membership.membership_state = 'active'), \
                    (SELECT COUNT(*) \
                     FROM cloud_chat_message_attachments message_attachment \
                     JOIN cloud_attachments attachment \
                       ON attachment.attachment_id = message_attachment.attachment_id \
                     WHERE message_attachment.message_id = $4 \
                       AND LOWER(COALESCE(attachment.content_type, '')) LIKE 'image/%') \
             FROM cloud_chat_conversations conversation \
             JOIN cloud_accounts sender ON sender.account_id = $2 \
             WHERE conversation.conversation_id = $3",
        )
        .bind(recipient)
        .bind(&message.sender_account_id)
        .bind(message.conversation_id)
        .bind(message.id)
        .fetch_optional(pool)
        .await?;
        let Some((sender_display_name, conversation_kind, unread_count, image_attachment_count)) =
            context
        else {
            return Ok(false);
        };
        let (preview_kind, preview_text) =
            message_preview(message, image_attachment_count.max(0) as usize);
        let event = MessageAttentionEvent {
            event_id: message_event_id(recipient, message.id),
            account_id: recipient.to_string(),
            session_id: message.conversation_id,
            message_id: message.id,
            message_sequence: message.conversation_sequence,
            conversation_kind,
            sender_display_name,
            preview_kind,
            preview_text,
            absolute_unread_count: unread_count.clamp(0, u32::MAX as i64) as u32,
        };
        let tokens: Vec<(String, String, bool, bool, bool)> = query_as(
            "SELECT push.device_id, push.device_token, push.message_sound_enabled, \
                    push.message_previews_enabled, push.message_badge_enabled \
             FROM cloud_apns_push_tokens push \
             JOIN cloud_devices device ON device.device_id = push.device_id \
             WHERE push.account_id = $1 AND push.apns_environment = $2 \
               AND push.message_notifications_enabled \
               AND device.revoked_at IS NULL",
        )
        .bind(recipient)
        .bind(&self.environment)
        .fetch_all(pool)
        .await?;

        let mut retry_required = false;
        for (device_id, device_token, sound_enabled, previews_enabled, badge_enabled) in tokens {
            let preferences = MessageDevicePreferences {
                device_id,
                device_token,
                sound_enabled,
                previews_enabled,
                badge_enabled,
            };
            if let Err(error) = self.send_message_payload(&preferences, &event).await {
                if is_permanent_token_error(&error) {
                    query(
                        "DELETE FROM cloud_apns_push_tokens \
                         WHERE device_id = $1 AND device_token = $2 AND apns_environment = $3",
                    )
                    .bind(&preferences.device_id)
                    .bind(&preferences.device_token)
                    .bind(&self.environment)
                    .execute(pool)
                    .await?;
                } else {
                    retry_required = true;
                }
            }
        }
        if !retry_required {
            query(
                "UPDATE cloud_message_notification_events SET accepted_at = NOW() \
                 WHERE recipient_account_id = $1 AND message_id = $2",
            )
            .bind(recipient)
            .bind(message.id)
            .execute(pool)
            .await?;
        }
        Ok(retry_required)
    }

    async fn send_message_payload(
        &self,
        preferences: &MessageDevicePreferences,
        event: &MessageAttentionEvent,
    ) -> Result<(), ApnsError> {
        let event_id = event.event_id.to_string();
        let session_id = event.session_id.to_string();
        let message_id = event.message_id.to_string();
        let private_preview = "New message";
        let private_title = "Kordi";
        let payload = MessagePushPayload {
            aps: MessagePushAps {
                alert: MessagePushAlert {
                    title: if preferences.previews_enabled {
                        &event.sender_display_name
                    } else {
                        private_title
                    },
                    body: if preferences.previews_enabled {
                        &event.preview_text
                    } else {
                        private_preview
                    },
                },
                badge: preferences
                    .badge_enabled
                    .then_some(event.absolute_unread_count),
                sound: preferences.sound_enabled.then_some("default"),
                category: MESSAGE_CATEGORY,
                thread_id: &session_id,
            },
            notification_type: "message",
            account_id: &event.account_id,
            session_id: &session_id,
            message_id: &message_id,
            options: NotificationOptions {
                apns_id: Some(&event_id),
                apns_push_type: Some(PushType::Alert),
                apns_priority: Some(Priority::High),
                apns_topic: Some(&self.application_topic),
                ..Default::default()
            },
            device_token: &preferences.device_token,
        };
        self.client.send(payload).await.map(|_| ())
    }
}

async fn register_message_notification_events(
    pool: &PgPool,
    message: &MessageSnapshot,
) -> Result<Vec<String>, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    let inserted: Vec<(String, bool)> = query_as(
        "INSERT INTO cloud_message_notification_events \
         (recipient_account_id, message_id, conversation_id, accepted_at) \
         SELECT member.account_id, $1, $2, \
                CASE WHEN member.muted_until IS NOT NULL AND member.muted_until > NOW() \
                     THEN NOW() ELSE NULL END \
         FROM cloud_chat_conversation_members member \
         WHERE member.conversation_id = $2 \
           AND member.membership_state = 'active' \
           AND member.account_id <> $3 \
         ON CONFLICT (recipient_account_id, message_id) DO NOTHING \
         RETURNING recipient_account_id, accepted_at IS NULL",
    )
    .bind(message.id)
    .bind(message.conversation_id)
    .bind(&message.sender_account_id)
    .fetch_all(&mut *transaction)
    .await?;
    let mut recipients = inserted
        .into_iter()
        .filter_map(|(account_id, should_deliver)| should_deliver.then_some(account_id))
        .collect::<Vec<_>>();
    let retryable: Vec<(String,)> = query_as(
        "SELECT recipient_account_id FROM cloud_message_notification_events \
         WHERE message_id = $1 AND accepted_at IS NULL \
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '30 seconds')",
    )
    .bind(message.id)
    .fetch_all(&mut *transaction)
    .await?;
    for (account_id,) in retryable {
        if !recipients.contains(&account_id) {
            recipients.push(account_id);
        }
    }
    transaction.commit().await?;
    Ok(recipients)
}

fn message_event_id(recipient: &str, message_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("kordi:message:{recipient}:{message_id}").as_bytes(),
    )
}

fn is_notifiable_message(message: &MessageSnapshot) -> bool {
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

fn message_preview(message: &MessageSnapshot, image_attachment_count: usize) -> (String, String) {
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

fn is_permanent_token_error(error: &ApnsError) -> bool {
    use a2::response::ErrorReason;
    matches!(
        error,
        ApnsError::ResponseError(response)
            if response.error.as_ref().is_some_and(|body| matches!(
                body.reason,
                ErrorReason::BadDeviceToken
                    | ErrorReason::DeviceTokenNotForTopic
                    | ErrorReason::Unregistered
            ))
    )
}

#[cfg(test)]
#[path = "notifications_message_tests.rs"]
mod tests;
