//! Instance admission is checked only against server-verified identity evidence.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Clone, Default)]
pub struct AdmissionPolicy {
    mode: AdmissionMode,
    domains: Vec<String>,
    approved: HashSet<String>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdmissionMode {
    #[default]
    Existing,
    VerifiedDomain,
    ApprovedTesters,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    admission: AdmissionMode,
    verified_domains: Vec<String>,
    approved_emails_binding: String,
    login_page: std::collections::HashMap<String, String>,
    oauth_bindings: std::collections::HashMap<String, String>,
    edition: String,
    environment: String,
    backend_origin: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionError {
    VerificationRequired,
    Waitlisted,
    TesterApprovalRequired,
    Unavailable,
}
impl AdmissionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::VerificationRequired => "verified_email_required",
            Self::Waitlisted => "access_pending",
            Self::TesterApprovalRequired => "tester_approval_required",
            Self::Unavailable => "admission_unavailable",
        }
    }
    pub fn message(&self) -> &'static str {
        match self {
            Self::VerificationRequired => "Verify your email before accessing this instance.",
            Self::Waitlisted => "Access is pending approval on this instance. You cannot sign in yet.",
            Self::TesterApprovalRequired => "This staging instance is limited to approved testers. Ask the instance owner for access.",
            Self::Unavailable => "Access verification is temporarily unavailable. Try again later.",
        }
    }
    pub fn response(&self) -> axum::response::Response {
        use axum::response::IntoResponse;
        let status = if *self == Self::Unavailable {
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        } else {
            axum::http::StatusCode::FORBIDDEN
        };
        (
            status,
            axum::Json(serde_json::json!({"errorCode": self.code(), "message": self.message()})),
        )
            .into_response()
    }
}

impl AdmissionPolicy {
    #[cfg(test)]
    pub(crate) fn synthetic(
        mode: AdmissionMode,
        domains: Vec<String>,
        approved: HashSet<String>,
    ) -> Self {
        Self {
            mode,
            domains,
            approved,
        }
    }
    pub fn from_env() -> Result<Self, &'static str> {
        Self::load(|key| std::env::var(key).ok())
    }
    fn load(get: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let invalid = "Invalid instance admission configuration";
        let Some(raw) = get("KORDI_AUTH_POLICY_JSON") else {
            return Ok(Self::default());
        };
        if raw.len() > 16384 {
            return Err(invalid);
        }
        let c: Configuration = serde_json::from_str(&raw).map_err(|_| invalid)?;
        if !["app", "research"].contains(&c.edition.as_str())
            || !["production", "staging"].contains(&c.environment.as_str())
            || get("KORDI_CLOUD_PUBLIC_BASE_URL").as_deref() != Some(&c.backend_origin)
            || c.environment == "staging" && c.admission != AdmissionMode::ApprovedTesters
            || c.edition == "research"
                && c.environment == "production"
                && c.admission != AdmissionMode::VerifiedDomain
            || (c.admission == AdmissionMode::VerifiedDomain) == c.verified_domains.is_empty()
            || c.verified_domains.len() > 20
            || c.verified_domains.iter().any(|d| !valid_domain(d))
            || c.login_page.len() != 4
            || ["title", "subtitle", "signupTitle", "signupSubtitle"]
                .iter()
                .any(|k| !c.login_page.contains_key(*k))
            || c.login_page
                .values()
                .any(|v| v.is_empty() || v.chars().count() > 240 || v.contains(['\r', '\n', '\0']))
            || c.oauth_bindings.len() != 4
            || [
                "googleClientId",
                "googleClientSecret",
                "githubClientId",
                "githubClientSecret",
            ]
            .iter()
            .any(|k| !c.oauth_bindings.contains_key(*k))
            || c.oauth_bindings.values().any(|v| !valid_binding(v))
            || !valid_binding(&c.approved_emails_binding)
        {
            return Err(invalid);
        }
        let mut approved = HashSet::new();
        if c.admission != AdmissionMode::Existing {
            let raw = get(&c.approved_emails_binding).ok_or(invalid)?;
            if raw.len() > 262144 {
                return Err(invalid);
            }
            let emails: Vec<String> = serde_json::from_str(&raw).map_err(|_| invalid)?;
            if emails.len() > 1000 {
                return Err(invalid);
            }
            for email in emails {
                approved.insert(super::password::validate_email(&email).map_err(|_| invalid)?);
            }
        }
        Ok(Self {
            mode: c.admission,
            domains: c.verified_domains,
            approved,
        })
    }
    pub fn requires_verified_email(&self) -> bool {
        self.mode != AdmissionMode::Existing
    }
    pub fn public_policy(&self) -> Option<serde_json::Value> {
        self.requires_verified_email()
            .then(|| serde_json::json!({"mode": self.mode, "verifiedDomains": self.domains}))
    }
    pub fn check(&self, email: Option<&str>, verified: bool) -> Result<(), AdmissionError> {
        if !self.requires_verified_email() {
            return Ok(());
        }
        let email = email.and_then(|v| super::password::validate_email(v).ok());
        let Some(email) = email.filter(|_| verified) else {
            return Err(AdmissionError::VerificationRequired);
        };
        if self.approved.contains(&email) {
            return Ok(());
        }
        if self.mode == AdmissionMode::VerifiedDomain {
            if email
                .rsplit_once('@')
                .is_some_and(|(_, domain)| self.domains.iter().any(|d| d == domain))
            {
                return Ok(());
            }
            Err(AdmissionError::Waitlisted)
        } else {
            Err(AdmissionError::TesterApprovalRequired)
        }
    }
    pub async fn admit_identity(
        &self,
        pool: &PgPool,
        email: Option<&str>,
        verified: bool,
    ) -> Result<(), AdmissionError> {
        let result = self.check(email, verified);
        if result == Err(AdmissionError::Waitlisted) {
            let email = super::password::validate_email(email.unwrap_or_default())
                .map_err(|_| AdmissionError::VerificationRequired)?;
            query("INSERT INTO cloud_access_waitlist (email, first_requested_at, last_requested_at) VALUES ($1, NOW(), NOW()) ON CONFLICT (email) DO UPDATE SET last_requested_at = EXCLUDED.last_requested_at")
                .bind(email).execute(pool).await.map_err(|_| AdmissionError::Unavailable)?;
        }
        result
    }
    pub async fn authorize_account(
        &self,
        pool: &PgPool,
        account_id: &str,
    ) -> Result<(), AdmissionError> {
        if !self.requires_verified_email() {
            return Ok(());
        }
        let row: Option<(Option<String>, bool)> = query_as("SELECT primary_email, primary_email_verified_at IS NOT NULL FROM cloud_accounts WHERE account_id = $1")
            .bind(account_id).fetch_optional(pool).await.map_err(|_| AdmissionError::Unavailable)?;
        let (email, verified) = row.ok_or(AdmissionError::VerificationRequired)?;
        // Existing tokens cannot create waitlist entries or grant themselves access.
        self.check(email.as_deref(), verified)
    }
}
fn valid_binding(v: &str) -> bool {
    (3..=80).contains(&v.len())
        && v.as_bytes()[0].is_ascii_uppercase()
        && v.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn valid_domain(v: &str) -> bool {
    v.contains('.')
        && v.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

#[cfg(test)]
mod tests;
