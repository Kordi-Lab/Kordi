use serde_json::json;

use super::super::config::SignInMethod::{EmailCode, Github, Google};
use super::super::test_support::organization;
use super::*;

fn evidence<'a>(
    method: SignInMethod,
    email: &'a str,
    verified: bool,
    hd: Option<&'a str>,
) -> SignInEvidence<'a> {
    SignInEvidence {
        method,
        email: Some(email),
        email_verified: verified,
        hosted_domain: hd,
    }
}

const ALEX: &str = "alex@example.test";

#[test]
fn google_needs_a_matching_hosted_domain_when_required() {
    let org = organization(|_| {});
    let with_hd = evidence(Google, ALEX, true, Some("example.test"));
    let without_hd = evidence(Google, ALEX, true, None);
    let other_hd = evidence(Google, ALEX, true, Some("other.test"));
    assert_eq!(
        decide(&org, &with_hd, PriorAdmission::None),
        Decision::Verify
    );
    assert_eq!(
        decide(&org, &without_hd, PriorAdmission::None),
        Decision::Ignore
    );
    assert_eq!(
        decide(&org, &other_hd, PriorAdmission::None),
        Decision::Ignore
    );

    let relaxed = organization(|o| o["admission"]["requireGoogleHostedDomain"] = json!(false));
    assert_eq!(
        decide(&relaxed, &without_hd, PriorAdmission::None),
        Decision::Verify
    );
}

#[test]
fn github_never_auto_joins_unless_listed() {
    let org = organization(|_| {});
    let github = evidence(Github, ALEX, true, None);
    assert_eq!(
        decide(&org, &github, PriorAdmission::None),
        Decision::Ignore
    );
    let listed = organization(|o| {
        o["admission"]["autoJoinMethods"] = json!(["google", "email_code", "github"])
    });
    assert_eq!(
        decide(&listed, &github, PriorAdmission::None),
        Decision::Verify
    );
}

#[test]
fn unverified_or_missing_emails_never_join() {
    let org = organization(|_| {});
    for method in [Google, EmailCode] {
        let unverified = evidence(method, ALEX, false, Some("example.test"));
        assert_eq!(
            decide(&org, &unverified, PriorAdmission::None),
            Decision::Ignore
        );
    }
    let no_email = SignInEvidence {
        method: EmailCode,
        email: None,
        email_verified: true,
        hosted_domain: None,
    };
    assert_eq!(
        decide(&org, &no_email, PriorAdmission::None),
        Decision::Ignore
    );
    let no_local_part = evidence(EmailCode, "@example.test", true, None);
    assert_eq!(
        decide(&org, &no_local_part, PriorAdmission::None),
        Decision::Ignore
    );
}

#[test]
fn domain_match_is_exact_unless_subdomains_are_allowed() {
    let exact = organization(|_| {});
    let sub = evidence(EmailCode, "alex@lab.example.test", true, None);
    let lookalike = evidence(EmailCode, "alex@badexample.test", true, None);
    let other = evidence(EmailCode, "alex@other.test", true, None);
    assert_eq!(
        decide(
            &exact,
            &evidence(EmailCode, ALEX, true, None),
            PriorAdmission::None
        ),
        Decision::Verify
    );
    assert_eq!(decide(&exact, &sub, PriorAdmission::None), Decision::Ignore);
    assert_eq!(
        decide(&exact, &other, PriorAdmission::None),
        Decision::Ignore
    );

    let subdomains = organization(|o| o["admission"]["domainMatch"] = json!("subdomains"));
    assert_eq!(
        decide(&subdomains, &sub, PriorAdmission::None),
        Decision::Verify
    );
    assert_eq!(
        decide(&subdomains, &lookalike, PriorAdmission::None),
        Decision::Ignore
    );
    assert!(subdomains.claim.covers("lab.example.test"));
    assert!(!subdomains.claim.covers(".example.test"));
}

#[test]
fn a_disabled_organization_admits_nobody() {
    let org = organization(|o| o["state"] = json!("disabled"));
    let google = evidence(Google, ALEX, true, Some("example.test"));
    assert_eq!(
        decide(&org, &google, PriorAdmission::None),
        Decision::Ignore
    );
    let interim = organization(|o| o["state"] = json!("interim"));
    assert_eq!(
        decide(&interim, &google, PriorAdmission::None),
        Decision::Verify
    );
}

#[test]
fn google_renews_only_when_configured_to() {
    let google = evidence(Google, ALEX, true, Some("example.test"));
    let renews = organization(|_| {});
    assert_eq!(
        decide(&renews, &google, PriorAdmission::Recorded),
        Decision::Verify
    );
    let no_renew = organization(|o| o["admission"]["googleSignInReverifies"] = json!(false));
    assert_eq!(
        decide(&no_renew, &google, PriorAdmission::None),
        Decision::Verify
    );
    assert_eq!(
        decide(&no_renew, &google, PriorAdmission::Recorded),
        Decision::Ignore
    );
    let code = evidence(EmailCode, ALEX, true, None);
    assert_eq!(
        decide(&no_renew, &code, PriorAdmission::Recorded),
        Decision::Verify
    );
}
