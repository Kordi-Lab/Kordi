use super::*;

#[cfg(test)]
pub(super) async fn complete_oauth_login(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
    registration: &NormalizedDeviceRegistration,
) -> Result<(AuthResponse, bool), OAuthLoginError> {
    complete_oauth_login_with_policy(pool, provider, profile, registration, &Default::default())
        .await
}

pub(super) async fn complete_oauth_login_with_policy(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
    registration: &NormalizedDeviceRegistration,
    policy: &crate::auth::admission::AdmissionPolicy,
) -> Result<(AuthResponse, bool), OAuthLoginError> {
    let now = Utc::now().to_rfc3339();
    let normalized_email = profile
        .email
        .as_deref()
        .and_then(|email| validate_email(email).ok());
    policy
        .admit_identity(pool, normalized_email.as_deref(), profile.email_verified)
        .await
        .map_err(OAuthLoginError::Admission)?;
    let existing_identity: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_account_identities WHERE provider = $1 AND provider_subject = $2",
    )
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .fetch_optional(pool)
    .await?;
    let linked_email_account = match (&existing_identity, normalized_email.as_deref()) {
        (None, Some(email)) => linkable_email_account(pool, email, profile.email_verified).await?,
        _ => None,
    };
    let links_by_email = linked_email_account.is_some();
    let account_id = existing_identity
        .map(|row| row.0)
        .or(linked_email_account)
        .unwrap_or_else(|| format!("acct_{}", uuid::Uuid::new_v4().simple()));
    let display_name = clean_profile_display_name(profile.display_name.as_deref())
        .or_else(|| profile.username.clone());
    let provider_avatar_url = clean_profile_avatar_url(profile.avatar_url.as_deref());
    let (avatar, is_new_account) =
        resolve_oauth_account_avatar(pool, &account_id, provider_avatar_url.as_deref(), &now)
            .await?;
    let canonical_avatar_url = avatar.image_url();

    let mut tx = pool.begin().await?;
    query(
        "INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at, \
            avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11) \
         ON CONFLICT (account_id) DO UPDATE SET \
           display_name = COALESCE(cloud_accounts.display_name, excluded.display_name), \
           primary_email = COALESCE(cloud_accounts.primary_email, excluded.primary_email), \
           avatar_url = excluded.avatar_url, \
           avatar_source = excluded.avatar_source, \
           avatar_style = excluded.avatar_style, \
           avatar_seed = excluded.avatar_seed, \
           avatar_renderer_version = excluded.avatar_renderer_version, \
           avatar_version = excluded.avatar_version, \
           avatar_updated_at = excluded.avatar_updated_at, \
           updated_at = excluded.updated_at",
    )
    .bind(&account_id)
    .bind(display_name.as_deref())
    .bind(normalized_email.as_deref())
    .bind(&canonical_avatar_url)
    .bind(&now)
    .bind(&avatar.source)
    .bind(&avatar.style)
    .bind(&avatar.seed)
    .bind(&avatar.renderer_version)
    .bind(avatar.version)
    .bind(&avatar.updated_at)
    .execute(&mut *tx)
    .await?;

    let identity_id = format!("oauth_{}_{}", provider.id(), uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_account_identities \
         (identity_id, account_id, provider, provider_subject, provider_username, \
          email, email_verified, avatar_url, created_at, updated_at, hosted_domain) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10) \
         ON CONFLICT (provider, provider_subject) DO UPDATE SET \
           account_id = excluded.account_id, \
           provider_username = excluded.provider_username, \
           email = excluded.email, \
           email_verified = excluded.email_verified, \
           avatar_url = excluded.avatar_url, \
           updated_at = excluded.updated_at, \
           hosted_domain = excluded.hosted_domain",
    )
    .bind(&identity_id)
    .bind(&account_id)
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .bind(profile.username.as_deref())
    .bind(normalized_email.as_deref())
    .bind(profile.email_verified)
    .bind(&canonical_avatar_url)
    .bind(&now)
    .bind(profile.hosted_domain.as_deref())
    .execute(&mut *tx)
    .await?;

    if links_by_email {
        // The new identity joined an account that already proved this email.
        query(
            "INSERT INTO cloud_audit_events \
             (event_id, account_id, device_id, event_type, metadata_json, created_at) \
             VALUES ($1, $2, NULL, 'auth.oauth.linked_by_email', $3, $4)",
        )
        .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
        .bind(&account_id)
        .bind(serde_json::json!({"provider": provider.id()}).to_string())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    if profile.email_verified {
        if let Some(email) = normalized_email.as_deref() {
            mark_primary_email_verified(&mut tx, &account_id, email, &now).await?;
        }
    }

    if policy.requires_verified_email() {
        let (email, verified): (Option<String>, bool) = query_as("SELECT primary_email, primary_email_verified_at IS NOT NULL FROM cloud_accounts WHERE account_id = $1")
            .bind(&account_id).fetch_one(&mut *tx).await?;
        policy
            .check(email.as_deref(), verified)
            .map_err(OAuthLoginError::Admission)?;
    }
    let authorization_state = if is_new_account {
        "confirmed"
    } else {
        "pending_review"
    };
    let authorized_device =
        authorize_device(&mut tx, &account_id, registration, authorization_state).await?;
    let is_new_authorization = authorized_device.is_new_authorization;
    let device_id = authorized_device.device_id;
    if is_new_authorization {
        append_device_sync_event(
            &mut tx,
            &account_id,
            "device.added",
            &device_id,
            registration.display_name.as_deref(),
            authorization_state,
        )
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not append device sync event.".into()))?;
    }
    let issued = issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    .map_err(|_| sqlx_core::Error::Protocol("Could not issue OAuth session.".into()))?;
    tx.commit().await?;

    let account = owner_account_response_row(pool, &account_id)
        .await?
        .ok_or(sqlx_core::Error::RowNotFound)?;
    Ok((
        AuthResponse {
            account,
            session: SessionResponse {
                token: issued.plaintext_token,
                expires_at: issued.expires_at.to_rfc3339(),
                device_id,
            },
        },
        is_new_authorization,
    ))
}

#[cfg(test)]
mod tests;
