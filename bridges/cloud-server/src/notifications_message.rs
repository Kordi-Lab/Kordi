use a2::{
    request::payload::PayloadLike, Error as ApnsError, NotificationOptions, Priority, PushType,
};
use serde::Serialize;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use tokio::task::JoinHandle;
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::chat_sync::models::MessageSnapshot;

use super::PushNotificationService;

#[path = "notifications_message_content.rs"]
mod content;
#[path = "notifications_message_delivery.rs"]
mod delivery;

pub(crate) use content::{is_agent_authored_message, is_frontend_visible_message};
use content::{
    is_notifiable_message, message_event_id, message_preview, notification_sender_display_name,
};
use delivery::{
    finish_message_notification_event, mark_message_delivery_finished,
    reconcile_message_deliveries, register_message_notification_events,
};

const MESSAGE_CATEGORY: &str = "KORDI_MESSAGE";
const MESSAGE_PREVIEW_LIMIT: usize = 140;
const MESSAGE_DELIVERY_RETRY_AFTER_SECONDS: i32 = 30;
const MESSAGE_DELIVERY_WORKER_INTERVAL: Duration = Duration::from_secs(15);
const MESSAGE_DELIVERY_ATTEMPTS: i32 = 8;
const MESSAGE_DELIVERY_BATCH_SIZE: i64 = 100;
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
    attempt_count: i32,
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
        let recipients =
            match register_message_notification_events(pool, message, &self.environment).await {
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
                if let Err(error) = service
                    .send_message_attention_to_recipient(&pool, &message, &recipient)
                    .await
                {
                    let event_id = message_event_id(&recipient, message.id);
                    eprintln!("[notifications] message event {event_id} failed: {error}");
                }
            });
        }
    }

    pub fn spawn_message_notification_worker(&self, pool: PgPool) -> JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(MESSAGE_DELIVERY_WORKER_INTERVAL);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = service.retry_pending_message_notifications(&pool).await {
                    eprintln!("[notifications] retry pending message events: {error}");
                }
            }
        })
    }

    async fn retry_pending_message_notifications(
        &self,
        pool: &PgPool,
    ) -> Result<(), sqlx_core::Error> {
        let pending: Vec<(String, Uuid)> = query_as(
            "SELECT event.recipient_account_id, event.message_id \
             FROM cloud_message_notification_events event \
             WHERE event.accepted_at IS NULL \
               AND EXISTS (SELECT 1 FROM cloud_message_notification_deliveries delivery \
                           WHERE delivery.recipient_account_id = event.recipient_account_id \
                             AND delivery.message_id = event.message_id \
                             AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL \
                             AND (delivery.last_attempt_at IS NULL OR \
                                  delivery.last_attempt_at < NOW() - ($1 * INTERVAL '1 second'))) \
             ORDER BY event.created_at ASC \
             LIMIT $2",
        )
        .bind(MESSAGE_DELIVERY_RETRY_AFTER_SECONDS)
        .bind(MESSAGE_DELIVERY_BATCH_SIZE)
        .fetch_all(pool)
        .await?;

        for (recipient, message_id) in pending {
            let message =
                match crate::chat_sync::store::load_message_snapshot(pool, message_id).await {
                    Ok(message) => message,
                    Err(error) => {
                        eprintln!("[notifications] load pending message {message_id}: {error:?}");
                        continue;
                    }
                };
            if let Err(error) = self
                .send_message_attention_to_recipient(pool, &message, &recipient)
                .await
            {
                let event_id = message_event_id(&recipient, message_id);
                eprintln!("[notifications] retry message event {event_id}: {error}");
            }
        }
        Ok(())
    }

    async fn send_message_attention_to_recipient(
        &self,
        pool: &PgPool,
        message: &MessageSnapshot,
        recipient: &str,
    ) -> Result<(), sqlx_core::Error> {
        reconcile_message_deliveries(pool, recipient, message.id, &self.environment).await?;

        let context: Option<(String, String, i64, i64)> = query_as(
            "SELECT COALESCE(sender.display_name, 'Kordi'), conversation.kind, \
                    (SELECT COUNT(*) \
                     FROM cloud_chat_conversation_members membership \
                     JOIN cloud_chat_messages unread \
                       ON unread.conversation_id = membership.conversation_id \
                      AND unread.conversation_sequence > membership.last_read_sequence \
                      AND (unread.sender_account_id <> membership.account_id OR \
                           EXISTS (SELECT 1 FROM cloud_message_notification_events unread_event \
                                   WHERE unread_event.recipient_account_id = membership.account_id \
                                     AND unread_event.message_id = unread.message_id)) \
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
            return Ok(());
        };
        let sender_display_name = notification_sender_display_name(message, sender_display_name);
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
        let tokens: Vec<(String, String, bool, bool, bool, i32)> = query_as(
            "SELECT push.device_id, push.device_token, push.message_sound_enabled, \
                    push.message_previews_enabled, push.message_badge_enabled, \
                    delivery.attempt_count \
             FROM cloud_message_notification_deliveries delivery \
             JOIN cloud_apns_push_tokens push ON push.device_id = delivery.device_id \
             JOIN cloud_devices device ON device.device_id = push.device_id \
             WHERE delivery.recipient_account_id = $1 AND delivery.message_id = $2 \
               AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL \
               AND delivery.attempt_count < $3 \
               AND (delivery.last_attempt_at IS NULL OR \
                    delivery.last_attempt_at < NOW() - ($4 * INTERVAL '1 second')) \
               AND push.account_id = $1 AND push.apns_environment = $5 \
               AND push.message_notifications_enabled AND device.revoked_at IS NULL \
               AND device.account_id = push.account_id \
               AND EXISTS (SELECT 1 FROM cloud_refresh_tokens session \
                           WHERE session.device_id = device.device_id \
                             AND session.account_id = push.account_id \
                             AND session.revoked_at IS NULL \
                             AND session.expires_at::timestamptz > NOW())",
        )
        .bind(recipient)
        .bind(message.id)
        .bind(MESSAGE_DELIVERY_ATTEMPTS)
        .bind(MESSAGE_DELIVERY_RETRY_AFTER_SECONDS)
        .bind(&self.environment)
        .fetch_all(pool)
        .await?;

        for (
            device_id,
            device_token,
            sound_enabled,
            previews_enabled,
            badge_enabled,
            attempt_count,
        ) in tokens
        {
            let preferences = MessageDevicePreferences {
                device_id,
                device_token,
                sound_enabled,
                previews_enabled,
                badge_enabled,
                attempt_count,
            };
            let claimed: Option<(i32,)> = query_as(
                "UPDATE cloud_message_notification_deliveries \
                 SET attempt_count = attempt_count + 1, last_attempt_at = NOW() \
                 WHERE recipient_account_id = $1 AND message_id = $2 AND device_id = $3 \
                   AND accepted_at IS NULL AND failed_at IS NULL AND attempt_count = $4 \
                   AND attempt_count < $5 \
                   AND (last_attempt_at IS NULL OR \
                        last_attempt_at < NOW() - ($6 * INTERVAL '1 second')) \
                 RETURNING attempt_count",
            )
            .bind(recipient)
            .bind(message.id)
            .bind(&preferences.device_id)
            .bind(preferences.attempt_count)
            .bind(MESSAGE_DELIVERY_ATTEMPTS)
            .bind(MESSAGE_DELIVERY_RETRY_AFTER_SECONDS)
            .fetch_optional(pool)
            .await?;
            let Some((attempt_count,)) = claimed else {
                continue;
            };

            match self.send_message_payload(&preferences, &event).await {
                Ok(()) => {
                    mark_message_delivery_finished(
                        pool,
                        recipient,
                        message.id,
                        &preferences.device_id,
                        true,
                    )
                    .await?;
                }
                Err(error) if is_permanent_token_error(&error) => {
                    query(
                        "DELETE FROM cloud_apns_push_tokens \
                         WHERE device_id = $1 AND device_token = $2 AND apns_environment = $3",
                    )
                    .bind(&preferences.device_id)
                    .bind(&preferences.device_token)
                    .bind(&self.environment)
                    .execute(pool)
                    .await?;
                    mark_message_delivery_finished(
                        pool,
                        recipient,
                        message.id,
                        &preferences.device_id,
                        false,
                    )
                    .await?;
                }
                Err(error) if attempt_count >= MESSAGE_DELIVERY_ATTEMPTS => {
                    eprintln!("[notifications] message device delivery exhausted retries: {error}");
                    mark_message_delivery_finished(
                        pool,
                        recipient,
                        message.id,
                        &preferences.device_id,
                        false,
                    )
                    .await?;
                }
                Err(error) => {
                    eprintln!("[notifications] message device delivery will retry: {error}");
                }
            }
        }
        finish_message_notification_event(pool, recipient, message.id).await?;
        Ok(())
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
