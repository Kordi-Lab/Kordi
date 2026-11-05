use serde_json::json;

use super::*;
use crate::pool_workers::test_signer::{TestSigner, AUDIENCE, ISSUER, SUBJECT};

const NOW: i64 = 1_800_000_000;

fn check(signer: &TestSigner, token: &str) -> Result<VerifiedWorker, TokenError> {
    let keys = KeySet::from_jwks(&signer.jwks());
    verify(token, &signer.identity(), &keys, NOW)
}

#[test]
fn a_token_from_the_configured_identity_is_accepted() {
    let signer = TestSigner::new("key-1");
    let verified = check(&signer, &signer.token_at(NOW, json!({}))).unwrap();
    assert_eq!(verified.subject, SUBJECT);
    // An audience list that contains ours is accepted too.
    let listed = signer.token_at(NOW, json!({"aud": ["other", AUDIENCE]}));
    assert!(check(&signer, &listed).is_ok());
}

#[test]
fn claims_that_do_not_match_are_refused() {
    let signer = TestSigner::new("key-1");
    let cases = [
        (
            json!({"iss": "https://other.example.test"}),
            TokenError::WrongIssuer,
        ),
        (
            json!({"aud": "https://other.example.test"}),
            TokenError::WrongAudience,
        ),
        (json!({"aud": ["a", "b"]}), TokenError::WrongAudience),
        (json!({"sub": "another-worker"}), TokenError::WrongSubject),
        (json!({"exp": NOW - 120}), TokenError::Expired),
        (json!({"nbf": NOW + 600}), TokenError::NotYetValid),
        (
            json!({"iat": NOW + 600, "exp": NOW + 1200}),
            TokenError::NotYetValid,
        ),
        (
            json!({"exp": NOW + 3 * 24 * 3600}),
            TokenError::LifetimeTooLong,
        ),
        (json!({"exp": "soon"}), TokenError::Malformed),
        (json!({"sub": ""}), TokenError::Malformed),
    ];
    for (claims, expected) in cases {
        let token = signer.token_at(NOW, claims.clone());
        assert_eq!(check(&signer, &token), Err(expected), "{claims}");
    }
    // Inside the allowed clock difference a just-expired token still passes.
    assert!(check(&signer, &signer.token_at(NOW, json!({"exp": NOW - 30}))).is_ok());
}

#[test]
fn signatures_keys_and_algorithms_are_checked() {
    let signer = TestSigner::new("key-1");
    let stranger = TestSigner::new("key-1");
    // Same kid, another key: the signature does not verify.
    assert_eq!(
        check(&signer, &stranger.token_at(NOW, json!({}))),
        Err(TokenError::BadSignature)
    );
    // A changed payload breaks the signature.
    let token = signer.token_at(NOW, json!({}));
    let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
    parts[1] = URL_SAFE_NO_PAD.encode(
        json!({"iss": ISSUER, "aud": AUDIENCE, "sub": "forged", "exp": NOW + 60}).to_string(),
    );
    assert_eq!(
        check(&signer, &parts.join(".")),
        Err(TokenError::BadSignature)
    );
    // Unknown kid, unsigned and symmetric algorithms, critical extensions.
    let claims = json!({"iss": ISSUER, "aud": AUDIENCE, "sub": SUBJECT, "exp": NOW + 60});
    let unknown = signer.sign(&json!({"alg": "ES256", "kid": "key-2"}), &claims);
    assert_eq!(check(&signer, &unknown), Err(TokenError::UnknownKey));
    for alg in ["none", "HS256", "RS512"] {
        let token = signer.sign(&json!({"alg": alg, "kid": "key-1"}), &claims);
        assert_eq!(
            check(&signer, &token),
            Err(TokenError::UnsupportedAlgorithm)
        );
    }
    let critical = signer.sign(
        &json!({"alg": "ES256", "kid": "key-1", "crit": ["exp"]}),
        &claims,
    );
    assert_eq!(
        check(&signer, &critical),
        Err(TokenError::UnsupportedAlgorithm)
    );
    // An RS256 token needs an RSA key; this set has none.
    let rsa = signer.sign(&json!({"alg": "RS256", "kid": "key-1"}), &claims);
    assert_eq!(check(&signer, &rsa), Err(TokenError::UnknownKey));
    // Without a kid, a single matching key is used.
    let no_kid = signer.sign(&json!({"alg": "ES256"}), &claims);
    assert!(check(&signer, &no_kid).is_ok());
}

#[test]
fn malformed_tokens_are_refused() {
    let signer = TestSigner::new("key-1");
    for token in ["", "a.b", "a.b.c.d", "!!.!!.!!", &"x".repeat(9000)] {
        assert_eq!(
            check(&signer, token),
            Err(TokenError::Malformed),
            "{token:.20}"
        );
    }
}

#[test]
fn an_email_identity_needs_a_verified_matching_email() {
    let signer = TestSigner::new("key-1");
    let identity = WorkerIdentity::from_json(
        json!({"issuer": ISSUER, "audience": AUDIENCE, "email": "worker@pool.example.test", "jwks": signer.jwks()}),
        "test",
    )
    .unwrap();
    let keys = KeySet::from_jwks(&signer.jwks());
    let token = |extra| signer.token_at(NOW, extra);
    let good = token(json!({"email": "worker@pool.example.test", "email_verified": true}));
    assert!(verify(&good, &identity, &keys, NOW).is_ok());
    for extra in [
        json!({"email": "worker@pool.example.test"}),
        json!({"email": "worker@pool.example.test", "email_verified": false}),
        json!({"email": "other@pool.example.test", "email_verified": true}),
    ] {
        assert_eq!(
            verify(&token(extra), &identity, &keys, NOW),
            Err(TokenError::WrongEmail)
        );
    }
}

#[test]
fn key_sets_skip_unusable_keys() {
    let signer = TestSigner::new("key-1");
    let mut jwks = signer.jwks();
    jwks["keys"].as_array_mut().unwrap().extend([
        json!({"kty": "oct", "k": "c2hvcnQ"}),
        json!({"kty": "EC", "crv": "P-384", "x": "AA", "y": "AA"}),
        json!({"kty": "RSA", "use": "enc", "n": "AQAB", "e": "AQAB"}),
    ]);
    assert_eq!(KeySet::from_jwks(&jwks), KeySet::from_jwks(&signer.jwks()));
    assert!(KeySet::from_jwks(&json!({})).is_empty());
}
