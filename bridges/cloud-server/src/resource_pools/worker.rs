//! The workload identity a pool worker presents to the control plane.
//!
//! A pool worker authenticates with a short-lived OIDC token (a JWT) from its
//! own cloud: for example a Google service account identity token from the
//! metadata server, or a Kubernetes projected service account token. The pool
//! names the issuer, the audience and the subject (or email) it accepts. The
//! value names an identity, not a secret, so it may sit in the pool file or
//! in an environment variable.

use serde::Deserialize;

use super::ResourcePoolConfigError;

const MAX_FIELD_CHARS: usize = 512;
const MAX_INLINE_KEYS: usize = 16;

/// Accepted worker identity. Token checks live in `crate::pool_workers`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerIdentity {
    /// Exact `iss` claim.
    pub issuer: String,
    /// Required entry of the `aud` claim.
    pub audience: String,
    /// Exact `sub` claim, when set.
    pub subject: Option<String>,
    /// Exact `email` claim with `email_verified`, when set.
    pub email: Option<String>,
    /// Where the issuer's signing keys are published. Defaults to the
    /// `jwks_uri` of the issuer's OpenID configuration.
    pub jwks_uri: Option<String>,
    /// Signing keys given inline (a JWK set), for issuers without a published
    /// key set. When set, no keys are fetched.
    pub jwks: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct IdentityEntry {
    issuer: String,
    audience: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    jwks_uri: Option<String>,
    #[serde(default)]
    jwks: Option<serde_json::Value>,
}

impl WorkerIdentity {
    /// Reads an identity from its JSON form. `at` names the place in the
    /// configuration for error messages.
    pub fn from_json(value: serde_json::Value, at: &str) -> Result<Self, ResourcePoolConfigError> {
        let invalid = |detail: &str| ResourcePoolConfigError::new(format!("{at} {detail}"));
        let entry: IdentityEntry = serde_json::from_value(value)
            .map_err(|_| invalid("must be an object with issuer, audience and subject or email"))?;
        let field = |value: &str, name: &str| -> Result<String, ResourcePoolConfigError> {
            let value = value.trim();
            if value.is_empty()
                || value.chars().count() > MAX_FIELD_CHARS
                || value.chars().any(char::is_control)
            {
                return Err(invalid(&format!("{name} must be a non-empty single line")));
            }
            Ok(value.to_string())
        };
        let optional = |value: &Option<String>, name: &str| {
            value.as_deref().map(|value| field(value, name)).transpose()
        };
        let identity = Self {
            issuer: field(&entry.issuer, "issuer")?,
            audience: field(&entry.audience, "audience")?,
            subject: optional(&entry.subject, "subject")?,
            email: optional(&entry.email, "email")?,
            jwks_uri: optional(&entry.jwks_uri, "jwksUri")?,
            jwks: entry.jwks,
        };
        if identity.subject.is_none() && identity.email.is_none() {
            return Err(invalid("needs a subject or an email"));
        }
        if let Some(uri) = &identity.jwks_uri {
            if !is_https(uri) {
                return Err(invalid("jwksUri must be an https URL"));
            }
        }
        match &identity.jwks {
            Some(keys) => {
                let count = keys["keys"].as_array().map(Vec::len);
                if !matches!(count, Some(1..=MAX_INLINE_KEYS)) {
                    return Err(invalid(&format!(
                        "jwks must hold 1-{MAX_INLINE_KEYS} keys in \"keys\""
                    )));
                }
            }
            // Keys are discovered from the issuer, which must be https then.
            None if identity.jwks_uri.is_none() && !is_https(&identity.issuer) => {
                return Err(invalid(
                    "issuer must be an https URL unless jwksUri or jwks is set",
                ));
            }
            None => {}
        }
        Ok(identity)
    }

    /// Reads an identity from its JSON text, such as an environment value.
    pub fn from_text(text: &str, at: &str) -> Result<Self, ResourcePoolConfigError> {
        let value = serde_json::from_str(text.trim())
            .map_err(|_| ResourcePoolConfigError::new(format!("{at} must be JSON")))?;
        Self::from_json(value, at)
    }
}

fn is_https(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}
