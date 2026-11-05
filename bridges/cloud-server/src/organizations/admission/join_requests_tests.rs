use std::collections::BTreeMap;

use chrono::{Duration, TimeZone, Utc};

use super::super::test_support::organization;
use super::*;

fn fields() -> Vec<JoinRequestField> {
    organization(|_| {}).join_requests.unwrap().fields
}

fn submitted(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn fields_follow_the_configuration() {
    let configured = fields();
    let ok = validate_fields(
        &configured,
        &submitted(&[("affiliation", "  Example Lab  ")]),
    )
    .unwrap();
    assert_eq!(ok, submitted(&[("affiliation", "Example Lab")]));

    let missing = validate_fields(&configured, &submitted(&[("purpose", "Research")]));
    assert_eq!(missing.unwrap_err().code, "invalid_join_request");
    let blank = validate_fields(&configured, &submitted(&[("affiliation", "   ")]));
    assert!(blank.is_err());
    let unknown = validate_fields(
        &configured,
        &submitted(&[("affiliation", "Lab"), ("phone", "1")]),
    );
    assert!(unknown.is_err());
    let long = "x".repeat(41);
    assert!(validate_fields(&configured, &submitted(&[("affiliation", &long)])).is_err());
    let at_limit = "é".repeat(40);
    assert!(validate_fields(&configured, &submitted(&[("affiliation", &at_limit)])).is_ok());
}

#[test]
fn approval_expiry_follows_the_policy() {
    let now = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
    let later = (now + Duration::days(30)).to_rfc3339();
    let past = (now - Duration::days(1)).to_rfc3339();
    use ApprovedMembershipExpiry::*;
    assert_eq!(approved_expiry(Never, None, now).unwrap(), None);
    assert!(approved_expiry(Never, Some(&later), now).is_err());
    assert_eq!(
        approved_expiry(Days(90), None, now).unwrap(),
        Some(now + Duration::days(90))
    );
    assert!(approved_expiry(Days(90), Some(&later), now).is_err());
    assert_eq!(approved_expiry(SetByApprover, None, now).unwrap(), None);
    assert_eq!(
        approved_expiry(SetByApprover, Some(&later), now).unwrap(),
        Some(now + Duration::days(30))
    );
    assert!(approved_expiry(SetByApprover, Some(&past), now).is_err());
    assert!(approved_expiry(SetByApprover, Some("tomorrow"), now).is_err());
}
