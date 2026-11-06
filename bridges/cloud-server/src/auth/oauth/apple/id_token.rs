//! Verification of Apple identity tokens.
//!
//! The signature is checked with [`crate::pool_workers::token`] against
//! Apple's published keys (RS256 in practice: the key type must match the
//! token's algorithm, and Apple's set holds only RSA keys). The issuer must be
//! `https://appleid.apple.com`, the audience the Services ID, the token
//! unexpired and not issued in the future, and the nonce the one this server
//! put in the authorization URL.

use serde_json::Value;

use crate::pool_workers::token::{verify_signature, KeySet, TokenError};

use super::APPLE_ISSUER;

/// Allowed clock difference, in seconds.
const LEEWAY_SECONDS: i64 = 60;
/// Longest lifetime accepted. Apple's identity tokens live for minutes to a
/// day; anything longer is not one of them.
const MAX_LIFETIME_SECONDS: i64 = 2 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IdTokenError {
    Token(TokenError),
    WrongIssuer,
    WrongAudience,
    WrongNonce,
    MissingSubject,
    Expired,
    NotYetValid,
    LifetimeTooLong,
}

impl From<TokenError> for IdTokenError {
    fn from(error: TokenError) -> Self {
        Self::Token(error)
    }
}

/// The verified claims Kordi uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppleIdClaims {
    pub(crate) subject: String,
    pub(crate) email: Option<String>,
    pub(crate) email_verified: bool,
    pub(crate) is_private_email: bool,
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Apple sends some booleans as JSON strings.
fn flag(value: &Value) -> bool {
    matches!(value, Value::Bool(true)) || value.as_str() == Some("true")
}

/// Verifies `token` against `keys` for `client_id` and `nonce` at Unix time
/// `now`.
pub(crate) fn verify_identity_token(
    token: &str,
    keys: &KeySet,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<AppleIdClaims, IdTokenError> {
    let claims = verify_signature(token, keys)?;
    check_claims(&claims, client_id, nonce, now)
}

pub(crate) fn check_claims(
    claims: &Value,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<AppleIdClaims, IdTokenError> {
    if !claims.is_object() {
        return Err(IdTokenError::Token(TokenError::Malformed));
    }
    if claims["iss"].as_str() != Some(APPLE_ISSUER) {
        return Err(IdTokenError::WrongIssuer);
    }
    // Apple issues a single audience: the client the user authorized.
    if client_id.is_empty() || claims["aud"].as_str() != Some(client_id) {
        return Err(IdTokenError::WrongAudience);
    }
    let expires = claims["exp"]
        .as_i64()
        .ok_or(IdTokenError::Token(TokenError::Malformed))?;
    if now >= expires + LEEWAY_SECONDS {
        return Err(IdTokenError::Expired);
    }
    let issued = claims["iat"]
        .as_i64()
        .ok_or(IdTokenError::Token(TokenError::Malformed))?;
    if issued > now + LEEWAY_SECONDS {
        return Err(IdTokenError::NotYetValid);
    }
    if expires - issued > MAX_LIFETIME_SECONDS {
        return Err(IdTokenError::LifetimeTooLong);
    }
    let token_nonce = claims["nonce"].as_str().unwrap_or_default();
    if nonce.is_empty() || !constant_time_eq(token_nonce, nonce) {
        return Err(IdTokenError::WrongNonce);
    }
    let subject = claims["sub"]
        .as_str()
        .map(str::trim)
        .filter(|subject| !subject.is_empty())
        .ok_or(IdTokenError::MissingSubject)?;
    let email = claims["email"]
        .as_str()
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(str::to_string);
    Ok(AppleIdClaims {
        subject: subject.to_string(),
        email_verified: email.is_some() && flag(&claims["email_verified"]),
        is_private_email: flag(&claims["is_private_email"]),
        email,
    })
}
