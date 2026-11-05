//! Whether one piece of verified sign-in evidence admits an account to a
//! configured organization. Pure rules, so every case is unit tested; the
//! store applies the decision under a row lock.

use super::config::{ConfiguredOrganization, DomainClaim, DomainMatch, SignInMethod};

/// What the server itself verified about a sign-in. Only provider or
/// inbox-code evidence the server checked reaches this point.
#[derive(Clone, Copy, Debug)]
pub struct SignInEvidence<'a> {
    pub method: SignInMethod,
    /// Normalized (lowercase) email address.
    pub email: Option<&'a str>,
    pub email_verified: bool,
    /// Google's `hd` claim from a validated ID token.
    pub hosted_domain: Option<&'a str>,
}

/// The account's existing admission to the organization, if any.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriorAdmission {
    None,
    /// Admitted before; the membership may be current or lapsed.
    Recorded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Join, or renew the last verification of an existing membership.
    Verify,
    /// The evidence does not admit the account.
    Ignore,
}

impl DomainClaim {
    pub fn covers(&self, domain: &str) -> bool {
        self.domains.iter().any(|claimed| match self.domain_match {
            DomainMatch::Exact => domain == claimed,
            DomainMatch::Subdomains => {
                domain == claimed
                    || domain
                        .strip_suffix(claimed.as_str())
                        .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
            }
        })
    }

    /// Whether `email` is a well-formed address in a claimed domain.
    pub fn covers_email(&self, email: &str) -> bool {
        match email.rsplit_once('@') {
            Some((local, domain)) if !local.is_empty() => self.covers(domain),
            _ => false,
        }
    }
}

/// Decides whether `evidence` joins or renews `account` in `org`.
pub fn decide(
    org: &ConfiguredOrganization,
    evidence: &SignInEvidence<'_>,
    prior: PriorAdmission,
) -> Decision {
    if !org.state.admits() || !evidence.email_verified || !org.auto_joins(evidence.method) {
        return Decision::Ignore;
    }
    let Some(email) = evidence.email else {
        return Decision::Ignore;
    };
    if !org.claim.covers_email(email) {
        return Decision::Ignore;
    }
    if evidence.method == SignInMethod::Google {
        if org.claim.require_google_hosted_domain
            && !evidence
                .hosted_domain
                .is_some_and(|hd| org.claim.covers(hd))
        {
            return Decision::Ignore;
        }
        // Without `googleSignInReverifies`, Google admits only a first join;
        // renewing or returning after a lapse needs another method.
        if prior == PriorAdmission::Recorded && !org.google_sign_in_reverifies {
            return Decision::Ignore;
        }
    }
    Decision::Verify
}

#[cfg(test)]
#[path = "claim_tests.rs"]
mod tests;
