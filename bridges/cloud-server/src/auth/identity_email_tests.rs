use super::*;

fn stored(email: Option<&str>, verified: bool, matching: Option<&str>) -> StoredIdentityEmail {
    StoredIdentityEmail {
        email: email.map(str::to_string),
        email_verified: verified,
        matching_email: matching.map(str::to_string),
    }
}

#[test]
fn a_new_identity_matches_only_a_verified_email() {
    let update = update_identity_email(None, Some(" Alex@Example.test "), true);
    assert_eq!(update.matching_email.as_deref(), Some("alex@example.test"));
    assert!(update.evidence_verified);
    assert_eq!(update.event, None);

    let update = update_identity_email(None, Some("alex@example.test"), false);
    assert_eq!(update.matching_email, None);
    assert!(!update.evidence_verified);

    let update = update_identity_email(None, None, true);
    assert_eq!(update.matching_email, None);
    assert!(!update.evidence_verified);
}

#[test]
fn the_same_verified_email_keeps_matching() {
    let row = stored(Some("alex@example.test"), true, Some("alex@example.test"));
    let update = update_identity_email(Some(&row), Some("ALEX@example.test"), true);
    assert_eq!(update.matching_email.as_deref(), Some("alex@example.test"));
    assert!(update.evidence_verified);
    assert_eq!(update.event, None);
}

#[test]
fn an_email_that_stops_being_verified_stops_matching_and_is_logged() {
    let row = stored(Some("alex@example.test"), true, Some("alex@example.test"));
    let update = update_identity_email(Some(&row), Some("alex@example.test"), false);
    assert_eq!(update.matching_email, None);
    assert!(!update.evidence_verified);
    assert_eq!(update.event, Some(EMAIL_UNVERIFIED_EVENT));

    // An identity that was never verified has nothing to log.
    let row = stored(Some("alex@example.test"), false, None);
    let update = update_identity_email(Some(&row), Some("alex@example.test"), false);
    assert_eq!(update.event, None);
}

#[test]
fn a_changed_email_needs_reverification() {
    let row = stored(Some("alex@example.test"), true, Some("alex@example.test"));
    let update = update_identity_email(Some(&row), Some("sam@example.test"), true);
    // The identity remembers the email it was verified by; the new one is
    // not evidence until the account proves it.
    assert_eq!(update.matching_email.as_deref(), Some("alex@example.test"));
    assert!(!update.evidence_verified);
    assert_eq!(update.event, Some(EMAIL_CHANGED_EVENT));

    // Still pending at the next sign-in with the new address.
    let pending = stored(Some("sam@example.test"), true, Some("alex@example.test"));
    let update = update_identity_email(Some(&pending), Some("sam@example.test"), true);
    assert!(!update.evidence_verified);
    assert_eq!(update.event, None);

    // Changing back to the verified address matches again.
    let update = update_identity_email(Some(&pending), Some("alex@example.test"), true);
    assert!(update.evidence_verified);
}

#[test]
fn an_email_that_appears_later_needs_reverification() {
    let row = stored(None, false, None);
    let update = update_identity_email(Some(&row), Some("alex@example.test"), true);
    assert_eq!(update.matching_email, None);
    assert!(!update.evidence_verified);
    assert_eq!(update.event, Some(EMAIL_CHANGED_EVENT));
}

#[test]
fn a_changed_unverified_email_clears_matching() {
    let row = stored(Some("alex@example.test"), true, Some("alex@example.test"));
    let update = update_identity_email(Some(&row), Some("sam@example.test"), false);
    assert_eq!(update.matching_email, None);
    assert!(!update.evidence_verified);
    assert_eq!(update.event, Some(EMAIL_CHANGED_EVENT));

    let update = update_identity_email(Some(&row), None, false);
    assert_eq!(update.event, Some(EMAIL_UNVERIFIED_EVENT));
}

#[test]
fn a_legacy_unverified_identity_matches_once_its_provider_verifies_it() {
    let row = stored(Some("alex@example.test"), false, None);
    let update = update_identity_email(Some(&row), Some("alex@example.test"), true);
    assert_eq!(update.matching_email.as_deref(), Some("alex@example.test"));
    assert!(update.evidence_verified);
}
