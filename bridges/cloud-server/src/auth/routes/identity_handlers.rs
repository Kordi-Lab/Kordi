use super::*;

mod completion;
mod email_linking;
#[cfg(test)]
use completion::complete_oauth_login;
use completion::complete_oauth_login_with_policy;
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
            Err(error) => return err(error.code(), error.message(), StatusCode::BAD_REQUEST),
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
          device_os_version, device_app_version, device_approximate_location) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
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
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not create OAuth state.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
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
    let state_row: Option<OAuthStateRow> = match query_as(
        "DELETE FROM cloud_oauth_states WHERE state_id = $1 \
         RETURNING provider, redirect_after, code_verifier, expires_at, device_name, \
                   device_public_key, device_key_algorithm, device_platform, \
                   device_os_version, device_app_version, device_approximate_location",
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
    )) = state_row
    else {
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

    match complete_oauth_login_with_policy(
        pool,
        provider,
        profile,
        &registration,
        state.admission(),
    )
    .await
    {
        Ok((body, is_new_authorization)) => {
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
            if let Some(return_to) = web_oauth_return_to(&redirect_after) {
                return web_oauth_success(&body.session.token, &return_to);
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
