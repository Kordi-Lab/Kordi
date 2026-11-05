//! Email sign-up for an address that already belongs to a Kordi account.
//!
//! An account created through Google or GitHub has no password. Signing up
//! with the same email must not create a second account: once the emailed
//! code proves ownership of the address, the password is added to the
//! existing account and the caller is signed in to it. Every other match
//! keeps the existing `email_in_use` answer.

use super::*;

/// What the sign-up lookup found for the requested email.
pub(super) struct ExistingEmailAccount {
    pub(super) account_id: String,
    pub(super) has_password: bool,
    pub(super) email_verified: bool,
}

impl ExistingEmailAccount {
    /// A password may be added only to an account without one whose own
    /// email ownership is verified. An unverified address on an existing
    /// account was never proven by its holder, so a code from the inbox
    /// cannot hand that account to whoever reads the inbox.
    pub(super) fn accepts_password(&self) -> bool {
        !self.has_password && self.email_verified
    }
}

pub(super) async fn existing_email_account(
    pool: &PgPool,
    normalized_email: &str,
) -> Result<Option<ExistingEmailAccount>, sqlx_core::Error> {
    let row: Option<(String, bool, bool)> = query_as(
        "SELECT account_id, password_hash IS NOT NULL, primary_email_verified_at IS NOT NULL \
         FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(normalized_email)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(account_id, has_password, email_verified)| ExistingEmailAccount {
            account_id,
            has_password,
            email_verified,
        },
    ))
}

pub(super) fn email_in_use() -> Response {
    err(
        "email_in_use",
        "An account with this email already exists.",
        StatusCode::CONFLICT,
    )
}

pub(super) struct PasswordForExistingAccount<'a> {
    pub(super) state: &'a ServerState,
    pub(super) rate_limiter: &'a CloudRateLimiter,
    pub(super) hasher_config: PasswordHasherConfig,
    pub(super) peer_ip: Option<std::net::IpAddr>,
    pub(super) account_id: &'a str,
    pub(super) normalized_email: &'a str,
    pub(super) password: &'a str,
    pub(super) display_name: Option<&'a str>,
    pub(super) registration: &'a NormalizedDeviceRegistration,
    pub(super) email_service: &'a crate::auth::signup_email::SignupEmailService,
    pub(super) verification_id: &'a str,
    pub(super) verification_code: &'a str,
}

/// Adds a password to an existing passwordless account after the emailed code
/// proves the caller owns its verified email, then signs in to that account.
/// The account keeps its profile, avatar, devices, and sessions; the new
/// device waits for review like any other sign-in to an existing account.
pub(super) async fn add_password_to_existing_account(
    request: PasswordForExistingAccount<'_>,
) -> Response {
    let PasswordForExistingAccount {
        state,
        rate_limiter,
        hasher_config,
        peer_ip,
        account_id,
        normalized_email,
        password,
        display_name,
        registration,
        email_service,
        verification_id,
        verification_code,
    } = request;
    let pool = state.db_pool();
    let password_hash = match tokio::task::spawn_blocking({
        let plaintext = password.to_string();
        move || hash_password(&plaintext, hasher_config)
    })
    .await
    {
        Ok(Ok(hash)) => hash,
        _ => {
            return err(
                "server_error",
                "Could not hash password.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let now = Utc::now().to_rfc3339();
    let Ok(mut tx) = pool.begin().await else {
        return err(
            "server_error",
            "Could not start transaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    if let Err(error) = crate::auth::signup_email::consume_signup_code(
        &mut tx,
        email_service,
        normalized_email,
        verification_id,
        verification_code,
    )
    .await
    {
        // Failed guesses must survive; the account has not been changed.
        if tx.commit().await.is_err() {
            return super::super::signup_email_handlers::signup_code_error(
                crate::auth::signup_email::SignupCodeError::Database,
            );
        }
        return super::super::signup_email_handlers::signup_code_error(error);
    }
    if let Err(error) = state
        .admission()
        .admit_identity(pool, Some(normalized_email), true)
        .await
    {
        if tx.commit().await.is_err() {
            return crate::auth::admission::AdmissionError::Unavailable.response();
        }
        return error.response();
    }
    // Re-checked under the row lock: a password set or an email change since
    // the lookup leaves the account untouched and keeps the conflict answer.
    let updated = query(
        "UPDATE cloud_accounts SET password_hash = $3, password_algorithm = $4, \
           password_updated_at = $5, updated_at = $5, \
           display_name = COALESCE(display_name, $6) \
         WHERE account_id = $1 AND password_hash IS NULL \
           AND primary_email_verified_at IS NOT NULL \
           AND primary_email IS NOT NULL AND LOWER(primary_email) = $2",
    )
    .bind(account_id)
    .bind(normalized_email)
    .bind(&password_hash)
    .bind(PASSWORD_ALGORITHM_ID)
    .bind(&now)
    .bind(display_name)
    .execute(&mut *tx)
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return email_in_use(),
        Err(_) => {
            return err(
                "server_error",
                "Could not update account.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    let Ok(authorized_device) =
        authorize_device(&mut tx, account_id, registration, "pending_review").await
    else {
        return err(
            "server_error",
            "Could not register device.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    let device_id = authorized_device.device_id;
    let Ok(issued) = issue_session(
        &mut *tx,
        account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    else {
        return err(
            "server_error",
            "Could not issue session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    let _ = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(&device_id)
    .bind("auth.password.added")
    .bind(serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string()), "via": "signup"}).to_string())
    .bind(&now)
    .execute(&mut *tx)
    .await;
    if authorized_device.is_new_authorization
        && append_device_sync_event(
            &mut tx,
            account_id,
            "device.added",
            &device_id,
            registration.display_name.as_deref(),
            "pending_review",
        )
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not record device authorization.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit signup.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    rate_limiter
        .record_login_success(normalized_email, peer_ip)
        .await;
    if authorized_device.is_new_authorization {
        let events = state.events().clone();
        let published_account_id = account_id.to_string();
        let published_device_id = device_id.clone();
        tokio::spawn(async move {
            events
                .publish_device_event(&published_account_id, "added", &published_device_id)
                .await;
        });
    }

    let account = match owner_account_response_row(pool, account_id).await {
        Ok(Some(account)) => account,
        _ => {
            return err(
                "server_error",
                "Could not load account.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let body = AuthResponse {
        account,
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
            device_id,
        },
    };
    (StatusCode::OK, Json(body)).into_response()
}
