use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use super::CallStoreError;

pub struct NotificationPushTokenRegistration<'a> {
    pub account_id: &'a str,
    pub device_id: &'a str,
    pub device_token: &'a str,
    pub environment: &'a str,
    pub messages_enabled: bool,
    pub sound_enabled: bool,
    pub previews_enabled: bool,
    pub badge_enabled: bool,
}

const VOIP_TOKEN_UPSERT: &str = "INSERT INTO cloud_voip_push_tokens \
     (device_id, account_id, device_token, apns_environment) \
     VALUES ($1, $2, $3, $4) \
     ON CONFLICT (device_id) DO UPDATE SET \
       account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
       apns_environment = EXCLUDED.apns_environment, updated_at = NOW()";

const NOTIFICATION_TOKEN_UPSERT: &str = "INSERT INTO cloud_apns_push_tokens \
     (device_id, account_id, device_token, apns_environment, \
      message_notifications_enabled, message_sound_enabled, \
      message_previews_enabled, message_badge_enabled) \
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
     ON CONFLICT (device_id) DO UPDATE SET \
       account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
       apns_environment = EXCLUDED.apns_environment, \
       message_notifications_enabled = EXCLUDED.message_notifications_enabled, \
       message_sound_enabled = EXCLUDED.message_sound_enabled, \
       message_previews_enabled = EXCLUDED.message_previews_enabled, \
       message_badge_enabled = EXCLUDED.message_badge_enabled, updated_at = NOW()";

pub async fn register_voip_push_token(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    register_push_token(
        pool,
        VOIP_TOKEN_UPSERT,
        account_id,
        device_id,
        device_token,
        environment,
    )
    .await
}

pub async fn register_notification_push_token(
    pool: &PgPool,
    registration: NotificationPushTokenRegistration<'_>,
) -> Result<(), CallStoreError> {
    let clean_token = validate_push_token(registration.device_token, registration.environment)?;
    query(NOTIFICATION_TOKEN_UPSERT)
        .bind(registration.device_id)
        .bind(registration.account_id)
        .bind(clean_token)
        .bind(registration.environment)
        .bind(registration.messages_enabled)
        .bind(registration.sound_enabled)
        .bind(registration.previews_enabled)
        .bind(registration.badge_enabled)
        .execute(pool)
        .await?;
    Ok(())
}

async fn register_push_token(
    pool: &PgPool,
    statement: &'static str,
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    let clean_token = validate_push_token(device_token, environment)?;
    query(statement)
        .bind(device_id)
        .bind(account_id)
        .bind(clean_token)
        .bind(environment)
        .execute(pool)
        .await?;
    Ok(())
}

fn validate_push_token(device_token: &str, environment: &str) -> Result<String, CallStoreError> {
    let clean_token = device_token.trim().to_ascii_lowercase();
    let valid_token = (32..=200).contains(&clean_token.len())
        && clean_token.bytes().all(|value| value.is_ascii_hexdigit());
    if !valid_token || !matches!(environment, "development" | "production") {
        return Err(CallStoreError::InvalidPushToken);
    }
    Ok(clean_token)
}
