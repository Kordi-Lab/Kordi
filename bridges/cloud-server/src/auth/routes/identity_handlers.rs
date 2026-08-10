use super::*;

pub(super) async fn auth_capabilities() -> Json<AuthCapabilitiesResponse> {
    Json(AuthCapabilitiesResponse {
        password: true,
        oauth_providers: OAuthProvider::ALL
            .into_iter()
            .filter(|provider| oauth_provider_is_configured(*provider))
            .map(OAuthProvider::id)
            .collect(),
    })
}

pub(super) async fn oauth_start(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    Query(start_query): Query<OAuthStartQuery>,
) -> Response {
    let Some(provider) = OAuthProvider::parse(&provider) else {
        return err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        );
    };
    if !is_allowed_oauth_redirect(&start_query.redirect_after) {
        return err(
            "invalid_redirect",
            "OAuth redirect target is not allowed.",
            StatusCode::BAD_REQUEST,
        );
    }
    let config = match oauth_config(provider) {
        Ok(config) => config,
        Err(message) => {
            return err(
                "oauth_not_configured",
                message,
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    };

    let state_id = random_url_token("oauth_state");
    let code_verifier = random_url_token("oauth_verifier");
    let now = Utc::now();
    let expires = now + ChronoDuration::minutes(10);
    if query(
        "INSERT INTO cloud_oauth_states (state_id, provider, redirect_after, code_verifier, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&state_id)
    .bind(provider.id())
    .bind(start_query.redirect_after.trim())
    .bind(&code_verifier)
    .bind(now.to_rfc3339())
    .bind(expires.to_rfc3339())
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err("server_error", "Could not create OAuth state.", StatusCode::INTERNAL_SERVER_ERROR);
    }

    let mut auth_url = url::Url::parse(provider.auth_url()).expect("valid OAuth provider auth url");
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", provider.scope())
        .append_pair("state", &state_id)
        .append_pair("code_challenge", &pkce_challenge(&code_verifier))
        .append_pair("code_challenge_method", "S256");
    if provider == OAuthProvider::Google {
        auth_url
            .query_pairs_mut()
            .append_pair("access_type", "online");
    }

    Json(OAuthStartResponse {
        auth_url: auth_url.to_string(),
    })
    .into_response()
}

pub(super) async fn oauth_callback(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider_path): axum::extract::Path<String>,
    Query(query_params): Query<OAuthCallbackQuery>,
) -> Response {
    let Some(provider) = OAuthProvider::parse(&provider_path) else {
        return err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(state_id) = query_params
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return err(
            "invalid_oauth_state",
            "Missing OAuth state.",
            StatusCode::BAD_REQUEST,
        );
    };

    let pool = state.db_pool();
    let state_row: Option<(String, String, Option<String>, String)> = match query_as(
        "DELETE FROM cloud_oauth_states WHERE state_id = $1 RETURNING provider, redirect_after, code_verifier, expires_at",
    )
    .bind(state_id)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row,
        Err(_) => return err("server_error", "Could not load OAuth state.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some((stored_provider, redirect_after, code_verifier, expires_at)) = state_row else {
        return err(
            "invalid_oauth_state",
            "OAuth state expired or was already used.",
            StatusCode::BAD_REQUEST,
        );
    };
    if stored_provider != provider.id() || !is_allowed_oauth_redirect(&redirect_after) {
        return err(
            "invalid_oauth_state",
            "OAuth state is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    if chrono::DateTime::parse_from_rfc3339(&expires_at)
        .map(|value| value < Utc::now())
        .unwrap_or(true)
    {
        return redirect_with_oauth_error(&redirect_after, "OAuth state expired.");
    }
    if let Some(provider_error) = query_params.error.as_deref() {
        return redirect_with_oauth_error(&redirect_after, provider_error);
    }
    let Some(code) = query_params
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return redirect_with_oauth_error(&redirect_after, "Missing OAuth code.");
    };
    let config = match oauth_config(provider) {
        Ok(config) => config,
        Err(message) => return redirect_with_oauth_error(&redirect_after, &message),
    };
    let http = reqwest::Client::new();
    let access_token = match exchange_oauth_code(&http, &config, code, code_verifier.as_deref())
        .await
    {
        Ok(token) => token,
        Err(_) => {
            return redirect_with_oauth_error(&redirect_after, "Could not exchange OAuth code.");
        }
    };
    let profile = match fetch_oauth_profile(&http, provider, &access_token).await {
        Ok(profile) if !profile.provider_subject.trim().is_empty() => profile,
        _ => return redirect_with_oauth_error(&redirect_after, "Could not load OAuth profile."),
    };

    match complete_oauth_login(pool, provider, profile).await {
        Ok(body) => {
            let mut url = redirect_after;
            let separator = if url.contains('#') { '&' } else { '#' };
            url.push(separator);
            url.push_str("kordi_cloud_oauth=");
            url.push_str(&encode_oauth_fragment(&body));
            Redirect::to(&url).into_response()
        }
        Err(error) => {
            eprintln!(
                "[cloud-auth] OAuth login completion failed for {}: {error}",
                provider.id()
            );
            redirect_with_oauth_error(&redirect_after, "Could not finish OAuth login.")
        }
    }
}

pub(super) fn oauth_account_avatar_url(
    existing_avatar_url: Option<&str>,
    provider_avatar_url: Option<&str>,
) -> Option<String> {
    let existing = existing_avatar_url.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });
    let provider = provider_avatar_url.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });

    if provider.is_some()
        && existing.as_deref().is_none_or(|value| {
            value.starts_with(AVATAR_SEED_PREFIX) || !value.starts_with("data:")
        })
    {
        return provider;
    }

    existing.or(provider)
}

pub(super) async fn complete_oauth_login(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
) -> Result<AuthResponse, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let normalized_email = profile
        .email
        .as_deref()
        .and_then(|email| validate_email(email).ok());
    let existing_identity: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_account_identities WHERE provider = $1 AND provider_subject = $2",
    )
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .fetch_optional(pool)
    .await?;
    let linked_email_account: Option<(String,)> =
        if existing_identity.is_none() && profile.email_verified {
            if let Some(email) = normalized_email.as_deref() {
                query_as("SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = $1")
                    .bind(email)
                    .fetch_optional(pool)
                    .await?
            } else {
                None
            }
        } else {
            None
        };
    let account_id = existing_identity
        .or(linked_email_account)
        .map(|row| row.0)
        .unwrap_or_else(|| format!("acct_{}", uuid::Uuid::new_v4().simple()));
    let display_name = clean_profile_display_name(profile.display_name.as_deref())
        .or_else(|| profile.username.clone());
    let provider_avatar_url = clean_profile_avatar_url(profile.avatar_url.as_deref());
    let existing_account_avatar_url: Option<(Option<String>,)> =
        query_as("SELECT avatar_url FROM cloud_accounts WHERE account_id = $1")
            .bind(&account_id)
            .fetch_optional(pool)
            .await?;
    let avatar_url = oauth_account_avatar_url(
        existing_account_avatar_url
            .as_ref()
            .and_then(|row| row.0.as_deref()),
        provider_avatar_url.as_deref(),
    );

    let mut tx = pool.begin().await?;
    query(
        "INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5) \
         ON CONFLICT (account_id) DO UPDATE SET \
           display_name = COALESCE(cloud_accounts.display_name, excluded.display_name), \
           primary_email = COALESCE(cloud_accounts.primary_email, excluded.primary_email), \
           avatar_url = excluded.avatar_url, \
           updated_at = excluded.updated_at",
    )
    .bind(&account_id)
    .bind(display_name.as_deref())
    .bind(normalized_email.as_deref())
    .bind(avatar_url.as_deref())
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let identity_id = format!("oauth_{}_{}", provider.id(), uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_account_identities \
         (identity_id, account_id, provider, provider_subject, provider_username, \
          email, email_verified, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) \
         ON CONFLICT (provider, provider_subject) DO UPDATE SET \
           account_id = excluded.account_id, \
           provider_username = excluded.provider_username, \
           email = excluded.email, \
           email_verified = excluded.email_verified, \
           avatar_url = excluded.avatar_url, \
           updated_at = excluded.updated_at",
    )
    .bind(&identity_id)
    .bind(&account_id)
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .bind(profile.username.as_deref())
    .bind(normalized_email.as_deref())
    .bind(profile.email_verified)
    .bind(avatar_url.as_deref())
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("oauth-{}-device", provider.id()))
    .bind(&device_public_key)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    let issued = issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    .map_err(|_| sqlx_core::Error::Protocol("Could not issue OAuth session.".into()))?;
    tx.commit().await?;

    let account = account_response_row(pool, &account_id)
        .await?
        .ok_or(sqlx_core::Error::RowNotFound)?;
    Ok(AuthResponse {
        account,
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
        },
    })
}

#[cfg(test)]
mod tests;
