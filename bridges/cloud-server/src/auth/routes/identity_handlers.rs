use super::*;
use crate::organizations::admission::hooks::record_sign_in;
use crate::organizations::admission::{SignInEvidence, SignInMethod};

#[cfg(test)]
mod account_linking_tests;
mod completion;
mod email_linking;
#[cfg(test)]
mod verified_email_tests;
#[cfg(test)]
use completion::complete_oauth_login;
use completion::{complete_oauth_sign_in, OAuthSignIn};
use email_linking::{
    existing_email_account_message, linkable_email_account, mark_primary_email_verified,
    OAuthLoginError, OAUTH_EMAIL_REQUIRES_SIGN_IN,
};

type OAuthStateRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(super) async fn auth_capabilities(
    State(state): State<Arc<ServerState>>,
) -> Json<AuthCapabilitiesResponse> {
    Json(AuthCapabilitiesResponse {
        password: true,
        admission: state.admission().public_policy(),
        oauth_providers: OAuthProvider::ALL
            .into_iter()
            .filter(|provider| oauth_provider_is_configured(*provider))
            .map(OAuthProvider::id)
            .collect(),
        // Without the provider-auth cipher nothing can be connected, so the
        // section stays hidden.
        connectors_version: state
            .connectors()
            .cipher
            .is_some()
            .then_some(crate::connectors::CONNECTORS_VERSION),
        memory_version: 3,
        common_ground: crate::common_ground::capabilities(&state),
        contact_profile_version: CONTACT_PROFILE_VERSION,
    })
}

pub(super) async fn oauth_start(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    Query(start_query): Query<OAuthStartQuery>,
) -> Response {
    match oauth_authorization_url(&state, &provider, &start_query, None).await {
        Ok(auth_url) => Json(OAuthStartResponse { auth_url }).into_response(),
        Err(response) => *response,
    }
}

/// Records a provider sign-in attempt and returns the provider page to open.
/// `web` binds a web page's sign-in to its browser. The error is a ready
/// response for the caller to return, boxed to keep the result small.
pub(super) async fn oauth_authorization_url(
    state: &ServerState,
    provider: &str,
    start_query: &OAuthStartQuery,
    web: Option<&WebOAuthStart>,
) -> Result<String, Box<Response>> {
    let Some(provider) = OAuthProvider::parse(provider) else {
        return Err(Box::new(err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        )));
    };
    // Only the web start, which binds the browser, may return to this
    // server's own pages.
    if !is_allowed_sign_in_redirect(&start_query.redirect_after)
        || (web.is_none() && targets_public_server(&start_query.redirect_after))
    {
        return Err(Box::new(err(
            "invalid_redirect",
            "OAuth redirect target is not allowed.",
            StatusCode::BAD_REQUEST,
        )));
    }
    let config = match oauth_config(provider) {
        Ok(config) => config,
        Err(message) => {
            return Err(Box::new(err(
                "oauth_not_configured",
                message,
                StatusCode::SERVICE_UNAVAILABLE,
            )));
        }
    };
    let registration = if let Some(public_key) = start_query.device_public_key.as_deref() {
        match normalize_device_registration(DeviceRegistrationRequest {
            display_name: start_query.device_name.clone(),
            platform: start_query.device_platform.clone(),
            os_version: start_query.device_os_version.clone(),
            app_version: start_query.device_app_version.clone(),
            approximate_location: start_query.device_approximate_location.clone(),
            public_key: public_key.to_string(),
            key_algorithm: start_query
                .device_key_algorithm
                .clone()
                .unwrap_or_else(|| "p256".to_string()),
        }) {
            Ok(value) => Some(value),
            Err(error) => {
                return Err(Box::new(err(
                    error.code(),
                    error.message(),
                    StatusCode::BAD_REQUEST,
                )))
            }
        }
    } else {
        None
    };

    let state_id = random_url_token("oauth_state");
    let code_verifier = random_url_token("oauth_verifier");
    let now = Utc::now();
    let expires = now + ChronoDuration::minutes(10);
    if query(
        "INSERT INTO cloud_oauth_states \
         (state_id, provider, redirect_after, code_verifier, created_at, expires_at, \
          device_name, device_public_key, device_key_algorithm, device_platform, \
          device_os_version, device_app_version, device_approximate_location, \
          browser_binding_hash, replaces_session_token_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    )
    .bind(&state_id)
    .bind(provider.id())
    .bind(start_query.redirect_after.trim())
    .bind(&code_verifier)
    .bind(now.to_rfc3339())
    .bind(expires.to_rfc3339())
    .bind(
        registration
            .as_ref()
            .and_then(|value| value.display_name.as_deref()),
    )
    .bind(registration.as_ref().map(|value| value.public_key.as_str()))
    .bind(
        registration
            .as_ref()
            .map(|value| value.key_algorithm.as_str()),
    )
    .bind(
        registration
            .as_ref()
            .and_then(|value| value.platform.as_deref()),
    )
    .bind(
        registration
            .as_ref()
            .and_then(|value| value.os_version.as_deref()),
    )
    .bind(
        registration
            .as_ref()
            .and_then(|value| value.app_version.as_deref()),
    )
    .bind(
        registration
            .as_ref()
            .and_then(|value| value.approximate_location.as_deref()),
    )
    .bind(web.map(|web| web.browser_binding_hash.as_str()))
    .bind(web.and_then(|web| web.replaces_session_token_id.as_deref()))
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return Err(Box::new(err(
            "server_error",
            "Could not create OAuth state.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )));
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

    Ok(auth_url.to_string())
}

pub(super) async fn oauth_callback(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider_path): axum::extract::Path<String>,
    Query(query_params): Query<OAuthCallbackQuery>,
    headers: HeaderMap,
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
    let state_row: Option<OAuthStateRow> = match query_as(
        "DELETE FROM cloud_oauth_states WHERE state_id = $1 \
         RETURNING provider, redirect_after, code_verifier, expires_at, device_name, \
                   device_public_key, device_key_algorithm, device_platform, \
                   device_os_version, device_app_version, device_approximate_location, \
                   browser_binding_hash, replaces_session_token_id",
    )
    .bind(state_id)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row,
        Err(_) => {
            return err(
                "server_error",
                "Could not load OAuth state.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let Some((
        stored_provider,
        redirect_after,
        code_verifier,
        expires_at,
        device_name,
        device_public_key,
        device_key_algorithm,
        device_platform,
        device_os_version,
        device_app_version,
        device_approximate_location,
        browser_binding_hash,
        replaces_session_token_id,
    )) = state_row
    else {
        return err(
            "invalid_oauth_state",
            "OAuth state expired or was already used.",
            StatusCode::BAD_REQUEST,
        );
    };
    if stored_provider != provider.id() || !is_allowed_sign_in_redirect(&redirect_after) {
        return err(
            "invalid_oauth_state",
            "OAuth state is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    // A return to this server's pages is a web sign-in: it sets the session
    // cookie, never a URL fragment, and must finish in the browser that
    // started it. The state is already consumed.
    let web_return_to = web_oauth_return_to(&redirect_after);
    if targets_public_server(&redirect_after) {
        if web_return_to.is_none() {
            return err(
                "invalid_oauth_state",
                "OAuth state is invalid.",
                StatusCode::BAD_REQUEST,
            );
        }
        if !browser_binding_matches(&headers, browser_binding_hash.as_deref()) {
            return web_oauth_binding_rejected(&redirect_after);
        }
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
    let tokens = match exchange_oauth_code(&http, &config, code, code_verifier.as_deref()).await {
        Ok(tokens) => tokens,
        Err(_) => {
            return redirect_with_oauth_error(&redirect_after, "Could not exchange OAuth code.");
        }
    };
    let profile = match fetch_oauth_profile(&http, &config, &tokens).await {
        Ok(Some(profile)) if !profile.provider_subject.trim().is_empty() => profile,
        _ => return redirect_with_oauth_error(&redirect_after, "Could not load OAuth profile."),
    };
    let evidence_email = profile
        .email
        .as_deref()
        .and_then(|e| validate_email(e).ok());
    let evidence_hd = profile.hosted_domain.clone();
    let registration = if let (Some(public_key), Some(key_algorithm)) =
        (device_public_key, device_key_algorithm)
    {
        NormalizedDeviceRegistration {
            display_name: device_name,
            platform: device_platform,
            os_version: device_os_version,
            app_version: device_app_version,
            approximate_location: device_approximate_location,
            public_key,
            key_algorithm,
        }
    } else {
        legacy_device_registration(&format!("oauth-{}-device", provider.id()))
    };

    match complete_oauth_sign_in(pool, provider, profile, &registration, state.admission()).await {
        Ok(OAuthSignIn {
            body,
            is_new_authorization,
            evidence_verified,
        }) => {
            let method = match provider {
                OAuthProvider::Google => SignInMethod::Google,
                OAuthProvider::Github => SignInMethod::Github,
            };
            let evidence = SignInEvidence {
                method,
                email: evidence_email.as_deref(),
                email_verified: evidence_verified,
                hosted_domain: evidence_hd.as_deref(),
            };
            let admission = state.organization_admission();
            record_sign_in(pool, admission, &body.account.account_id, evidence).await;
            if is_new_authorization {
                state
                    .events()
                    .publish_device_event(
                        &body.account.account_id,
                        "added",
                        &body.session.device_id,
                    )
                    .await;
            }
            if let Some(return_to) = web_return_to {
                return web_oauth_success(
                    pool,
                    &body.session.token,
                    &return_to,
                    replaces_session_token_id.as_deref(),
                )
                .await;
            }
            let mut url = redirect_after;
            let separator = if url.contains('#') { '&' } else { '#' };
            url.push(separator);
            url.push_str("kordi_cloud_oauth=");
            url.push_str(&encode_oauth_fragment(&body));
            Redirect::to(&url).into_response()
        }
        Err(OAuthLoginError::ExistingEmailAccount {
            account_id,
            password_sign_in,
        }) => {
            let _ = write_audit(
                pool,
                Some(&account_id),
                None,
                "auth.oauth.link_refused",
                serde_json::json!({"provider": provider.id()}),
            )
            .await;
            redirect_with_oauth_error_code(
                &redirect_after,
                OAUTH_EMAIL_REQUIRES_SIGN_IN,
                existing_email_account_message(password_sign_in),
            )
        }
        Err(OAuthLoginError::Admission(error)) => {
            redirect_with_oauth_error_code(&redirect_after, error.code(), error.message())
        }
        Err(OAuthLoginError::Database(error)) => {
            eprintln!("[oauth] finish {} login: {error}", provider.id());
            redirect_with_oauth_error(&redirect_after, "Could not finish OAuth login.")
        }
    }
}

#[cfg(test)]
mod tests;
