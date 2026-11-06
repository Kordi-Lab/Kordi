//! The client secret Apple's token and revoke endpoints require: an ES256
//! JWT signed with the Sign in with Apple key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::json;

use super::config::AppleConfig;
use super::APPLE_ISSUER;

/// Lifetime of each client secret. Apple allows up to six months; a new
/// secret is made for every request, so a few minutes is plenty.
pub(crate) const CLIENT_SECRET_LIFETIME_SECONDS: i64 = 5 * 60;

/// A client secret for `client_id` (the Services ID or an app bundle ID)
/// issued at Unix time `now`.
pub(crate) fn client_secret(
    config: &AppleConfig,
    client_id: &str,
    now: i64,
) -> Result<String, ring::error::Unspecified> {
    let rng = SystemRandom::new();
    let pair = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &config.private_key_pkcs8,
        &rng,
    )
    .map_err(|_| ring::error::Unspecified)?;
    let header = json!({"alg": "ES256", "kid": config.key_id});
    let claims = json!({
        "iss": config.team_id,
        "iat": now,
        "exp": now + CLIENT_SECRET_LIFETIME_SECONDS,
        "aud": APPLE_ISSUER,
        "sub": client_id,
    });
    let message = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = pair.sign(&rng, message.as_bytes())?;
    Ok(format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    ))
}
