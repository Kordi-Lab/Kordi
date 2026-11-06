//! Test doubles for Sign in with Apple: a configuration with a key made at
//! test time, a signer standing in for Apple's keys, and a fake Apple API.
//! No key or token is ever committed.

use std::sync::{Arc, Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};

use super::api::{AppleApi, AppleApiError, AppleTokenResponse};
use super::config::AppleConfig;
use super::APPLE_ISSUER;
use crate::pool_workers::test_signer::TestSigner;
use crate::pool_workers::token::KeySet;

pub(crate) const SERVICES_ID: &str = "test.kordi.web";
pub(crate) const TEAM_ID: &str = "TEAM000001";
pub(crate) const KEY_ID: &str = "KEY0000001";
pub(crate) const NOW: i64 = 1_800_000_000;

/// A PKCS#8 P-256 key in `.p8` PEM form, made once per test process.
pub(crate) fn private_key_pem() -> &'static str {
    static PEM: OnceLock<String> = OnceLock::new();
    PEM.get_or_init(|| {
        let der =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .unwrap();
        let body = STANDARD.encode(der.as_ref());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|chunk| std::str::from_utf8(chunk).unwrap())
            .collect();
        let label = ["PRIVATE", "KEY"].join(" ");
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            lines.join("\n")
        )
    })
}

pub(crate) fn config() -> AppleConfig {
    AppleConfig::from_values(SERVICES_ID, TEAM_ID, KEY_ID, private_key_pem()).unwrap()
}

/// Sets the Apple variables for route tests. Every caller sets the same
/// values, so parallel tests agree.
pub(crate) fn configure_env() {
    std::env::set_var(super::config::CLIENT_ID_ENV, SERVICES_ID);
    std::env::set_var(super::config::TEAM_ID_ENV, TEAM_ID);
    std::env::set_var(super::config::KEY_ID_ENV, KEY_ID);
    std::env::set_var(super::config::PRIVATE_KEY_ENV, private_key_pem());
}

/// Apple's side: signs identity tokens with a test key.
pub(crate) struct FakeAppleSigner(pub(crate) TestSigner);

impl FakeAppleSigner {
    pub(crate) fn new() -> Self {
        Self(TestSigner::new("apple-test-key"))
    }

    pub(crate) fn keys(&self) -> KeySet {
        KeySet::from_jwks(&self.0.jwks())
    }

    /// An identity token for `audience` and `subject` with `extra` claims
    /// replacing the defaults.
    pub(crate) fn token(&self, audience: &str, subject: &str, nonce: &str, extra: Value) -> String {
        let mut claims = json!({
            "iss": APPLE_ISSUER, "aud": audience, "sub": subject, "iat": NOW,
            "exp": NOW + 600, "nonce": nonce, "email": "person@example.test",
            "email_verified": "true", "is_private_email": "false",
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            claims[key] = value.clone();
        }
        self.0
            .sign(&json!({"alg": "ES256", "kid": self.0.kid}), &claims)
    }
}

/// The Apple API: answers with the given token response and records forms.
pub(crate) struct FakeApple {
    pub(crate) keys: KeySet,
    pub(crate) token_response: Mutex<Result<AppleTokenResponse, AppleApiError>>,
    pub(crate) exchanged: Mutex<Vec<Vec<(String, String)>>>,
    pub(crate) revoked: Mutex<Vec<Vec<(String, String)>>>,
    pub(crate) revoke_result: Mutex<Result<(), AppleApiError>>,
}

fn owned(form: &[(&str, &str)]) -> Vec<(String, String)> {
    form.iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

pub(crate) fn field<'a>(form: &'a [(String, String)], name: &str) -> Option<&'a str> {
    form.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

impl FakeApple {
    pub(crate) fn new(keys: KeySet, id_token: Option<String>, refresh_token: Option<&str>) -> Self {
        Self {
            keys,
            token_response: Mutex::new(Ok(AppleTokenResponse {
                refresh_token: refresh_token.map(str::to_string),
                id_token,
            })),
            exchanged: Mutex::new(Vec::new()),
            revoked: Mutex::new(Vec::new()),
            revoke_result: Mutex::new(Ok(())),
        }
    }
}

#[async_trait::async_trait]
impl AppleApi for FakeApple {
    async fn keys(&self, _refresh: bool) -> Result<Arc<KeySet>, AppleApiError> {
        Ok(Arc::new(self.keys.clone()))
    }

    async fn exchange_code(
        &self,
        form: &[(&str, &str)],
    ) -> Result<AppleTokenResponse, AppleApiError> {
        self.exchanged.lock().unwrap().push(owned(form));
        self.token_response.lock().unwrap().clone()
    }

    async fn revoke(&self, form: &[(&str, &str)]) -> Result<(), AppleApiError> {
        self.revoked.lock().unwrap().push(owned(form));
        *self.revoke_result.lock().unwrap()
    }
}
