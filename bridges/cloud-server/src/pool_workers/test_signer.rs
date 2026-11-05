//! A P-256 signer made at test time, so no key or token is ever committed.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};

use crate::resource_pools::WorkerIdentity;

pub(crate) const ISSUER: &str = "https://issuer.example.test";
pub(crate) const AUDIENCE: &str = "https://control.example.test";
pub(crate) const SUBJECT: &str = "worker-subject-1";

pub(crate) struct TestSigner {
    pair: EcdsaKeyPair,
    pub(crate) kid: String,
}

impl TestSigner {
    pub(crate) fn new(kid: &str) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        Self {
            pair,
            kid: kid.to_string(),
        }
    }

    /// The public key as a JWK set.
    pub(crate) fn jwks(&self) -> Value {
        let point = self.pair.public_key().as_ref();
        json!({"keys": [{
            "kty": "EC",
            "crv": "P-256",
            "use": "sig",
            "kid": self.kid,
            "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
            "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
        }]})
    }

    /// An identity that accepts this signer's tokens for [`SUBJECT`].
    pub(crate) fn identity(&self) -> WorkerIdentity {
        WorkerIdentity::from_json(
            json!({"issuer": ISSUER, "audience": AUDIENCE, "subject": SUBJECT, "jwks": self.jwks()}),
            "test",
        )
        .unwrap()
    }

    pub(crate) fn sign(&self, header: &Value, claims: &Value) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature = self
            .pair
            .sign(&SystemRandom::new(), message.as_bytes())
            .unwrap();
        format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    /// A valid token issued at `now` for one hour, with `extra` claims
    /// replacing the defaults.
    pub(crate) fn token_at(&self, now: i64, extra: Value) -> String {
        let mut claims = json!({
            "iss": ISSUER, "aud": AUDIENCE, "sub": SUBJECT, "iat": now, "exp": now + 3600,
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            claims[key] = value.clone();
        }
        self.sign(
            &json!({"alg": "ES256", "typ": "JWT", "kid": self.kid}),
            &claims,
        )
    }

    pub(crate) fn token(&self) -> String {
        self.token_at(chrono::Utc::now().timestamp(), json!({}))
    }
}
