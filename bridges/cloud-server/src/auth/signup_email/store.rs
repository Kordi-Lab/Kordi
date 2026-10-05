use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupCodeChallenge {
    pub verification_id: String,
    pub expires_at: String,
    pub retry_after_seconds: u64,
}

pub(crate) enum SignupCodeError {
    Invalid,
    Limited(u64),
    Unavailable,
    Database,
}

struct CodeRecord {
    code_mac: Vec<u8>,
    expires_at: DateTime<Utc>,
    attempts_remaining: i32,
    delivered_at: Option<DateTime<Utc>>,
    consumed_at: Option<DateTime<Utc>>,
}

impl<'row> sqlx_core::from_row::FromRow<'row, sqlx_postgres::PgRow> for CodeRecord {
    fn from_row(row: &'row sqlx_postgres::PgRow) -> Result<Self, sqlx_core::Error> {
        use sqlx_core::row::Row;
        Ok(Self {
            code_mac: row.try_get("code_mac")?,
            expires_at: row.try_get("expires_at")?,
            attempts_remaining: row.try_get("attempts_remaining")?,
            delivered_at: row.try_get("delivered_at")?,
            consumed_at: row.try_get("consumed_at")?,
        })
    }
}

impl From<sqlx_core::Error> for SignupCodeError {
    fn from(_: sqlx_core::Error) -> Self {
        Self::Database
    }
}

pub(crate) async fn request_signup_code(
    pool: &PgPool,
    service: &SignupEmailService,
    email: &str,
) -> Result<SignupCodeChallenge, SignupCodeError> {
    let now = Utc::now();
    let id = format!("email_{}", uuid::Uuid::new_v4().simple());
    let code = new_code();
    let expires_at = now + Duration::minutes(10);
    let stored: Option<(String,)> = query_as(
        "INSERT INTO cloud_signup_email_codes \
         (email, verification_id, code_mac, expires_at, resend_after, window_started_at, send_count, attempts_remaining) \
         VALUES ($1, $2, $3, $4, $5, $6, 1, 5) \
         ON CONFLICT (email) DO UPDATE SET \
           verification_id = EXCLUDED.verification_id, code_mac = EXCLUDED.code_mac, \
           expires_at = EXCLUDED.expires_at, resend_after = EXCLUDED.resend_after, \
           window_started_at = CASE WHEN cloud_signup_email_codes.window_started_at <= $6 - INTERVAL '1 hour' \
             THEN $6 ELSE cloud_signup_email_codes.window_started_at END, \
           send_count = CASE WHEN cloud_signup_email_codes.window_started_at <= $6 - INTERVAL '1 hour' \
             THEN 1 ELSE cloud_signup_email_codes.send_count + 1 END, \
           attempts_remaining = 5, delivered_at = NULL, consumed_at = NULL \
         WHERE cloud_signup_email_codes.resend_after <= $6 \
           AND (cloud_signup_email_codes.window_started_at <= $6 - INTERVAL '1 hour' \
                OR cloud_signup_email_codes.send_count < 5) \
         RETURNING verification_id",
    )
    .bind(email).bind(&id).bind(service.digest(&id, email, &code))
    .bind(expires_at).bind(now + Duration::seconds(60)).bind(now)
    .fetch_optional(pool).await?;
    if stored.is_none() {
        let (resend_after, window_started_at, send_count): (DateTime<Utc>, DateTime<Utc>, i32) = query_as(
            "SELECT resend_after, window_started_at, send_count FROM cloud_signup_email_codes WHERE email = $1",
        ).bind(email).fetch_one(pool).await?;
        let next = if send_count >= 5 {
            resend_after.max(window_started_at + Duration::hours(1))
        } else {
            resend_after
        };
        return Err(SignupCodeError::Limited(
            (next - now).num_seconds().max(1) as u64
        ));
    }
    if service.sender.send_code(email, &code).await.is_err() {
        query(
            "UPDATE cloud_signup_email_codes SET attempts_remaining = 0 WHERE verification_id = $1",
        )
        .bind(&id)
        .execute(pool)
        .await?;
        return Err(SignupCodeError::Unavailable);
    }
    query("UPDATE cloud_signup_email_codes SET delivered_at = NOW() WHERE verification_id = $1")
        .bind(&id)
        .execute(pool)
        .await?;
    Ok(SignupCodeChallenge {
        verification_id: id,
        expires_at: expires_at.to_rfc3339(),
        retry_after_seconds: 60,
    })
}

/// The caller commits failed guesses and consumes successful codes with account creation.
pub(crate) async fn consume_signup_code(
    tx: &mut Transaction<'_, Postgres>,
    service: &SignupEmailService,
    email: &str,
    id: &str,
    code: &str,
) -> Result<(), SignupCodeError> {
    let row: Option<CodeRecord> = query_as(
        "SELECT code_mac, expires_at, attempts_remaining, delivered_at, consumed_at \
         FROM cloud_signup_email_codes WHERE email = $1 AND verification_id = $2 FOR UPDATE",
    )
    .bind(email)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Err(SignupCodeError::Invalid);
    };
    if row.expires_at <= Utc::now()
        || row.attempts_remaining <= 0
        || row.delivered_at.is_none()
        || row.consumed_at.is_some()
    {
        return Err(SignupCodeError::Invalid);
    }
    if code.len() != 6
        || !code.bytes().all(|byte| byte.is_ascii_digit())
        || !service.matches(id, email, code, &row.code_mac)
    {
        query("UPDATE cloud_signup_email_codes SET attempts_remaining = attempts_remaining - 1 WHERE verification_id = $1")
            .bind(id).execute(&mut **tx).await?;
        return Err(SignupCodeError::Invalid);
    }
    query("UPDATE cloud_signup_email_codes SET consumed_at = NOW(), attempts_remaining = 0 WHERE verification_id = $1")
        .bind(id).execute(&mut **tx).await?;
    Ok(())
}
