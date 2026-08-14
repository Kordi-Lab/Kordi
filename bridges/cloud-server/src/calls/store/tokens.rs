use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use super::CallStoreError;

const VOIP_TOKEN_UPSERT: &str = "INSERT INTO cloud_voip_push_tokens \
     (device_id, account_id, device_token, apns_environment) \
     VALUES ($1, $2, $3, $4) \
     ON CONFLICT (device_id) DO UPDATE SET \
       account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
       apns_environment = EXCLUDED.apns_environment, updated_at = NOW()";

const NOTIFICATION_TOKEN_UPSERT: &str = "INSERT INTO cloud_apns_push_tokens \
     (device_id, account_id, device_token, apns_environment) \
     VALUES ($1, $2, $3, $4) \
     ON CONFLICT (device_id) DO UPDATE SET \
       account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
       apns_environment = EXCLUDED.apns_environment, updated_at = NOW()";

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
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    register_push_token(
        pool,
        NOTIFICATION_TOKEN_UPSERT,
        account_id,
        device_id,
        device_token,
        environment,
    )
    .await
}

async fn register_push_token(
    pool: &PgPool,
    statement: &'static str,
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    let clean_token = device_token.trim().to_ascii_lowercase();
    let valid_token = (32..=200).contains(&clean_token.len())
        && clean_token.bytes().all(|value| value.is_ascii_hexdigit());
    if !valid_token || !matches!(environment, "development" | "production") {
        return Err(CallStoreError::InvalidPushToken);
    }
    query(statement)
        .bind(device_id)
        .bind(account_id)
        .bind(clean_token)
        .bind(environment)
        .execute(pool)
        .await?;
    Ok(())
}
