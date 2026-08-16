use sqlx_core::query::query;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

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
    let clean_token = validate_push_token(device_token, environment)?;
    let mut transaction = pool.begin().await?;
    lock_push_token(&mut transaction, &clean_token, environment).await?;
    remove_previous_token_owner(
        &mut transaction,
        PushTokenStore::Voip,
        device_id,
        &clean_token,
        environment,
    )
    .await?;
    query(VOIP_TOKEN_UPSERT)
        .bind(device_id)
        .bind(account_id)
        .bind(clean_token)
        .bind(environment)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn register_notification_push_token(
    pool: &PgPool,
    registration: NotificationPushTokenRegistration<'_>,
) -> Result<(), CallStoreError> {
    let clean_token = validate_push_token(registration.device_token, registration.environment)?;
    let mut transaction = pool.begin().await?;
    lock_push_token(&mut transaction, &clean_token, registration.environment).await?;
    remove_previous_token_owner(
        &mut transaction,
        PushTokenStore::Notification,
        registration.device_id,
        &clean_token,
        registration.environment,
    )
    .await?;
    query(NOTIFICATION_TOKEN_UPSERT)
        .bind(registration.device_id)
        .bind(registration.account_id)
        .bind(clean_token)
        .bind(registration.environment)
        .bind(registration.messages_enabled)
        .bind(registration.sound_enabled)
        .bind(registration.previews_enabled)
        .bind(registration.badge_enabled)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

#[derive(Clone, Copy)]
enum PushTokenStore {
    Notification,
    Voip,
}

async fn lock_push_token(
    transaction: &mut Transaction<'_, Postgres>,
    device_token: &str,
    environment: &str,
) -> Result<(), sqlx_core::Error> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("apns-token:{environment}:{device_token}"))
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn remove_previous_token_owner(
    transaction: &mut Transaction<'_, Postgres>,
    store: PushTokenStore,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), sqlx_core::Error> {
    let statement = match store {
        PushTokenStore::Voip => {
            "DELETE FROM cloud_voip_push_tokens \
             WHERE device_token = $1 AND apns_environment = $2 AND device_id <> $3"
        }
        PushTokenStore::Notification => {
            "DELETE FROM cloud_apns_push_tokens \
             WHERE device_token = $1 AND apns_environment = $2 AND device_id <> $3"
        }
    };
    query(statement)
        .bind(device_token)
        .bind(environment)
        .bind(device_id)
        .execute(&mut **transaction)
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
