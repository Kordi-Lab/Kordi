//! Claims from the Google ID token returned with the access token. The token
//! comes straight from Google's token endpoint over TLS, which OpenID
//! Connect Core's ID token validation rules accept in place of a signature
//! check; the issuer, audience, expiry and subject are still checked.

use base64::Engine;
use serde_json::Value;

const ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct GoogleIdClaims {
    pub(crate) email: Option<String>,
    pub(crate) email_verified: bool,
    /// The Google Workspace domain (`hd`), lowercase.
    pub(crate) hosted_domain: Option<String>,
}

/// Validates `token` for `client_id` and `subject` (from the userinfo
/// response) at `now_seconds`.
pub(crate) fn google_id_claims(
    token: &str,
    client_id: &str,
    subject: &str,
    now_seconds: i64,
) -> Result<GoogleIdClaims, &'static str> {
    let mut parts = token.split('.');
    let (Some(_), Some(payload), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed ID token");
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| "malformed ID token")?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| "malformed ID token")?;
    if !claims["iss"]
        .as_str()
        .is_some_and(|iss| ISSUERS.contains(&iss))
    {
        return Err("ID token issuer mismatch");
    }
    let audience_ok = match &claims["aud"] {
        Value::String(aud) => aud == client_id,
        Value::Array(auds) => auds.iter().any(|aud| aud.as_str() == Some(client_id)),
        _ => false,
    };
    if !audience_ok {
        return Err("ID token audience mismatch");
    }
    if claims["exp"].as_i64().is_none_or(|exp| exp <= now_seconds) {
        return Err("ID token expired");
    }
    if claims["sub"].as_str() != Some(subject) {
        return Err("ID token subject mismatch");
    }
    let email_verified = match &claims["email_verified"] {
        Value::Bool(verified) => *verified,
        Value::String(verified) => verified == "true",
        _ => false,
    };
    Ok(GoogleIdClaims {
        email: claims["email"]
            .as_str()
            .map(|e| e.trim().to_ascii_lowercase()),
        email_verified,
        hosted_domain: claims["hd"]
            .as_str()
            .map(|hd| hd.trim().to_ascii_lowercase())
            .filter(|hd| !hd.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(claims: Value) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.signature",
            engine.encode(br#"{"alg":"RS256"}"#),
            engine.encode(claims.to_string())
        )
    }

    fn claims() -> Value {
        serde_json::json!({
            "iss": "https://accounts.google.com", "aud": "client-1", "sub": "sub-1",
            "exp": 2000, "email": "Alex@Example.test", "email_verified": true,
            "hd": "Example.test",
        })
    }

    #[test]
    fn reads_hosted_domain_and_verification() {
        let parsed = google_id_claims(&token(claims()), "client-1", "sub-1", 1000).unwrap();
        assert_eq!(
            parsed,
            GoogleIdClaims {
                email: Some("alex@example.test".into()),
                email_verified: true,
                hosted_domain: Some("example.test".into()),
            }
        );
    }

    #[test]
    fn a_personal_account_has_no_hosted_domain() {
        let mut value = claims();
        value.as_object_mut().unwrap().remove("hd");
        value["email_verified"] = "false".into();
        let parsed = google_id_claims(&token(value), "client-1", "sub-1", 1000).unwrap();
        assert_eq!(parsed.hosted_domain, None);
        assert!(!parsed.email_verified);
    }

    #[test]
    fn rejects_tokens_for_another_client_subject_issuer_or_time() {
        let cases = [
            ("aud", serde_json::json!("other-client")),
            ("sub", serde_json::json!("sub-2")),
            ("iss", serde_json::json!("https://issuer.example.test")),
            ("exp", serde_json::json!(999)),
        ];
        for (key, value) in cases {
            let mut forged = claims();
            forged[key] = value;
            assert!(
                google_id_claims(&token(forged), "client-1", "sub-1", 1000).is_err(),
                "{key}"
            );
        }
        assert!(google_id_claims("not-a-token", "client-1", "sub-1", 1000).is_err());
    }
}
