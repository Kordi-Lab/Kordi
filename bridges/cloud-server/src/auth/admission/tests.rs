use super::*;

fn research() -> AdmissionPolicy {
    AdmissionPolicy {
        mode: AdmissionMode::VerifiedDomain,
        domains: vec!["stanford.edu".into()],
        approved: HashSet::from(["approved@example.test".into()]),
    }
}
#[test]
fn only_verified_exact_domains_or_approved_emails_enter_research() {
    let policy = research();
    assert_eq!(policy.check(Some("person@stanford.edu"), true), Ok(()));
    assert_eq!(policy.check(Some("Person@STANFORD.EDU"), true), Ok(()));
    assert_eq!(
        policy.check(Some("person@stanford.edu"), false),
        Err(AdmissionError::VerificationRequired)
    );
    for email in [
        "person@sub.stanford.edu",
        "person@stanford.edu.evil.test",
        "stanford.edu@example.test",
    ] {
        assert_eq!(
            policy.check(Some(email), true),
            Err(AdmissionError::Waitlisted)
        );
    }
    assert_eq!(policy.check(Some("approved@example.test"), true), Ok(()));
    assert_eq!(
        policy.check(Some("approved@example.test"), false),
        Err(AdmissionError::VerificationRequired)
    );
    assert_eq!(
        policy.check(None, true),
        Err(AdmissionError::VerificationRequired)
    );
}
#[test]
fn staging_requires_explicit_testers_even_with_a_stanford_email() {
    let mut policy = research();
    policy.mode = AdmissionMode::ApprovedTesters;
    policy.domains.clear();
    assert_eq!(
        policy.check(Some("person@stanford.edu"), true),
        Err(AdmissionError::TesterApprovalRequired)
    );
    assert_eq!(policy.check(Some("approved@example.test"), true), Ok(()));
    assert_eq!(
        policy.check(Some("approved@example.test"), false),
        Err(AdmissionError::VerificationRequired)
    );
}
#[test]
fn existing_app_and_beta_behavior_is_unchanged() {
    assert_eq!(AdmissionPolicy::default().check(None, false), Ok(()));
    assert!(AdmissionPolicy::default().public_policy().is_none());
    assert!(AdmissionPolicy::load(|_| None).is_ok());
}
#[test]
fn invalid_or_mismatched_configuration_fails_closed_and_public_policy_has_no_bindings() {
    let config = serde_json::json!({"loginPage":{"title":"Staging","subtitle":"Approved testers","signupTitle":"Join staging","signupSubtitle":"Approved testers"},"admission":"approved-testers","verifiedDomains":[],"approvedEmailsBinding":"TEST_APPROVED","oauthBindings":{"googleClientId":"TEST_GOOGLE_ID","googleClientSecret":"TEST_GOOGLE_SECRET","githubClientId":"TEST_GITHUB_ID","githubClientSecret":"TEST_GITHUB_SECRET"},"edition":"app","environment":"staging","backendOrigin":"https://staging.example.test"});
    let load = |config: &serde_json::Value, approvals: Option<&str>, origin: &str| {
        AdmissionPolicy::load(|key| match key {
            "KORDI_AUTH_POLICY_JSON" => Some(config.to_string()),
            "KORDI_CLOUD_PUBLIC_BASE_URL" => Some(origin.to_string()),
            "TEST_APPROVED" => approvals.map(str::to_string),
            _ => None,
        })
    };
    let policy = load(&config, Some("[]"), "https://staging.example.test").unwrap();
    let public = policy.public_policy().unwrap().to_string();
    assert!(!public.contains("TEST_"));
    assert!(load(&config, None, "https://staging.example.test").is_err());
    assert!(load(&config, Some("[]"), "https://other.example.test").is_err());
    assert!(load(&config, Some("not-json"), "https://staging.example.test").is_err());
    let mut wrong = config.clone();
    wrong["admission"] = "existing".into();
    assert!(load(&wrong, Some("[]"), "https://staging.example.test").is_err());
}
