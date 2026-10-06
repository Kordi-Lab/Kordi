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
    /// The account's primary email was verified before a code could be sent.
    /// Only account challenges report it.
    AlreadyVerified,
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

/// A charged send: whether it created the row, and the counters the row held
/// before this request when it already existed.
struct StoredCode {
    inserted: bool,
    previous: Option<SendBudget>,
}

struct SendBudget {
    send_count: i32,
    resend_after: DateTime<Utc>,
    window_started_at: DateTime<Utc>,
}

impl<'row> sqlx_core::from_row::FromRow<'row, sqlx_postgres::PgRow> for SendBudget {
    fn from_row(row: &'row sqlx_postgres::PgRow) -> Result<Self, sqlx_core::Error> {
        use sqlx_core::row::Row;
        Ok(Self {
            send_count: row.try_get("send_count")?,
            resend_after: row.try_get("resend_after")?,
            window_started_at: row.try_get("window_started_at")?,
        })
    }
}

impl From<sqlx_core::Error> for SignupCodeError {
    fn from(_: sqlx_core::Error) -> Self {
        Self::Database
    }
}

/// Which code table a challenge lives in. Signup challenges are keyed by the
/// email being claimed; account challenges are keyed by the signed-in account
/// and also record the primary email the code was sent to. Both share every
/// expiry, guess, cooldown, and send budget rule.
#[derive(Clone, Copy)]
enum CodeScope<'a> {
    Signup { email: &'a str },
    Account { account_id: &'a str, email: &'a str },
}

impl<'a> CodeScope<'a> {
    fn table(self) -> &'static str {
        match self {
            Self::Signup { .. } => "cloud_signup_email_codes",
            Self::Account { .. } => "cloud_account_email_codes",
        }
    }

    fn key_column(self) -> &'static str {
        match self {
            Self::Signup { .. } => "email",
            Self::Account { .. } => "account_id",
        }
    }

    fn key(self) -> &'a str {
        match self {
            Self::Signup { email } => email,
            Self::Account { account_id, .. } => account_id,
        }
    }

    fn email(self) -> &'a str {
        match self {
            Self::Signup { email } | Self::Account { email, .. } => email,
        }
    }
}

pub(crate) async fn request_signup_code(
    pool: &PgPool,
    service: &SignupEmailService,
    email: &str,
) -> Result<SignupCodeChallenge, SignupCodeError> {
    request_code(pool, service, CodeScope::Signup { email }).await
}

/// Sends a code proving that the signed-in account can read `email`, its
/// normalized primary email.
pub(crate) async fn request_account_email_code(
    pool: &PgPool,
    service: &SignupEmailService,
    account_id: &str,
    email: &str,
) -> Result<SignupCodeChallenge, SignupCodeError> {
    request_code(pool, service, CodeScope::Account { account_id, email }).await
}

/// The caller commits failed guesses and consumes successful codes with account creation.
pub(crate) async fn consume_signup_code(
    tx: &mut Transaction<'_, Postgres>,
    service: &SignupEmailService,
    email: &str,
    id: &str,
    code: &str,
) -> Result<(), SignupCodeError> {
    consume_code(tx, service, CodeScope::Signup { email }, id, code).await
}

/// The caller commits failed guesses and consumes successful codes together
/// with marking the account's primary email verified.
pub(crate) async fn consume_account_email_code(
    tx: &mut Transaction<'_, Postgres>,
    service: &SignupEmailService,
    account_id: &str,
    email: &str,
    id: &str,
    code: &str,
) -> Result<(), SignupCodeError> {
    consume_code(
        tx,
        service,
        CodeScope::Account { account_id, email },
        id,
        code,
    )
    .await
}

async fn request_code(
    pool: &PgPool,
    service: &SignupEmailService,
    scope: CodeScope<'_>,
) -> Result<SignupCodeChallenge, SignupCodeError> {
    let (table, key_column, key, email) = (
        scope.table(),
        scope.key_column(),
        scope.key(),
        scope.email(),
    );
    // Account challenges also record the recipient, which a resend replaces.
    let (recipient_column, recipient_value, recipient_update) = match scope {
        CodeScope::Signup { .. } => ("", "", ""),
        CodeScope::Account { .. } => (", email", ", $7", "email = EXCLUDED.email, "),
    };
    let now = Utc::now();
    let id = format!("email_{}", uuid::Uuid::new_v4().simple());
    let code = new_code();
    let expires_at = now + Duration::minutes(10);
    // The send budget is charged before delivery so concurrent requests cannot
    // overspend it. The counters this request replaces are read under the same
    // row lock so a failed delivery can hand the charge back. The transaction
    // ends before the code is sent.
    let mut tx = pool.begin().await?;
    if let CodeScope::Account { account_id, .. } = scope {
        // Serializes with verification, which holds this row for update, so no
        // send is charged for an account that has just been verified. The
        // lock ends with this transaction, before the code is sent.
        let unverified: Option<(i32,)> = query_as(
            "SELECT 1 FROM cloud_accounts \
             WHERE account_id = $1 AND primary_email_verified_at IS NULL FOR SHARE",
        )
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?;
        if unverified.is_none() {
            return Err(SignupCodeError::AlreadyVerified);
        }
    }
    let previous: Option<SendBudget> = query_as(&format!(
        "SELECT send_count, resend_after, window_started_at FROM {table} \
         WHERE {key_column} = $1 FOR UPDATE"
    ))
    .bind(key)
    .fetch_optional(&mut *tx)
    .await?;
    let upsert = format!(
        "INSERT INTO {table} \
         ({key_column}{recipient_column}, verification_id, code_mac, expires_at, resend_after, window_started_at, send_count, attempts_remaining) \
         VALUES ($1{recipient_value}, $2, $3, $4, $5, $6, 1, 5) \
         ON CONFLICT ({key_column}) DO UPDATE SET {recipient_update}\
           verification_id = EXCLUDED.verification_id, code_mac = EXCLUDED.code_mac, \
           expires_at = EXCLUDED.expires_at, resend_after = EXCLUDED.resend_after, \
           window_started_at = CASE WHEN {table}.window_started_at <= $6 - INTERVAL '1 hour' \
             THEN $6 ELSE {table}.window_started_at END, \
           send_count = CASE WHEN {table}.window_started_at <= $6 - INTERVAL '1 hour' \
             THEN 1 ELSE {table}.send_count + 1 END, \
           attempts_remaining = 5, delivered_at = NULL, consumed_at = NULL \
         WHERE {table}.resend_after <= $6 \
           AND ({table}.window_started_at <= $6 - INTERVAL '1 hour' \
                OR {table}.send_count < 5) \
         RETURNING (xmax = 0)"
    );
    let mut upsert = query_as(&upsert)
        .bind(key)
        .bind(&id)
        .bind(service.digest(&id, email, &code))
        .bind(expires_at)
        .bind(now + Duration::seconds(60))
        .bind(now);
    if let CodeScope::Account { .. } = scope {
        upsert = upsert.bind(email);
    }
    let inserted: Option<(bool,)> = upsert.fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    let stored = inserted.map(|(inserted,)| StoredCode { inserted, previous });
    let Some(stored) = stored else {
        let (resend_after, window_started_at, send_count): (DateTime<Utc>, DateTime<Utc>, i32) = query_as(&format!(
            "SELECT resend_after, window_started_at, send_count FROM {table} WHERE {key_column} = $1",
        )).bind(key).fetch_one(pool).await?;
        let next = if send_count >= 5 {
            resend_after.max(window_started_at + Duration::hours(1))
        } else {
            resend_after
        };
        return Err(SignupCodeError::Limited(
            (next - now).num_seconds().max(1) as u64
        ));
    };
    if service.sender.send_code(email, &code).await.is_err() {
        // Hand back the charge while keeping the undelivered challenge
        // unusable. A first request removes its row, since `send_count` cannot
        // be zero. If another request inserted the row between our locking read
        // and the upsert, the counters it held are unknown and stay charged.
        if stored.inserted {
            query(&format!("DELETE FROM {table} WHERE verification_id = $1"))
                .bind(&id)
                .execute(pool)
                .await?;
        } else {
            let previous = stored.previous.as_ref();
            query(&format!(
                "UPDATE {table} SET attempts_remaining = 0, \
                 send_count = COALESCE($2, send_count), resend_after = COALESCE($3, resend_after), \
                 window_started_at = COALESCE($4, window_started_at) \
                 WHERE verification_id = $1"
            ))
            .bind(&id)
            .bind(previous.map(|budget| budget.send_count))
            .bind(previous.map(|budget| budget.resend_after))
            .bind(previous.map(|budget| budget.window_started_at))
            .execute(pool)
            .await?;
        }
        return Err(SignupCodeError::Unavailable);
    }
    query(&format!(
        "UPDATE {table} SET delivered_at = NOW() WHERE verification_id = $1"
    ))
    .bind(&id)
    .execute(pool)
    .await?;
    Ok(SignupCodeChallenge {
        verification_id: id,
        expires_at: expires_at.to_rfc3339(),
        retry_after_seconds: 60,
    })
}

async fn consume_code(
    tx: &mut Transaction<'_, Postgres>,
    service: &SignupEmailService,
    scope: CodeScope<'_>,
    id: &str,
    code: &str,
) -> Result<(), SignupCodeError> {
    let (table, key_column, email) = (scope.table(), scope.key_column(), scope.email());
    // A challenge sent to another email is not found, so a proof for a
    // different recipient cannot spend the owner's guesses. For signup the key
    // column is the email itself and the extra condition is redundant.
    let row: Option<CodeRecord> = query_as(&format!(
        "SELECT code_mac, expires_at, attempts_remaining, delivered_at, consumed_at \
         FROM {table} WHERE {key_column} = $1 AND verification_id = $2 AND email = $3 FOR UPDATE"
    ))
    .bind(scope.key())
    .bind(id)
    .bind(email)
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
        query(&format!("UPDATE {table} SET attempts_remaining = attempts_remaining - 1 WHERE verification_id = $1"))
            .bind(id).execute(&mut **tx).await?;
        return Err(SignupCodeError::Invalid);
    }
    query(&format!(
        "UPDATE {table} SET consumed_at = NOW(), attempts_remaining = 0 WHERE verification_id = $1"
    ))
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
