use super::*;

fn claim(claimed: Option<&str>, claim_active: bool) -> SessionOrganization {
    SessionOrganization {
        claimed: claimed.map(str::to_string),
        personal: Some("org_personal".to_string()),
        claim_active,
    }
}

#[test]
fn an_empty_claim_acts_in_the_personal_organization() {
    let organization =
        RequestOrganization::resolve("acct_a", &claim(None, false), Some("org_personal")).unwrap();
    assert_eq!(organization.organization_id, "org_personal");
    assert_eq!(organization.header, HeaderState::Present);
    assert_eq!(organization.mismatch, None);
}

#[test]
fn a_matching_header_agrees_with_the_claim() {
    let organization =
        RequestOrganization::resolve("acct_a", &claim(Some("org_team"), true), Some(" org_team "))
            .unwrap();
    assert_eq!(organization.organization_id, "org_team");
    assert_eq!(organization.mismatch, None);
}

#[test]
fn a_header_for_another_organization_is_a_mismatch() {
    let organization =
        RequestOrganization::resolve("acct_a", &claim(Some("org_team"), true), Some("org_other"))
            .unwrap();
    assert_eq!(organization.organization_id, "org_team");
    assert_eq!(
        organization.mismatch,
        Some(Mismatch::Header {
            named: "org_other".to_string()
        })
    );
}

#[test]
fn a_missing_header_is_a_mismatch_only_scoped_routes_report() {
    let organization =
        RequestOrganization::resolve("acct_a", &claim(Some("org_team"), true), None).unwrap();
    assert_eq!(organization.header, HeaderState::Missing);
    assert_eq!(organization.mismatch, Some(Mismatch::MissingHeader));
    let blank = RequestOrganization::resolve("acct_a", &claim(None, false), Some("  ")).unwrap();
    assert_eq!(blank.header, HeaderState::Missing);
}

#[test]
fn an_ended_membership_falls_back_to_the_personal_organization() {
    // The header still names the team the token claims: the membership is
    // what changed, so that is the reported reason.
    let organization =
        RequestOrganization::resolve("acct_a", &claim(Some("org_team"), false), Some("org_team"))
            .unwrap();
    assert_eq!(organization.organization_id, "org_personal");
    assert_eq!(
        organization.mismatch,
        Some(Mismatch::MembershipEnded {
            claimed: "org_team".to_string()
        })
    );
}

#[test]
fn no_personal_organization_means_no_request_organization() {
    let missing = SessionOrganization {
        claimed: None,
        personal: None,
        claim_active: false,
    };
    assert!(RequestOrganization::resolve("acct_a", &missing, None).is_none());
}

#[test]
fn content_is_checked_only_in_organizations_the_caller_belongs_to() {
    let organization =
        RequestOrganization::resolve("acct_a", &claim(Some("org_team"), true), Some("org_team"))
            .unwrap();
    assert_eq!(organization.content_mismatch("org_team", true), None);
    assert_eq!(
        organization.content_mismatch("org_personal", true),
        Some(Mismatch::Content {
            content: "org_personal".to_string()
        })
    );
    // An outsider in another team's group, or someone else's direct chat.
    assert_eq!(organization.content_mismatch("org_elsewhere", false), None);
}
