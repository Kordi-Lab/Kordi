use serde_json::{json, Value};
use sqlx_core::query::query;

use super::super::config::SignInMethod;
use super::{harness, Harness, ACCOUNT_ORGS};
use crate::common_ground::tests::db_fixture::{send, signed_in};

const JOINABLE: &str = "/v1/cloud/account/joinable-organizations";

async fn verify_email(h: &Harness, account: &str, email: &str) {
    query(
        "UPDATE cloud_accounts SET primary_email = $2, primary_email_verified_at = $3 \
         WHERE account_id = $1",
    )
    .bind(account)
    .bind(email)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&h.pool)
    .await
    .unwrap();
}

async fn joinable(h: &Harness, token: &str) -> Value {
    let (status, body) = send(&h.app, "GET", JOINABLE, token, None).await;
    assert_eq!(status, 200, "{body}");
    body
}

#[tokio::test]
async fn lists_organizations_claiming_the_verified_email_domain() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "jo_list").await;

    // An unverified email matches nothing.
    let body = joinable(&h, &token).await;
    assert_eq!(body["emailDomain"], Value::Null, "{body}");
    assert_eq!(body["organizations"], json!([]));

    let email = format!("{account}@example.test");
    verify_email(&h, &account, &email).await;
    let body = joinable(&h, &token).await;
    assert_eq!(body["email"], email.as_str());
    assert_eq!(body["emailDomain"], "example.test");
    let entries = body["organizations"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{body}");
    let entry = &entries[0];
    assert_eq!(entry["id"], h.config_id());
    assert_eq!(entry["organizationId"], h.organization_id());
    assert_eq!(entry["name"], "Example Research");
    assert_eq!(entry["memberCount"], 0);
    assert_eq!(
        entry["joinOptions"],
        json!({"emailCode": true, "joinRequest": true})
    );
    assert_eq!(entry["requested"], false);
    assert_eq!(entry["joinRequestFields"][0]["key"], "affiliation");
    assert_eq!(entry["joinRequestFields"][0]["required"], true);

    // An open join request stays listed as requested.
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (status, body) = send(&h.app, "POST", &submit, &token, Some(request)).await;
    assert_eq!(status, 201, "{body}");
    let entry = joinable(&h, &token).await["organizations"][0].clone();
    assert_eq!(entry["requested"], true, "{entry}");
    assert_eq!(entry["joinOptions"]["joinRequest"], false, "{entry}");

    // A member no longer sees the organization; others see the new count.
    h.sign_in(&account, SignInMethod::EmailCode, &email, true, None)
        .await;
    assert_eq!(h.role(&account).await.as_deref(), Some("member"));
    assert_eq!(joinable(&h, &token).await["organizations"], json!([]));
    let (other, other_token) = signed_in(&h.pool, "jo_other").await;
    verify_email(&h, &other, &format!("{other}@example.test")).await;
    let entry = joinable(&h, &other_token).await["organizations"][0].clone();
    assert_eq!(entry["memberCount"], 1, "{entry}");
}

#[tokio::test]
async fn skips_other_domains_and_closed_organizations() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "jo_domain").await;
    verify_email(&h, &account, &format!("{account}@sub.example.test")).await;
    let body = joinable(&h, &token).await;
    assert_eq!(body["emailDomain"], "sub.example.test");
    assert_eq!(
        body["organizations"],
        json!([]),
        "exact claims skip subdomains"
    );

    let Some(h) = harness(|org| org["state"] = "disabled".into(), &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "jo_closed").await;
    verify_email(&h, &account, &format!("{account}@example.test")).await;
    assert_eq!(joinable(&h, &token).await["organizations"], json!([]));
}

#[tokio::test]
async fn offers_only_the_paths_the_organization_allows() {
    let Some(h) = harness(
        |org| org["admission"]["autoJoinMethods"] = json!(["google"]),
        &[],
    )
    .await
    else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "jo_request").await;
    verify_email(&h, &account, &format!("{account}@example.test")).await;
    let entry = joinable(&h, &token).await["organizations"][0].clone();
    assert_eq!(
        entry["joinOptions"],
        json!({"emailCode": false, "joinRequest": true}),
        "{entry}"
    );

    let Some(h) = harness(
        |org| {
            org["admission"]["autoJoinMethods"] = json!(["google"]);
            org["admission"]["joinRequests"]["enabled"] = false.into();
        },
        &[],
    )
    .await
    else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "jo_none").await;
    verify_email(&h, &account, &format!("{account}@example.test")).await;
    assert_eq!(joinable(&h, &token).await["organizations"], json!([]));
}

#[tokio::test]
async fn a_rejected_request_is_not_shown_as_requested() {
    let Some(pool) = crate::common_ground::tests::db_fixture::pool().await else {
        return;
    };
    let (admin, admin_token) = signed_in(&pool, "jo_rej_admin").await;
    let h = super::harness_on(pool, |_| {}, &[&admin]).await;
    let (account, token) = signed_in(&h.pool, "jo_rej").await;
    verify_email(&h, &account, &format!("{account}@example.test")).await;
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (_, body) = send(&h.app, "POST", &submit, &token, Some(request)).await;
    let request_id = body["joinRequest"]["requestId"].as_str().unwrap();
    let reject = format!(
        "/v1/cloud/organizations/{}/join-requests/{request_id}/reject",
        h.organization_id()
    );
    let (status, body) = send(&h.app, "POST", &reject, &admin_token, None).await;
    assert_eq!(status, 200, "{body}");

    // The email code still admits the caller, so the entry stays, unrequested.
    let entry = joinable(&h, &token).await["organizations"][0].clone();
    assert_eq!(entry["requested"], false, "{entry}");
    assert_eq!(entry["joinOptions"]["emailCode"], true, "{entry}");
    assert_eq!(entry["joinOptions"]["joinRequest"], false, "{entry}");
}
