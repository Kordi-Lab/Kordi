//! Verification of pool worker identity tokens.
//!
//! A worker sends an OIDC identity token (a JWT signed by its cloud's
//! identity provider). Only RS256 and ES256 signatures are accepted, the key
//! must come from the issuer's key set, and the issuer, audience, subject or
//! verified email, expiry and lifetime must all match the pool's configured
//! identity. Errors say which check failed but never repeat the token.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};
use serde_json::Value;

use crate::resource_pools::WorkerIdentity;

/// Tokens longer than this are refused before parsing.
const MAX_TOKEN_BYTES: usize = 8 * 1024;
/// Allowed clock difference, in seconds.
const LEEWAY_SECONDS: i64 = 60;
/// Longest token lifetime accepted, in seconds. Identity tokens from the
/// metadata server live one hour; a projected token should be as short.
const MAX_LIFETIME_SECONDS: i64 = 2 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    UnsupportedAlgorithm,
    UnknownKey,
    BadSignature,
    WrongIssuer,
    WrongAudience,
    WrongSubject,
    WrongEmail,
    Expired,
    NotYetValid,
    LifetimeTooLong,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum KeyMaterial {
    Rsa {
        n: Vec<u8>,
        e: Vec<u8>,
    },
    /// An uncompressed P-256 point.
    P256(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifyKey {
    kid: Option<String>,
    material: KeyMaterial,
}

/// Public keys from a JWK set. Keys of other types are skipped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeySet {
    keys: Vec<VerifyKey>,
}

fn b64(value: &Value) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.as_str()?.trim_end_matches('='))
        .ok()
}

impl KeySet {
    /// Reads a JWK set (`{"keys": [...]}`). Keys meant only for encryption
    /// (`"use": "enc"`) and unsupported key types are skipped.
    pub fn from_jwks(value: &Value) -> Self {
        let keys = value["keys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|jwk| jwk["use"].as_str().is_none_or(|usage| usage == "sig"))
            .filter_map(|jwk| {
                let material = match jwk["kty"].as_str()? {
                    "RSA" => KeyMaterial::Rsa {
                        n: b64(&jwk["n"])?,
                        e: b64(&jwk["e"])?,
                    },
                    "EC" if jwk["crv"] == "P-256" => {
                        let (x, y) = (b64(&jwk["x"])?, b64(&jwk["y"])?);
                        if x.len() != 32 || y.len() != 32 {
                            return None;
                        }
                        let mut point = Vec::with_capacity(65);
                        point.push(0x04);
                        point.extend_from_slice(&x);
                        point.extend_from_slice(&y);
                        KeyMaterial::P256(point)
                    }
                    _ => return None,
                };
                Some(VerifyKey {
                    kid: jwk["kid"].as_str().map(str::to_string),
                    material,
                })
            })
            .collect();
        Self { keys }
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// What a verified token says about the worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWorker {
    pub subject: String,
}

/// Verifies `token` for `identity` against `keys` at Unix time `now`.
pub fn verify(
    token: &str,
    identity: &WorkerIdentity,
    keys: &KeySet,
    now: i64,
) -> Result<VerifiedWorker, TokenError> {
    let claims = verify_signature(token, keys)?;
    check_claims(&claims, identity, now)
}

/// Checks the size, shape and signature of `token` against `keys` and
/// returns its claims, unchecked. Only RS256 and ES256 are accepted, and the
/// key type must match the algorithm. Callers must check every claim they
/// rely on, at least issuer, audience and expiry.
pub(crate) fn verify_signature(token: &str, keys: &KeySet) -> Result<Value, TokenError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(TokenError::Malformed);
    }
    let mut parts = token.split('.');
    let (Some(header_part), Some(claims_part), Some(signature_part), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TokenError::Malformed);
    };
    let decode = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| TokenError::Malformed)
    };
    let header: Value =
        serde_json::from_slice(&decode(header_part)?).map_err(|_| TokenError::Malformed)?;
    let claims: Value =
        serde_json::from_slice(&decode(claims_part)?).map_err(|_| TokenError::Malformed)?;
    let signature_bytes = decode(signature_part)?;
    // Extensions this verifier does not understand must not be ignored.
    if header.get("crit").is_some() {
        return Err(TokenError::UnsupportedAlgorithm);
    }
    let rsa = match header["alg"].as_str() {
        Some("RS256") => true,
        Some("ES256") => false,
        _ => return Err(TokenError::UnsupportedAlgorithm),
    };
    let kid = header["kid"].as_str();
    let mut candidates = keys.keys.iter().filter(|key| {
        matches!(
            (&key.material, rsa),
            (KeyMaterial::Rsa { .. }, true) | (KeyMaterial::P256(_), false)
        ) && (kid.is_none() || key.kid.as_deref() == kid)
    });
    let key = match (kid, candidates.next(), candidates.next()) {
        (_, None, _) => return Err(TokenError::UnknownKey),
        // Without a kid the key must be unambiguous.
        (None, Some(_), Some(_)) => return Err(TokenError::UnknownKey),
        (_, Some(key), _) => key,
    };
    let message = &token.as_bytes()[..header_part.len() + 1 + claims_part.len()];
    let verified = match &key.material {
        KeyMaterial::Rsa { n, e } => RsaPublicKeyComponents { n, e }.verify(
            &signature::RSA_PKCS1_2048_8192_SHA256,
            message,
            &signature_bytes,
        ),
        KeyMaterial::P256(point) => {
            UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(message, &signature_bytes)
        }
    };
    verified.map_err(|_| TokenError::BadSignature)?;
    Ok(claims)
}

fn check_claims(
    claims: &Value,
    identity: &WorkerIdentity,
    now: i64,
) -> Result<VerifiedWorker, TokenError> {
    if claims["iss"].as_str() != Some(identity.issuer.as_str()) {
        return Err(TokenError::WrongIssuer);
    }
    let audience_matches = match &claims["aud"] {
        Value::String(audience) => audience == &identity.audience,
        Value::Array(audiences) => audiences
            .iter()
            .any(|audience| audience.as_str() == Some(identity.audience.as_str())),
        _ => false,
    };
    if !audience_matches {
        return Err(TokenError::WrongAudience);
    }
    let Some(expires) = claims["exp"].as_i64() else {
        return Err(TokenError::Malformed);
    };
    if now >= expires + LEEWAY_SECONDS {
        return Err(TokenError::Expired);
    }
    let time = |name: &str| claims.get(name).map(|value| value.as_i64());
    match time("nbf") {
        Some(Some(not_before)) if not_before > now + LEEWAY_SECONDS => {
            return Err(TokenError::NotYetValid)
        }
        Some(None) => return Err(TokenError::Malformed),
        _ => {}
    }
    let issued = match time("iat") {
        Some(Some(issued)) if issued > now + LEEWAY_SECONDS => return Err(TokenError::NotYetValid),
        Some(Some(issued)) => issued,
        Some(None) => return Err(TokenError::Malformed),
        None => now,
    };
    if expires - issued.min(now) > MAX_LIFETIME_SECONDS {
        return Err(TokenError::LifetimeTooLong);
    }
    let subject = claims["sub"].as_str().unwrap_or_default();
    if subject.is_empty() {
        return Err(TokenError::Malformed);
    }
    if identity
        .subject
        .as_deref()
        .is_some_and(|expected| expected != subject)
    {
        return Err(TokenError::WrongSubject);
    }
    if let Some(expected) = identity.email.as_deref() {
        let verified = matches!(&claims["email_verified"], Value::Bool(true))
            || claims["email_verified"].as_str() == Some("true");
        let email = claims["email"].as_str().unwrap_or_default();
        if !verified || !email.eq_ignore_ascii_case(expected) {
            return Err(TokenError::WrongEmail);
        }
    }
    Ok(VerifiedWorker {
        subject: subject.to_string(),
    })
}

#[cfg(test)]
#[path = "token_tests.rs"]
mod tests;
