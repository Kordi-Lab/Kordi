use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::MessageSnapshot;

use super::{
    content::is_agent_authored_message, MESSAGE_DELIVERY_ATTEMPTS,
    MESSAGE_DELIVERY_RETRY_AFTER_SECONDS,
};

pub(super) async fn register_message_notification_events(
    pool: &PgPool,
    message: &MessageSnapshot,
    environment: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    query(
        "INSERT INTO cloud_message_notification_events \
         (recipient_account_id, message_id, conversation_id, accepted_at) \
         SELECT member.account_id, $1, $2, \
                CASE WHEN member.muted_until IS NOT NULL AND member.muted_until > NOW() \
                     THEN NOW() ELSE NULL END \
         FROM cloud_chat_conversation_members member \
         WHERE member.conversation_id = $2 \
           AND member.membership_state = 'active' \
           AND (member.account_id <> $3 OR $4) \
         ON CONFLICT (recipient_account_id, message_id) DO NOTHING",
    )
    .bind(message.id)
    .bind(message.conversation_id)
    .bind(&message.sender_account_id)
    .bind(is_agent_authored_message(message))
    .execute(&mut *transaction)
    .await?;

    query(
        "INSERT INTO cloud_message_notification_deliveries \
         (recipient_account_id, message_id, device_id) \
         SELECT event.recipient_account_id, event.message_id, push.device_id \
         FROM cloud_message_notification_events event \
         JOIN cloud_apns_push_tokens push \
           ON push.account_id = event.recipient_account_id \
          AND push.apns_environment = $2 \
          AND push.message_notifications_enabled \
         JOIN cloud_devices device \
           ON device.device_id = push.device_id \
          AND device.account_id = push.account_id \
          AND device.revoked_at IS NULL \
         WHERE event.message_id = $1 AND event.accepted_at IS NULL \
           AND EXISTS (SELECT 1 FROM cloud_refresh_tokens session \
                       WHERE session.device_id = device.device_id \
                         AND session.account_id = push.account_id \
                         AND session.revoked_at IS NULL \
                         AND session.expires_at::timestamptz > NOW()) \
         ON CONFLICT (recipient_account_id, message_id, device_id) DO NOTHING",
    )
    .bind(message.id)
    .bind(environment)
    .execute(&mut *transaction)
    .await?;

    query(
        "UPDATE cloud_message_notification_events event SET accepted_at = NOW() \
         WHERE event.message_id = $1 AND event.accepted_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM cloud_message_notification_deliveries delivery \
                           WHERE delivery.recipient_account_id = event.recipient_account_id \
                             AND delivery.message_id = event.message_id \
                             AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL)",
    )
    .bind(message.id)
    .execute(&mut *transaction)
    .await?;

    let recipients = query_as(
        "SELECT event.recipient_account_id \
         FROM cloud_message_notification_events event \
         WHERE event.message_id = $1 AND event.accepted_at IS NULL \
           AND EXISTS (SELECT 1 FROM cloud_message_notification_deliveries delivery \
                       WHERE delivery.recipient_account_id = event.recipient_account_id \
                         AND delivery.message_id = event.message_id \
                         AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL \
                         AND (delivery.attempt_count >= $2 OR \
                              delivery.last_attempt_at IS NULL OR \
                              delivery.last_attempt_at < NOW() - ($3 * INTERVAL '1 second')))",
    )
    .bind(message.id)
    .bind(MESSAGE_DELIVERY_ATTEMPTS)
    .bind(MESSAGE_DELIVERY_RETRY_AFTER_SECONDS)
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|(account_id,)| account_id)
    .collect();
    transaction.commit().await?;
    Ok(recipients)
}

pub(super) async fn reconcile_message_deliveries(
    pool: &PgPool,
    recipient: &str,
    message_id: Uuid,
    environment: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_message_notification_deliveries delivery SET failed_at = NOW() \
         WHERE delivery.recipient_account_id = $1 AND delivery.message_id = $2 \
           AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL \
           AND ((delivery.attempt_count >= $3 AND delivery.last_attempt_at IS NOT NULL \
                 AND delivery.last_attempt_at < NOW() - ($4 * INTERVAL '1 second')) OR \
                NOT EXISTS (SELECT 1 FROM cloud_apns_push_tokens push \
                            JOIN cloud_devices device ON device.device_id = push.device_id \
                            WHERE push.device_id = delivery.device_id \
                              AND push.account_id = delivery.recipient_account_id \
                              AND push.apns_environment = $5 \
                              AND push.message_notifications_enabled \
                              AND device.account_id = push.account_id \
                              AND device.revoked_at IS NULL \
                              AND EXISTS (SELECT 1 FROM cloud_refresh_tokens session \
                                          WHERE session.device_id = device.device_id \
                                            AND session.account_id = push.account_id \
                                            AND session.revoked_at IS NULL \
                                            AND session.expires_at::timestamptz > NOW())))",
    )
    .bind(recipient)
    .bind(message_id)
    .bind(MESSAGE_DELIVERY_ATTEMPTS)
    .bind(MESSAGE_DELIVERY_RETRY_AFTER_SECONDS)
    .bind(environment)
    .execute(pool)
    .await?;
    finish_message_notification_event(pool, recipient, message_id).await
}

pub(super) async fn mark_message_delivery_finished(
    pool: &PgPool,
    recipient: &str,
    message_id: Uuid,
    device_id: &str,
    accepted: bool,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_message_notification_deliveries \
         SET accepted_at = CASE WHEN $4 THEN NOW() ELSE NULL END, \
             failed_at = CASE WHEN $4 THEN NULL ELSE NOW() END \
         WHERE recipient_account_id = $1 AND message_id = $2 AND device_id = $3 \
           AND accepted_at IS NULL AND failed_at IS NULL",
    )
    .bind(recipient)
    .bind(message_id)
    .bind(device_id)
    .bind(accepted)
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn finish_message_notification_event(
    pool: &PgPool,
    recipient: &str,
    message_id: Uuid,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_message_notification_events event SET accepted_at = NOW() \
         WHERE event.recipient_account_id = $1 AND event.message_id = $2 \
           AND event.accepted_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM cloud_message_notification_deliveries delivery \
                           WHERE delivery.recipient_account_id = event.recipient_account_id \
                             AND delivery.message_id = event.message_id \
                             AND delivery.accepted_at IS NULL AND delivery.failed_at IS NULL)",
    )
    .bind(recipient)
    .bind(message_id)
    .execute(pool)
    .await?;
    Ok(())
}
