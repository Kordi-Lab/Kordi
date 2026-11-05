use serde_json::{json, Value};

use super::super::test_support::{parse, sample_file};
use super::*;

const ADMINS: &str = r#"["acct_example_admin", "admin@example.test"]"#;

/// The running configuration: the sample, synced to `org_example`.
fn running() -> OrganizationAdmission {
    let mut admission = parse(&sample_file("example-research"), ADMINS).unwrap();
    admission.organizations[0].organization_id = "org_example".into();
    admission
}

fn reloaded(edit: impl FnOnce(&mut Value), admins: &str) -> OrganizationAdmission {
    let mut file = sample_file("example-research");
    edit(&mut file["organizations"][0]);
    parse(&file, admins).unwrap()
}

fn keys(merged: &Merged, applied: bool) -> Vec<String> {
    merged
        .changes
        .iter()
        .filter(|c| c.applied == applied)
        .map(|c| c.key.clone())
        .collect()
}

#[test]
fn ordinary_keys_apply_and_the_database_id_is_kept() {
    let next = reloaded(
        |org| {
            org["displayName"] = json!("Example Research Lab");
            org["pool"] = json!("other-pool");
            org["entryPage"]["title"] = json!("Example Lab");
            org["admission"]["joinRequests"]["retentionDays"] = json!(14);
            org["admission"]["joinRequests"]["fields"][0]["label"] = json!("Group");
        },
        ADMINS,
    );
    let merged = merge(&running(), next);
    assert!(merged.changes.is_empty(), "{:?}", merged.changes);
    let org = &merged.admission.organizations[0];
    assert_eq!(org.organization_id, "org_example");
    assert_eq!(org.display_name, "Example Research Lab");
    assert_eq!(org.pool.as_deref(), Some("other-pool"));
    assert_eq!(org.entry_page.title, "Example Lab");
    assert_eq!(org.request_retention_days, 14);
    assert_eq!(org.join_requests.as_ref().unwrap().fields[0].label, "Group");
}

#[test]
fn narrowing_critical_keys_applies() {
    let next = reloaded(
        |org| {
            org["state"] = json!("disabled");
            org["admission"]["autoJoinMethods"] = json!(["google"]);
            org["admission"]["reverifyIntervalMonths"] = json!(3);
            org["admission"]["googleSignInReverifies"] = json!(false);
            org["admission"]["joinRequests"]["enabled"] = json!(false);
            org["membership"]["outsidersAllowed"] = json!(false);
        },
        r#"["acct_example_admin"]"#,
    );
    let merged = merge(&running(), next);
    assert_eq!(merged.kept().count(), 0, "{:?}", merged.changes);
    let org = &merged.admission.organizations[0];
    assert_eq!(org.state, OrganizationState::Disabled);
    assert_eq!(org.auto_join_methods, vec![SignInMethod::Google]);
    assert_eq!(org.reverify_interval_months, Some(3));
    assert!(!org.google_sign_in_reverifies);
    assert!(org.join_requests.is_none());
    assert!(!org.membership.outsiders_allowed);
    assert!(org.admins.emails.is_empty());
    assert_eq!(org.admins.account_ids, vec!["acct_example_admin"]);
}

#[test]
fn widening_critical_keys_is_kept_back_and_reported() {
    let next = reloaded(
        |org| {
            org["admission"]["claimedDomains"] = json!(["example.test", "other.test"]);
            org["admission"]["domainMatch"] = json!("subdomains");
            org["admission"]["requireGoogleHostedDomain"] = json!(false);
            org["admission"]["autoJoinMethods"] = json!(["google", "email_code", "github"]);
            org["admission"]["reverifyIntervalMonths"] = json!(null);
            org["admission"]["stripSubaddress"] = json!(false);
            org["admission"]["joinRequests"]["approvedMembershipExpiry"] = json!(30);
            org["membership"]["requireMemberOwner"] = json!(false);
            // Display name still applies alongside.
            org["displayName"] = json!("Renamed");
        },
        r#"["acct_example_admin", "admin@example.test", "acct_new_admin"]"#,
    );
    let current = running();
    let merged = merge(&current, next);
    let org = &merged.admission.organizations[0];
    let before = &current.organizations[0];
    assert_eq!(org.claim, before.claim);
    assert_eq!(org.auto_join_methods, before.auto_join_methods);
    assert_eq!(org.reverify_interval_months, Some(6));
    assert!(org.strip_subaddress);
    assert_eq!(
        org.join_requests
            .as_ref()
            .unwrap()
            .approved_membership_expiry,
        ApprovedMembershipExpiry::SetByApprover
    );
    assert!(org.membership.require_member_owner);
    assert_eq!(org.admins, before.admins);
    assert_eq!(org.display_name, "Renamed");
    assert_eq!(
        keys(&merged, false),
        vec![
            "organizations[example-research].claimedDomains",
            "organizations[example-research].domainMatch",
            "organizations[example-research].requireGoogleHostedDomain",
            "organizations[example-research].autoJoinMethods",
            "organizations[example-research].reverifyIntervalMonths",
            "organizations[example-research].stripSubaddress",
            "organizations[example-research].joinRequests.approvedMembershipExpiry",
            "organizations[example-research].membership.requireMemberOwner",
            "organizations[example-research].admins.accountIds",
        ]
    );
    let domains = merged
        .kept()
        .find(|c| c.key.ends_with("claimedDomains"))
        .unwrap();
    assert!(domains.detail.contains("other.test"), "{}", domains.detail);
    let admins = merged
        .kept()
        .find(|c| c.key.ends_with("admins.accountIds"))
        .unwrap();
    assert_eq!(admins.detail, "1 added, 0 removed");
    assert!(!admins.detail.contains("acct_new_admin"));
}

#[test]
fn reopening_a_disabled_organization_needs_a_restart() {
    let mut current = running();
    current.organizations[0].state = OrganizationState::Disabled;
    let merged = merge(&current, reloaded(|_| {}, ADMINS));
    assert_eq!(
        merged.admission.organizations[0].state,
        OrganizationState::Disabled
    );
    assert_eq!(
        keys(&merged, false),
        vec!["organizations[example-research].state"]
    );
    // Interim and active admit alike, so switching between them applies.
    let merged = merge(
        &running(),
        reloaded(|org| org["state"] = json!("interim"), ADMINS),
    );
    assert_eq!(
        merged.admission.organizations[0].state,
        OrganizationState::Interim
    );
    assert_eq!(merged.kept().count(), 0);
}

#[test]
fn enabling_join_requests_needs_a_restart() {
    let mut current = running();
    current.organizations[0].join_requests = None;
    let merged = merge(&current, reloaded(|_| {}, ADMINS));
    assert!(merged.admission.organizations[0].join_requests.is_none());
    assert_eq!(
        keys(&merged, false),
        vec!["organizations[example-research].joinRequests.enabled"]
    );
}

#[test]
fn removing_an_organization_applies_and_adding_one_waits_for_a_restart() {
    let mut file = sample_file("other-research");
    let removed = merge(&running(), parse(&file, ADMINS).unwrap());
    assert!(removed.admission.organizations.is_empty());
    assert_eq!(
        keys(&removed, true),
        vec!["organizations[example-research]"]
    );
    assert_eq!(keys(&removed, false), vec!["organizations[other-research]"]);

    let second = sample_file("example-research")["organizations"][0].clone();
    file["organizations"].as_array_mut().unwrap().push(second);
    let added = merge(&running(), parse(&file, ADMINS).unwrap());
    assert_eq!(added.admission.organizations.len(), 1);
    assert_eq!(added.admission.organizations[0].id, "example-research");
    assert_eq!(keys(&added, false), vec!["organizations[other-research]"]);
}

#[test]
fn an_unchanged_file_merges_to_the_running_configuration() {
    let current = running();
    let merged = merge(&current, reloaded(|_| {}, ADMINS));
    assert!(merged.changes.is_empty());
    assert_eq!(merged.admission.organizations, current.organizations);
}
