use serde_json::json;

use super::super::config::{OrganizationAdmission, SignInMethod};
use super::super::reload::LiveAdmission;
use super::super::test_support::{parse, sample_file};
use super::harness;
use crate::common_ground::tests::db_fixture::signed_in;

#[tokio::test]
async fn a_reload_narrows_keeps_widening_and_retires_removed_organizations() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let live = LiveAdmission::from(h.admission.clone());
    let (member, _) = signed_in(&h.pool, "adm_reload").await;
    h.sign_in(
        &member,
        SignInMethod::Google,
        &format!("{member}@example.test"),
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(h.role(&member).await.as_deref(), Some("member"));

    // Widen the domains and narrow the auto-join methods in one reload.
    let mut file = sample_file(h.config_id());
    let org = &mut file["organizations"][0];
    org["admission"]["claimedDomains"] = json!(["example.test", "wider.test"]);
    org["admission"]["autoJoinMethods"] = json!(["google"]);
    org["displayName"] = json!("Example Research Renamed");
    let merged = live
        .apply(&h.pool, parse(&file, "[]").unwrap())
        .await
        .unwrap();
    assert_eq!(merged.kept().count(), 1, "{:?}", merged.changes);
    let running = live.current();
    let org = &running.organizations[0];
    assert_eq!(org.organization_id, h.organization_id());
    assert_eq!(org.claim.domains, vec!["example.test"]);
    assert_eq!(org.auto_join_methods, vec![SignInMethod::Google]);
    assert_eq!(org.display_name, "Example Research Renamed");

    // A file without the organization removes it, and its members go.
    let empty: OrganizationAdmission = parse(&sample_file("other-unused"), "[]").unwrap();
    let merged = live
        .apply(
            &h.pool,
            OrganizationAdmission {
                organizations: Vec::new(),
                ..empty
            },
        )
        .await
        .unwrap();
    assert_eq!(merged.kept().count(), 0);
    assert!(live.current().organizations.is_empty());
    assert_eq!(h.role(&member).await, None);
}
