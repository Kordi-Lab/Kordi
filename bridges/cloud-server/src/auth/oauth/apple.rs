//! Sign in with Apple, through the browser only. The Mac and iOS apps reach
//! it from the web login page through the app sign-in hand-off.
//!
//! `GET .../oauth/apple/start` (or the web start) sends the browser to Apple
//! with `response_mode=form_post`, a state and a nonce derived from the
//! state's secret verifier. Apple posts the code back to
//! `POST .../oauth/apple/callback`, which stores it with the state and
//! redirects to the usual `GET` callback (see the route module). There the
//! code is exchanged with an ES256 client secret, the identity token is
//! verified against Apple's keys, and the refresh token is kept (encrypted)
//! so it can be revoked when the account is deleted or Apple is unlinked
//! ([`revoke_apple_tokens_for_account`]). Tokens a deleted account could not
//! have revoked are retried from a queue ([`revocations`]).

use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::OAuthProfile;
use crate::pool_workers::token::{KeySet, TokenError};

pub(crate) mod api;
pub(crate) mod client_secret;
pub(crate) mod config;
pub(crate) mod id_token;
pub(crate) mod revocations;
#[cfg(test)]
pub(crate) mod test_support;
pub(crate) mod tokens;

pub(crate) use api::{AppleApi, AppleApiError, AppleHttp};
pub(crate) use config::{apple_is_configured, AppleConfig};
pub(crate) use id_token::IdTokenError;
pub use revocations::spawn as spawn_revocation_worker;
pub use tokens::revoke_apple_tokens_for_account;
pub(crate) use tokens::store_refresh_token;

pub(crate) const APPLE_ISSUER: &str = "https://appleid.apple.com";
const AUTHORIZE_URL: &str = "https://appleid.apple.com/auth/authorize";
/// The relay domain of "Hide My Email" addresses.
const PRIVATE_RELAY_DOMAIN: &str = "privaterelay.appleid.com";
const MAX_NAME_PART_CHARS: usize = 80;

/// Whether `email` is an Apple private relay address. Such an address is
/// unique to Kordi's team and never joins an existing account by email.
pub(crate) fn is_private_relay_email(email: &str) -> bool {
    email
        .trim()
        .rsplit_once('@')
        .is_some_and(|(_, domain)| domain.eq_ignore_ascii_case(PRIVATE_RELAY_DOMAIN))
}

/// The nonce of a browser sign-in, bound to its stored state through the
/// state's secret verifier, which never leaves the server.
pub(crate) fn web_nonce(code_verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"kordi-apple-web-nonce\0");
    hasher.update(code_verifier.as_bytes());
    hex::encode(hasher.finalize())
}

/// The Apple authorization page for a browser sign-in. Built by hand so the
/// scope keeps `%20` between its values; Apple refuses `+`.
pub(crate) fn authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
) -> String {
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    format!(
        "{AUTHORIZE_URL}?client_id={}&redirect_uri={}&response_type=code&scope=name%20email\
         &response_mode=form_post&state={}&nonce={}",
        encode(client_id),
        encode(redirect_uri),
        encode(state),
        encode(nonce),
    )
}

/// The name Apple shares once, on the first authorization.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AppleName {
    pub(crate) given: Option<String>,
    pub(crate) family: Option<String>,
}

impl AppleName {
    pub(crate) fn new(given: Option<&str>, family: Option<&str>) -> Self {
        let clean = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(MAX_NAME_PART_CHARS).collect::<String>())
        };
        Self {
            given: clean(given),
            family: clean(family),
        }
    }

    pub(crate) fn display_name(&self) -> Option<String> {
        match (&self.given, &self.family) {
            (Some(given), Some(family)) => Some(format!("{given} {family}")),
            (Some(one), None) | (None, Some(one)) => Some(one.clone()),
            (None, None) => None,
        }
    }

    /// The `user` field of Apple's form post:
    /// `{"name": {"firstName", "lastName"}, "email"}`. Only the name is
    /// used; the email comes from the verified identity token.
    pub(crate) fn from_form_user(user: Option<&str>) -> Self {
        let Some(value) = user.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        else {
            return Self::default();
        };
        Self::new(
            value["name"]["firstName"].as_str(),
            value["name"]["lastName"].as_str(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleSignInError {
    /// The server has no usable Apple configuration.
    NotConfigured,
    /// Apple's keys or token endpoint could not be reached.
    Unavailable,
    /// The identity token failed verification.
    InvalidToken(IdTokenError),
    /// Apple refused the authorization code.
    InvalidCode,
}

/// A verified Apple sign-in, ready to complete like any provider sign-in
/// and to store its refresh token.
#[derive(Debug, Clone)]
pub(in crate::auth) struct AppleSignIn {
    pub(in crate::auth) profile: OAuthProfile,
    /// The client the tokens belong to: the Services ID.
    pub(in crate::auth) client_id: String,
    pub(in crate::auth) refresh_token: Option<String>,
}

/// Verifies with the cached keys, refetching once when the key is unknown
/// (Apple rotated it).
async fn verify(
    api: &dyn AppleApi,
    token: &str,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<id_token::AppleIdClaims, AppleSignInError> {
    let mut outcome = Err(IdTokenError::Token(TokenError::UnknownKey));
    for refresh in [false, true] {
        let keys: Arc<KeySet> = api
            .keys(refresh)
            .await
            .map_err(|_| AppleSignInError::Unavailable)?;
        outcome = id_token::verify_identity_token(token, &keys, client_id, nonce, now);
        if outcome != Err(IdTokenError::Token(TokenError::UnknownKey)) {
            break;
        }
    }
    outcome.map_err(AppleSignInError::InvalidToken)
}

async fn exchange(
    api: &dyn AppleApi,
    config: &AppleConfig,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    now: i64,
) -> Result<api::AppleTokenResponse, AppleSignInError> {
    let secret = client_secret::client_secret(config, client_id, now)
        .map_err(|_| AppleSignInError::NotConfigured)?;
    let form = [
        ("client_id", client_id),
        ("client_secret", secret.as_str()),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    api.exchange_code(&form).await.map_err(|error| match error {
        AppleApiError::Rejected => AppleSignInError::InvalidCode,
        AppleApiError::Unavailable => AppleSignInError::Unavailable,
    })
}

fn profile(claims: &id_token::AppleIdClaims, name: &AppleName) -> OAuthProfile {
    OAuthProfile {
        provider_subject: claims.subject.clone(),
        username: None,
        display_name: name.display_name(),
        email: claims.email.clone(),
        email_verified: claims.email_verified,
        avatar_url: None,
        hosted_domain: None,
    }
}

/// Exchanges the posted `code` for the Services ID and verifies the identity
/// token Apple returns with it.
pub(in crate::auth) async fn web_sign_in(
    api: &dyn AppleApi,
    config: &AppleConfig,
    code: &str,
    redirect_uri: &str,
    nonce: &str,
    name: &AppleName,
    now: i64,
) -> Result<AppleSignIn, AppleSignInError> {
    let client_id = config.client_id.clone();
    let tokens = exchange(api, config, &client_id, code, redirect_uri, now).await?;
    let id_token = tokens
        .id_token
        .as_deref()
        .ok_or(AppleSignInError::Unavailable)?;
    let claims = verify(api, id_token, &client_id, nonce, now).await?;
    Ok(AppleSignIn {
        profile: profile(&claims, name),
        client_id,
        refresh_token: tokens.refresh_token,
    })
}

#[cfg(test)]
mod tests;
