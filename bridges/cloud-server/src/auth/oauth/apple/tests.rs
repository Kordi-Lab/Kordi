use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};

use super::config::AppleConfigError;
use super::id_token::{check_claims, verify_identity_token};
use super::test_support::*;
use super::*;

const NONCE: &str = "state-bound-nonce";
const REDIRECT: &str = "https://kordi.example.test/v1/cloud/auth/oauth/apple/callback";

fn decode_part(part: &str) -> Value {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
}

fn check(signer: &FakeAppleSigner, token: &str) -> Result<id_token::AppleIdClaims, IdTokenError> {
    verify_identity_token(token, &signer.keys(), SERVICES_ID, NONCE, NOW)
}

#[test]
fn a_token_for_the_services_id_with_the_state_nonce_is_accepted() {
    let signer = FakeAppleSigner::new();
    let claims = check(
        &signer,
        &signer.token(SERVICES_ID, "apple-user-1", NONCE, json!({})),
    )
    .unwrap();
    assert_eq!(claims.subject, "apple-user-1");
    assert_eq!(claims.email.as_deref(), Some("person@example.test"));
    assert!(claims.email_verified);
    assert!(!claims.is_private_email);
}

#[test]
fn claims_that_do_not_match_are_refused() {
    let signer = FakeAppleSigner::new();
    let cases = [
        (
            json!({"iss": "https://accounts.google.com"}),
            IdTokenError::WrongIssuer,
        ),
        (
            json!({"aud": "test.kordi.ios"}),
            IdTokenError::WrongAudience,
        ),
        (json!({"aud": [SERVICES_ID]}), IdTokenError::WrongAudience),
        (json!({"nonce": "another"}), IdTokenError::WrongNonce),
        (json!({"nonce": null}), IdTokenError::WrongNonce),
        (json!({"exp": NOW - 120}), IdTokenError::Expired),
        (
            json!({"iat": NOW + 600, "exp": NOW + 1200}),
            IdTokenError::NotYetValid,
        ),
        (
            json!({"iat": NOW - 10, "exp": NOW + 3 * 24 * 3600}),
            IdTokenError::LifetimeTooLong,
        ),
        (json!({"sub": ""}), IdTokenError::MissingSubject),
    ];
    for (extra, expected) in cases {
        let token = signer.token(SERVICES_ID, "apple-user-1", NONCE, extra.clone());
        assert_eq!(check(&signer, &token), Err(expected), "{extra}");
    }
    // An empty expected nonce never matches, even an empty claim.
    let token = signer.token(SERVICES_ID, "apple-user-1", "", json!({}));
    assert_eq!(
        verify_identity_token(&token, &signer.keys(), SERVICES_ID, "", NOW),
        Err(IdTokenError::WrongNonce)
    );
}

#[test]
fn signatures_from_other_keys_or_tampered_tokens_are_refused() {
    let signer = FakeAppleSigner::new();
    let other = FakeAppleSigner::new();
    // Same kid, different key.
    let forged = other.token(SERVICES_ID, "apple-user-1", NONCE, json!({}));
    assert_eq!(
        check(&signer, &forged),
        Err(IdTokenError::Token(TokenError::BadSignature))
    );
    // Claims swapped under a valid signature.
    let token = signer.token(SERVICES_ID, "apple-user-1", NONCE, json!({}));
    let mut parts: Vec<&str> = token.split('.').collect();
    let swapped = URL_SAFE_NO_PAD.encode(
        json!({"iss": APPLE_ISSUER, "aud": SERVICES_ID, "sub": "someone-else", "iat": NOW,
               "exp": NOW + 600, "nonce": NONCE})
        .to_string(),
    );
    parts[1] = &swapped;
    assert_eq!(
        check(&signer, &parts.join(".")),
        Err(IdTokenError::Token(TokenError::BadSignature))
    );
    // Unsigned.
    let header = URL_SAFE_NO_PAD.encode(json!({"alg": "none"}).to_string());
    let unsigned = format!("{header}.{}.", parts[1]);
    assert_eq!(
        check(&signer, &unsigned),
        Err(IdTokenError::Token(TokenError::UnsupportedAlgorithm))
    );
}

#[test]
fn private_relay_flags_are_read_from_strings_or_booleans() {
    let claims = json!({
        "iss": APPLE_ISSUER, "aud": SERVICES_ID, "sub": "apple-user-2", "iat": NOW,
        "exp": NOW + 600, "nonce": NONCE,
        "email": "abc123@privaterelay.appleid.com", "email_verified": true,
        "is_private_email": true,
    });
    let verified = check_claims(&claims, SERVICES_ID, NONCE, NOW).unwrap();
    assert!(verified.email_verified);
    assert!(verified.is_private_email);
    assert!(is_private_relay_email(verified.email.as_deref().unwrap()));
    assert!(is_private_relay_email("X@PrivateRelay.AppleID.com"));
    assert!(!is_private_relay_email("person@example.test"));
    assert!(!is_private_relay_email(
        "privaterelay.appleid.com@example.test"
    ));

    // Without an email nothing is verified.
    let mut no_email = claims.clone();
    no_email["email"] = Value::Null;
    let verified = check_claims(&no_email, SERVICES_ID, NONCE, NOW).unwrap();
    assert!(!verified.email_verified);
}

#[test]
fn configuration_is_complete_only_with_every_value_and_a_usable_key() {
    let key = private_key_pem();
    assert!(AppleConfig::from_values(SERVICES_ID, TEAM_ID, KEY_ID, key).is_ok());
    for (client, team, key_id, private_key) in [
        ("", TEAM_ID, KEY_ID, key),
        (SERVICES_ID, "", KEY_ID, key),
        (SERVICES_ID, TEAM_ID, " ", key),
        (SERVICES_ID, TEAM_ID, KEY_ID, ""),
    ] {
        assert_eq!(
            AppleConfig::from_values(client, team, key_id, private_key).unwrap_err(),
            AppleConfigError::Incomplete
        );
    }
    assert_eq!(
        AppleConfig::from_values(SERVICES_ID, TEAM_ID, KEY_ID, "not a key").unwrap_err(),
        AppleConfigError::InvalidPrivateKey
    );
    assert_eq!(
        AppleConfig::from_values("bad id", TEAM_ID, KEY_ID, key).unwrap_err(),
        AppleConfigError::InvalidIdentifier
    );
    // Escaped line breaks and base64-encoded PEM are accepted too.
    let escaped = key.trim().replace('\n', "\\n");
    assert!(AppleConfig::from_values(SERVICES_ID, TEAM_ID, KEY_ID, &escaped).is_ok());
    let encoded = STANDARD.encode(key);
    assert!(AppleConfig::from_values(SERVICES_ID, TEAM_ID, KEY_ID, &encoded).is_ok());
}

#[test]
fn the_client_secret_is_an_es256_jwt_for_the_services_id() {
    let config = config();
    let secret = client_secret::client_secret(&config, SERVICES_ID, NOW).unwrap();
    let parts: Vec<&str> = secret.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header = decode_part(parts[0]);
    assert_eq!(header, json!({"alg": "ES256", "kid": KEY_ID}));
    let claims = decode_part(parts[1]);
    assert_eq!(claims["iss"], TEAM_ID);
    assert_eq!(claims["sub"], SERVICES_ID);
    assert_eq!(claims["aud"], "https://appleid.apple.com");
    assert_eq!(claims["iat"], NOW);
    let lifetime = claims["exp"].as_i64().unwrap() - NOW;
    assert!(lifetime > 0 && lifetime <= 180 * 24 * 3600);

    // The signature verifies with the key's public half.
    let pair = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &config.private_key_pkcs8,
        &SystemRandom::new(),
    )
    .unwrap();
    let point = pair.public_key().as_ref();
    let keys = KeySet::from_jwks(&json!({"keys": [{
        "kty": "EC", "crv": "P-256", "kid": KEY_ID,
        "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
        "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
    }]}));
    assert!(crate::pool_workers::token::verify_signature(&secret, &keys).is_ok());
}

#[test]
fn the_authorization_url_asks_for_a_form_post_with_name_and_email() {
    let url = authorization_url(SERVICES_ID, REDIRECT, "oauth_state_1", "nonce-1");
    assert!(url.starts_with("https://appleid.apple.com/auth/authorize?"));
    assert!(url.contains("&scope=name%20email&"), "{url}");
    assert!(url.contains("&response_mode=form_post&"), "{url}");
    assert!(url.contains("&response_type=code&"), "{url}");
    let parsed = url::Url::parse(&url).unwrap();
    let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(pairs["client_id"], SERVICES_ID);
    assert_eq!(pairs["redirect_uri"], REDIRECT);
    assert_eq!(pairs["state"], "oauth_state_1");
    assert_eq!(pairs["nonce"], "nonce-1");
}

#[test]
fn the_web_nonce_is_bound_to_the_state_verifier() {
    assert_eq!(web_nonce("verifier-a"), web_nonce("verifier-a"));
    assert_ne!(web_nonce("verifier-a"), web_nonce("verifier-b"));
    assert_eq!(web_nonce("verifier-a").len(), 64);
}

#[test]
fn names_come_from_the_first_form_post() {
    let name = AppleName::from_form_user(Some(
        r#"{"name":{"firstName":" Ada ","lastName":"Lovelace"},"email":"x@example.test"}"#,
    ));
    assert_eq!(name.display_name().as_deref(), Some("Ada Lovelace"));
    assert_eq!(AppleName::from_form_user(None), AppleName::default());
    assert_eq!(
        AppleName::from_form_user(Some("not json")).display_name(),
        None
    );
    assert_eq!(
        AppleName::new(None, Some("Lovelace"))
            .display_name()
            .as_deref(),
        Some("Lovelace")
    );
    assert_eq!(AppleName::new(Some(" "), None).display_name(), None);
}

#[tokio::test]
async fn a_web_sign_in_exchanges_the_code_and_checks_the_state_nonce() {
    let signer = FakeAppleSigner::new();
    let token = signer.token(SERVICES_ID, "apple-user-3", NONCE, json!({}));
    let apple = FakeApple::new(signer.keys(), Some(token), Some("refresh-web"));
    let name = AppleName::new(Some("Grace"), None);

    let signed_in = web_sign_in(&apple, &config(), "web-code", REDIRECT, NONCE, &name, NOW)
        .await
        .unwrap();
    assert_eq!(signed_in.client_id, SERVICES_ID);
    assert_eq!(signed_in.profile.provider_subject, "apple-user-3");
    assert_eq!(signed_in.profile.display_name.as_deref(), Some("Grace"));
    assert_eq!(
        signed_in.profile.email.as_deref(),
        Some("person@example.test")
    );
    assert!(signed_in.profile.email_verified);
    assert_eq!(signed_in.refresh_token.as_deref(), Some("refresh-web"));
    let form = apple.exchanged.lock().unwrap()[0].clone();
    assert_eq!(field(&form, "client_id"), Some(SERVICES_ID));
    assert_eq!(field(&form, "code"), Some("web-code"));
    assert_eq!(field(&form, "grant_type"), Some("authorization_code"));
    assert_eq!(field(&form, "redirect_uri"), Some(REDIRECT));
    let secret = field(&form, "client_secret").unwrap();
    assert_eq!(
        decode_part(secret.split('.').nth(1).unwrap())["sub"],
        SERVICES_ID
    );
}

#[tokio::test]
async fn web_sign_in_failures_are_reported() {
    let signer = FakeAppleSigner::new();
    let name = AppleName::default();
    let token = signer.token(SERVICES_ID, "apple-user-3", NONCE, json!({}));
    let apple = FakeApple::new(signer.keys(), Some(token), Some("refresh-web"));

    // Another state's nonce.
    let other_nonce = web_nonce("another-verifier");
    assert_eq!(
        web_sign_in(&apple, &config(), "c", REDIRECT, &other_nonce, &name, NOW)
            .await
            .unwrap_err(),
        AppleSignInError::InvalidToken(IdTokenError::WrongNonce)
    );
    // Apple refuses the code.
    *apple.token_response.lock().unwrap() = Err(AppleApiError::Rejected);
    assert_eq!(
        web_sign_in(&apple, &config(), "c", REDIRECT, NONCE, &name, NOW)
            .await
            .unwrap_err(),
        AppleSignInError::InvalidCode
    );
    // Apple is down.
    *apple.token_response.lock().unwrap() = Err(AppleApiError::Unavailable);
    assert_eq!(
        web_sign_in(&apple, &config(), "c", REDIRECT, NONCE, &name, NOW)
            .await
            .unwrap_err(),
        AppleSignInError::Unavailable
    );
    // No identity token in the response.
    let apple = FakeApple::new(signer.keys(), None, Some("refresh-web"));
    assert_eq!(
        web_sign_in(&apple, &config(), "c", REDIRECT, NONCE, &name, NOW)
            .await
            .unwrap_err(),
        AppleSignInError::Unavailable
    );
}
