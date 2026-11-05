use serde_json::json;

use super::super::test_support::{parse, sample_file};
use super::*;

#[test]
fn parses_the_sample_file_with_bounded_defaults() {
    let admins = r#"["acct_example_admin", " Admin@Example.test "]"#;
    let admission = parse(&sample_file("example-research"), admins).unwrap();
    assert_eq!(admission.personal_pool.as_deref(), Some("default"));
    let org = &admission.organizations[0];
    assert_eq!(org.id, "example-research");
    assert_eq!(org.state, OrganizationState::Active);
    assert_eq!(org.pool.as_deref(), Some("example-pool"));
    assert_eq!(org.claim.domains, vec!["example.test"]);
    assert_eq!(org.claim.domain_match, DomainMatch::Exact);
    assert!(org.claim.require_google_hosted_domain);
    assert!(org.auto_joins(SignInMethod::Google));
    assert!(org.auto_joins(SignInMethod::EmailCode));
    assert!(!org.auto_joins(SignInMethod::Github));
    assert_eq!(org.reverify_interval_months, Some(6));
    let policy = org.join_requests.as_ref().unwrap();
    assert_eq!(org.request_retention_days, 30);
    assert_eq!(
        policy.approved_membership_expiry,
        ApprovedMembershipExpiry::SetByApprover
    );
    // `null` means undecided: not required, and a bounded length.
    assert!(policy.fields[0].required);
    assert_eq!(policy.fields[0].max_length, 40);
    assert!(!policy.fields[1].required);
    assert_eq!(policy.fields[1].max_length, DEFAULT_FIELD_MAX_LENGTH);
    assert_eq!(org.admins.account_ids, vec!["acct_example_admin"]);
    assert_eq!(org.admins.emails, vec!["admin@example.test"]);
    assert!(org.membership.require_member_owner);
    assert_eq!(org.entry_page.join_label, "Join Example Research");
    assert_eq!(org.organization_id, "", "filled only by sync");
}

#[test]
fn an_empty_organization_list_is_personal_organizations_only() {
    let mut file = sample_file("x");
    file["organizations"] = json!([]);
    let admission = parse(&file, "[]").unwrap();
    assert!(admission.is_empty());
    assert!(OrganizationAdmission::default().is_empty());
}

fn rejects(edit: impl FnOnce(&mut serde_json::Value), expected: &str) {
    let mut file = sample_file("example-research");
    edit(&mut file);
    let error = parse(&file, "[]").unwrap_err();
    assert!(error.contains(expected), "{error}");
    assert!(error.starts_with(FILE_ENV), "{error}");
}

#[test]
fn unknown_fields_are_rejected_everywhere() {
    rejects(|f| f["extra"] = json!(1), "unknown field `extra`");
    rejects(
        |f| f["organizations"][0]["admission"]["claimedDomain"] = json!([]),
        "unknown field `claimedDomain`",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["joinRequests"]["fields"][0]["hint"] = json!("x"),
        "unknown field `hint`",
    );
    rejects(
        |f| f["organizations"][0]["entryPage"]["subtitle"] = json!("x"),
        "unknown field `subtitle`",
    );
}

#[test]
fn missing_and_malformed_values_are_rejected() {
    rejects(
        |f| {
            f["organizations"][0]["admission"]
                .as_object_mut()
                .unwrap()
                .remove("domainMatch");
        },
        "missing field `domainMatch`",
    );
    rejects(|f| f["version"] = json!(2), "version must be 1");
    rejects(
        |f| f["organizations"][0]["state"] = json!("open"),
        "unknown variant `open`",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["autoJoinMethods"] = json!(["sms"]),
        "unknown variant `sms`",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["autoJoinMethods"] = json!(["google", "google"]),
        "repeated method",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["claimedDomains"] = json!(["Example.test"]),
        "claimedDomains",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["claimedDomains"] = json!(["localhost"]),
        "claimedDomains",
    );
    rejects(
        |f| f["organizations"][0]["id"] = json!("Example"),
        "organizations[0].id",
    );
    rejects(
        |f| f["organizations"][0]["entryPage"]["title"] = json!("Line\nbreak"),
        "entryPage.title",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["reverifyIntervalMonths"] = json!(0),
        "reverifyIntervalMonths",
    );
    rejects(
        |f| f["organizations"][0]["admission"]["joinRequests"]["approval"] = json!("anyone"),
        "unknown variant `anyone`",
    );
    rejects(
        |f| {
            let org = f["organizations"][0].clone();
            f["organizations"] = json!([org.clone(), org]);
        },
        "is used twice",
    );
}

#[test]
fn retention_is_required_while_join_requests_are_enabled() {
    rejects(
        |f| f["organizations"][0]["admission"]["joinRequests"]["retentionDays"] = json!(null),
        "retentionDays",
    );
    let mut file = sample_file("example-research");
    let requests = &mut file["organizations"][0]["admission"]["joinRequests"];
    requests["enabled"] = json!(false);
    requests["retentionDays"] = json!(null);
    let org = parse(&file, "[]").unwrap().organizations.remove(0);
    assert!(org.join_requests.is_none());
    assert_eq!(org.request_retention_days, DEFAULT_RETENTION_DAYS);
}

#[test]
fn approved_membership_expiry_forms() {
    let expiry = |value: serde_json::Value| {
        let mut file = sample_file("example-research");
        file["organizations"][0]["admission"]["joinRequests"]["approvedMembershipExpiry"] = value;
        parse(&file, "[]").map(|a| {
            a.organizations[0]
                .join_requests
                .as_ref()
                .unwrap()
                .approved_membership_expiry
        })
    };
    assert_eq!(
        expiry(json!(null)),
        Ok(ApprovedMembershipExpiry::SetByApprover)
    );
    assert_eq!(expiry(json!(90)), Ok(ApprovedMembershipExpiry::Days(90)));
    assert!(expiry(json!("forever")).is_err());
    assert!(expiry(json!(0)).is_err());
}

#[test]
fn admins_come_from_the_named_variable_and_are_never_echoed() {
    let file = sample_file("example-research");
    let error = parse(&file, r#"["not an email private-value"]"#).unwrap_err();
    assert!(
        error.contains(super::super::test_support::ADMINS_ENV),
        "{error}"
    );
    assert!(!error.contains("private-value"), "{error}");

    let missing = OrganizationAdmission::parse(&file.to_string(), |_| None).unwrap_err();
    assert!(missing.contains("is not set"), "{missing}");

    // An email whose local part looks like an account id is still an email.
    let parsed = parse(&file, r#"["acct_lab@example.test"]"#).unwrap();
    assert_eq!(
        parsed.organizations[0].admins.emails,
        vec!["acct_lab@example.test"]
    );
    assert!(parsed.organizations[0].admins.account_ids.is_empty());

    // A disabled organization may name admins it does not provision yet.
    let mut disabled = file.clone();
    disabled["organizations"][0]["state"] = json!("disabled");
    let parsed = OrganizationAdmission::parse(&disabled.to_string(), |_| None).unwrap();
    assert!(parsed.organizations[0].admins.account_ids.is_empty());
}

#[test]
fn email_keys_strip_subaddresses_by_default() {
    let org = super::super::test_support::organization(|_| {});
    assert!(org.strip_subaddress);
    assert_eq!(org.email_key(" Lab+A@Example.test "), "lab@example.test");
    assert_eq!(org.email_key("lab@example.test"), "lab@example.test");
    let literal = super::super::test_support::organization(|o| {
        o["admission"]["stripSubaddress"] = json!(false)
    });
    assert_eq!(
        literal.email_key("Lab+A@example.test"),
        "lab+a@example.test"
    );
}

#[test]
fn subdomain_claims_on_public_suffixes_warn() {
    let mut file = sample_file("example-research");
    file["organizations"][0]["admission"]["domainMatch"] = json!("subdomains");
    file["organizations"][0]["admission"]["claimedDomains"] = json!(["ac.test", "example.test"]);
    let admission = parse(&file, "[]").unwrap();
    assert_eq!(admission.warnings.len(), 1, "{:?}", admission.warnings);
    assert!(admission.warnings[0].contains("ac.test"));
    assert!(parse(&sample_file("x"), "[]").unwrap().warnings.is_empty());
}
