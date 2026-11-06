//! Sign in with Apple routes (see [`crate::auth::oauth::apple`]).
//!
//! - `POST /v1/cloud/auth/oauth/apple/callback`: Apple's form post. The
//!   browser arrives here from Apple's page in a cross-site `POST`, which
//!   carries no `SameSite=Lax` cookie, so the web sign-in's browser binding
//!   could not be checked here. The code is stored with its state and the
//!   browser is sent with `303` to the `GET` callback, a top-level
//!   navigation that does carry the cookie and finishes like Google and
//!   GitHub (see [`apple_profile`]).

use super::*;
use crate::auth::oauth::apple::{self as apple_auth, AppleApi, AppleConfig, AppleHttp, AppleName};
use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;

/// Longest `user` field kept from Apple's form post.
const MAX_FORM_USER_BYTES: usize = 2048;

/// The fields Apple posts back. `id_token` is ignored: the identity token
/// comes from the code exchange.
#[derive(Debug, Default, Deserialize)]
pub(in crate::auth::routes) struct AppleFormPost {
    code: Option<String>,
    state: Option<String>,
    user: Option<String>,
    error: Option<String>,
}

pub(in crate::auth::routes) async fn oauth_form_post_callback(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    axum::Form(form): axum::Form<AppleFormPost>,
) -> Response {
    if OAuthProvider::parse(&provider) != Some(OAuthProvider::Apple) {
        return err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(state_id) = form
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
    else {
        return err(
            "invalid_oauth_state",
            "Missing OAuth state.",
            StatusCode::BAD_REQUEST,
        );
    };
    let code = form
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 4096);
    let user = form
        .user
        .as_deref()
        .filter(|value| value.len() <= MAX_FORM_USER_BYTES);
    // Only the first post for a state is kept.
    let stored: Result<Option<(String,)>, _> = query_as(
        "UPDATE cloud_oauth_states SET form_post_code = $2, form_post_user = $3 \
         WHERE state_id = $1 AND provider = 'apple' AND form_post_code IS NULL \
         RETURNING state_id",
    )
    .bind(state_id)
    .bind(code)
    .bind(user)
    .fetch_optional(state.db_pool())
    .await;
    match stored {
        Ok(Some(_)) => {}
        Ok(None) => {
            return err(
                "invalid_oauth_state",
                "OAuth state expired or was already used.",
                StatusCode::BAD_REQUEST,
            )
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not load OAuth state.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
    let mut target = url::Url::parse("http://callback.invalid/v1/cloud/auth/oauth/apple/callback")
        .expect("valid callback path");
    target.query_pairs_mut().append_pair("state", state_id);
    if let Some(error) = form
        .error
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        target
            .query_pairs_mut()
            .append_pair("error", &apple_error_message(error));
    }
    let location = format!("{}?{}", target.path(), target.query().unwrap_or_default());
    super::super::app_sign_in_handlers::no_store(Redirect::to(&location).into_response())
}

/// The message shown for an error Apple posts back.
fn apple_error_message(error: &str) -> String {
    match error.trim() {
        "user_cancelled_authorize" => "Sign-in was canceled.".to_string(),
        other => format!(
            "Apple sign-in failed ({}).",
            other.chars().take(64).collect::<String>()
        ),
    }
}

/// Apple tokens from a browser sign-in, kept after the account is known.
pub(super) struct AppleTokens {
    subject: String,
    client_id: String,
    refresh_token: Option<String>,
}

/// The provider profile for the `GET` callback: Apple through
/// [`apple_auth::web_sign_in`], the others through their token and profile
/// endpoints. The error is the message for the redirect.
pub(super) async fn callback_profile(
    provider: OAuthProvider,
    code: &str,
    code_verifier: Option<&str>,
    form_user: Option<&str>,
) -> Result<(OAuthProfile, Option<AppleTokens>), String> {
    let config = oauth_config(provider)?;
    if provider == OAuthProvider::Apple {
        let apple_config = AppleConfig::from_env()
            .map_err(|_| "Apple sign-in is not available on this server.".to_string())?;
        let (profile, tokens) = apple_profile(
            &AppleHttp::new(),
            &apple_config,
            &config.redirect_uri,
            code,
            code_verifier,
            form_user,
            Utc::now().timestamp(),
        )
        .await?;
        return Ok((profile, Some(tokens)));
    }
    let http = reqwest::Client::new();
    let tokens = exchange_oauth_code(&http, &config, code, code_verifier)
        .await
        .map_err(|_| "Could not exchange OAuth code.".to_string())?;
    match fetch_oauth_profile(&http, &config, &tokens).await {
        Ok(Some(profile)) if !profile.provider_subject.trim().is_empty() => Ok((profile, None)),
        _ => Err("Could not load OAuth profile.".to_string()),
    }
}

/// Apple's half of the `GET` callback: exchange the posted code and verify
/// the identity token against the nonce bound to the state's verifier.
pub(super) async fn apple_profile(
    api: &dyn AppleApi,
    config: &AppleConfig,
    redirect_uri: &str,
    code: &str,
    code_verifier: Option<&str>,
    form_user: Option<&str>,
    now: i64,
) -> Result<(OAuthProfile, AppleTokens), String> {
    let Some(verifier) = code_verifier.filter(|value| !value.is_empty()) else {
        return Err("OAuth state is invalid.".to_string());
    };
    let signed_in = apple_auth::web_sign_in(
        api,
        config,
        code,
        redirect_uri,
        &apple_auth::web_nonce(verifier),
        &AppleName::from_form_user(form_user),
        now,
    )
    .await
    .map_err(|error| {
        eprintln!("[oauth] apple sign-in: {error:?}");
        "Could not finish Apple sign-in.".to_string()
    })?;
    let tokens = AppleTokens {
        subject: signed_in.profile.provider_subject.clone(),
        client_id: signed_in.client_id,
        refresh_token: signed_in.refresh_token,
    };
    Ok((signed_in.profile, tokens))
}

/// Stores the refresh token of a finished sign-in.
pub(super) async fn keep_refresh_token(state: &ServerState, account_id: &str, tokens: AppleTokens) {
    store_tokens(
        state.db_pool(),
        state.connectors().cipher.as_deref(),
        account_id,
        tokens,
    )
    .await;
}

async fn store_tokens(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    account_id: &str,
    tokens: AppleTokens,
) {
    let Some(refresh_token) = tokens.refresh_token.as_deref() else {
        return;
    };
    if let Err(error) = apple_auth::store_refresh_token(
        pool,
        cipher,
        account_id,
        &tokens.subject,
        &tokens.client_id,
        refresh_token,
    )
    .await
    {
        eprintln!("[oauth] could not store the Apple refresh token: {error}");
    }
}

#[cfg(test)]
mod tests;
