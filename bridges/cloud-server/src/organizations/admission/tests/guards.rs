//! The generic members API on configured organizations, and one inbox per
//! account.

use serde_json::json;
use sqlx_core::query_as::query_as;

use super::super::config::SignInMethod;
use super::{harness, harness_on, ACCOUNT_ORGS};
use crate::common_ground::tests::db_fixture::{pool, send, signed_in};

async fn lapse_reason(h: &super::Harness, account: &str) -> Option<String> {
    let (reason,): (Option<String>,) = query_as(
        "SELECT lapse_reason FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(h.organization_id())
    .bind(account)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    reason
}

#[tokio::test]
async fn the_members_api_cannot_bypass_admission() {
    let Some(pool) = pool().await else { return };
    let (admin, admin_token) = signed_in(&pool, "gd_admin").await;
    let h = harness_on(pool, |_| {}, &[&admin]).await;
    let (outsider, _) = signed_in(&h.pool, "gd_outsider").await;
    let (member, member_token) = signed_in(&h.pool, "gd_member").await;
    let email = format!("{member}@example.test");
    h.sign_in(&member, SignInMethod::EmailCode, &email, true, None)
        .await;
    let members = format!("/v1/cloud/organizations/{}/members", h.organization_id());

    let add = json!({"accountId": outsider, "role": "admin"});
    let invitations = format!(
        "/v1/cloud/organizations/{}/invitations",
        h.organization_id()
    );
    let (status, body) = send(&h.app, "POST", &invitations, &admin_token, Some(add)).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("configured_organization"))
    );
    assert_eq!(h.role(&outsider).await, None);
    let promote = json!({"role": "admin"});
    let (status, body) = send(
        &h.app,
        "PATCH",
        &format!("{members}/{member}"),
        &admin_token,
        Some(promote),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("configured_organization"))
    );
    assert_eq!(h.role(&member).await.as_deref(), Some("member"));
    let (status, body) = send(
        &h.app,
        "DELETE",
        &format!("{members}/{admin}"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("configured_admin"))
    );

    // Removal lapses the admission and frees the email; sign-in does not
    // bring the account back.
    let (status, body) = send(
        &h.app,
        "DELETE",
        &format!("{members}/{member}"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(h.role(&member).await, None);
    assert_eq!(lapse_reason(&h, &member).await.as_deref(), Some("removed"));
    h.sign_in(&member, SignInMethod::EmailCode, &email, true, None)
        .await;
    h.sign_in(
        &member,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(h.role(&member).await, None);
    let entry = h.entry(&member_token).await;
    assert_eq!(entry["admission"], "lapsed", "{entry}");
    assert_eq!(entry["joinOptions"]["emailCode"], false);
    assert_eq!(entry["joinOptions"]["joinRequest"], true);
    let (other, _) = signed_in(&h.pool, "gd_other").await;
    h.sign_in(&other, SignInMethod::EmailCode, &email, true, None)
        .await;
    assert_eq!(
        h.role(&other).await.as_deref(),
        Some("member"),
        "the email is free"
    );

    // An approved join request admits the removed account again.
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (status, body) = send(&h.app, "POST", &submit, &member_token, Some(request)).await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["joinRequest"]["requestId"].as_str().unwrap();
    let approve = format!(
        "/v1/cloud/organizations/{}/join-requests/{request_id}/approve",
        h.organization_id()
    );
    let (status, body) = send(&h.app, "POST", &approve, &admin_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body["joinRequest"]["membershipExpiresAt"].is_string(),
        "{body}"
    );
    assert_eq!(h.role(&member).await.as_deref(), Some("member"));
}

#[tokio::test]
async fn subaddresses_share_one_inbox_unless_configured_otherwise() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (alex, _) = signed_in(&h.pool, "gd_plus_a").await;
    let (sam, _) = signed_in(&h.pool, "gd_plus_b").await;
    let base = format!("lab-{alex}");
    h.sign_in(
        &alex,
        SignInMethod::EmailCode,
        &format!("{base}+a@example.test"),
        true,
        None,
    )
    .await;
    h.sign_in(
        &sam,
        SignInMethod::EmailCode,
        &format!("{base}+b@example.test"),
        true,
        None,
    )
    .await;
    assert_eq!(h.role(&alex).await.as_deref(), Some("member"));
    assert_eq!(h.role(&sam).await, None, "one inbox admits one account");

    let open = harness_on(
        h.pool.clone(),
        |o| o["admission"]["stripSubaddress"] = json!(false),
        &[],
    )
    .await;
    open.sign_in(
        &alex,
        SignInMethod::EmailCode,
        &format!("{base}+a@example.test"),
        true,
        None,
    )
    .await;
    open.sign_in(
        &sam,
        SignInMethod::EmailCode,
        &format!("{base}+b@example.test"),
        true,
        None,
    )
    .await;
    assert_eq!(open.role(&sam).await.as_deref(), Some("member"));
}
