use chrono::{Duration, TimeZone, Utc};
use serde_json::json;

use super::super::test_support::organization;
use super::*;

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2030, 7, 1, 0, 0, 0).unwrap()
}

fn member_verified(days_ago: i64) -> CallerFacts {
    CallerFacts {
        is_member: true,
        source: Some("domain_claim".into()),
        verified_at: Some(now() - Duration::days(days_ago)),
        ..Default::default()
    }
}

#[test]
fn members_are_asked_to_reverify_before_the_interval_ends() {
    let org = organization(|_| {});
    let fresh = caller_state(&org, &member_verified(10), now());
    assert_eq!(fresh.state, AdmissionState::Member);
    assert!(fresh.reverify_by.is_some());
    let due = caller_state(&org, &member_verified(170), now());
    assert_eq!(due.state, AdmissionState::Reverify);

    let no_interval = organization(|o| o["admission"]["reverifyIntervalMonths"] = json!(null));
    let state = caller_state(&no_interval, &member_verified(1000), now());
    assert_eq!(state.state, AdmissionState::Member);
    assert_eq!(state.reverify_by, None);
}

#[test]
fn approved_members_do_not_reverify() {
    let org = organization(|_| {});
    let facts = CallerFacts {
        source: Some("join_request".into()),
        ..member_verified(1000)
    };
    assert_eq!(
        caller_state(&org, &facts, now()).state,
        AdmissionState::Member
    );
}

#[test]
fn non_members_see_pending_lapsed_join_or_not_open() {
    let org = organization(|_| {});
    let outsider = CallerFacts::default();
    let state = caller_state(&org, &outsider, now());
    assert_eq!(state.state, AdmissionState::Join);
    assert_eq!(
        state.options,
        JoinOptions {
            email_code: true,
            join_request: true
        }
    );
    let pending = CallerFacts {
        request_status: Some("pending".into()),
        ..Default::default()
    };
    assert_eq!(
        caller_state(&org, &pending, now()).state,
        AdmissionState::Pending
    );
    let lapsed = CallerFacts {
        lapsed_at: Some(now()),
        source: Some("domain_claim".into()),
        verified_at: Some(now() - Duration::days(200)),
        ..Default::default()
    };
    let state = caller_state(&org, &lapsed, now());
    assert_eq!(state.state, AdmissionState::Lapsed);
    assert_eq!(state.reverify_by, None);

    let disabled = organization(|o| o["state"] = json!("disabled"));
    let state = caller_state(&disabled, &outsider, now());
    assert_eq!(state.state, AdmissionState::NotOpen);
    assert!(!state.options.email_code && !state.options.join_request);

    let closed = organization(|o| {
        o["admission"]["autoJoinMethods"] = json!(["google"]);
        o["admission"]["joinRequests"]["enabled"] = json!(false);
    });
    assert_eq!(
        caller_state(&closed, &outsider, now()).state,
        AdmissionState::Unavailable
    );
}
