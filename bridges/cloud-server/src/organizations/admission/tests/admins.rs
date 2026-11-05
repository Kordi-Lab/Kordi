//! Configured admins and organizations removed from the file.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::super::config::SignInMethod;
use super::super::store::{orphaned_ids, retire_orphan};
use super::super::test_support::{parse, sample_file};
use super::{harness_on, ACCOUNT_ORGS};
use crate::common_ground::tests::db_fixture::{pool, send, signed_in};

#[tokio::test]
async fn an_admin_email_needs_proof_under_the_organizations_rules() {
    let Some(pool) = pool().await else { return };
    let (admin, _) = signed_in(&pool, "ad_email").await;
    let email = format!("{admin}@example.test");
    let h = harness_on(pool, |_| {}, &[&email]).await;
    assert_eq!(
        h.role(&admin).await,
        None,
        "email admins wait for a sign-in"
    );
    h.sign_in(&admin, SignInMethod::Github, &email, true, None)
        .await;
    assert_eq!(
        h.role(&admin).await,
        None,
        "GitHub is not an auto-join method"
    );
    // Google without the hosted domain proves nothing for admin either.
    let other = harness_on(
        h.pool.clone(),
        |o| o["admission"]["claimedDomains"] = json!(["other.test"]),
        &[&email],
    )
    .await;
    other
        .sign_in(&admin, SignInMethod::Google, &email, true, None)
        .await;
    assert_eq!(other.role(&admin).await, None);
    other
        .sign_in(&admin, SignInMethod::EmailCode, &email, true, None)
        .await;
    assert_eq!(other.role(&admin).await.as_deref(), Some("admin"));

    // The grant lasts while the email is listed, across restarts.
    let mut file = sample_file(other.config_id());
    file["organizations"][0]["admission"]["claimedDomains"] = json!(["other.test"]);
    let listed = serde_json::to_string(&[&email]).unwrap();
    parse(&file, &listed)
        .unwrap()
        .sync_configured(&other.pool)
        .await
        .unwrap();
    assert_eq!(other.role(&admin).await.as_deref(), Some("admin"));
    parse(&file, "[]")
        .unwrap()
        .sync_configured(&other.pool)
        .await
        .unwrap();
    assert_eq!(
        other.role(&admin).await,
        None,
        "delisted and never admitted"
    );
}

#[tokio::test]
async fn a_disabled_organization_has_no_configured_admins() {
    let Some(pool) = pool().await else { return };
    let (admin, _) = signed_in(&pool, "ad_off").await;
    let h = harness_on(pool, |_| {}, &[&admin]).await;
    assert_eq!(h.role(&admin).await.as_deref(), Some("admin"));
    let mut file = sample_file(h.config_id());
    file["organizations"][0]["state"] = json!("disabled");
    let ids = serde_json::to_string(&[&admin]).unwrap();
    parse(&file, &ids)
        .unwrap()
        .sync_configured(&h.pool)
        .await
        .unwrap();
    assert_eq!(h.role(&admin).await, None);
}

#[tokio::test]
async fn a_delisted_admin_keeps_an_admitted_membership() {
    let Some(pool) = pool().await else { return };
    let (admin, _) = signed_in(&pool, "ad_backed").await;
    let h = harness_on(pool, |_| {}, &[&admin]).await;
    h.sign_in(
        &admin,
        SignInMethod::EmailCode,
        &format!("{admin}@example.test"),
        true,
        None,
    )
    .await;
    parse(&sample_file(h.config_id()), "[]")
        .unwrap()
        .sync_configured(&h.pool)
        .await
        .unwrap();
    assert_eq!(h.role(&admin).await.as_deref(), Some("member"));
}

#[tokio::test]
async fn an_organization_removed_from_the_file_is_retired() {
    let Some(pool) = pool().await else { return };
    let (admin, _) = signed_in(&pool, "ad_orphan_admin").await;
    let h = harness_on(pool, |_| {}, &[&admin]).await;
    let (member, token) = signed_in(&h.pool, "ad_orphan_member").await;
    h.sign_in(
        &member,
        SignInMethod::EmailCode,
        &format!("{member}@example.test"),
        true,
        None,
    )
    .await;
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let (_, outsider_token) = signed_in(&h.pool, "ad_orphan_req").await;
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (status, _) = send(&h.app, "POST", &submit, &outsider_token, Some(request)).await;
    assert_eq!(status, 201);

    // Detection only: retiring every unlisted organization would touch the
    // other tests sharing this database.
    let empty = parse(&sample_file("unused"), "[]").unwrap();
    let mut empty = empty;
    empty.organizations.clear();
    let orphaned = orphaned_ids(&h.pool, &empty).await.unwrap();
    assert!(orphaned.iter().any(|id| id == h.organization_id()));
    retire_orphan(&h.pool, h.organization_id()).await.unwrap();
    assert_eq!(h.role(&member).await, None);
    assert_eq!(h.role(&admin).await, None);
    let (reason,): (Option<String>,) = query_as(
        "SELECT lapse_reason FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(h.organization_id())
    .bind(&member)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(reason.as_deref(), Some("organization_removed"));
    // The account page no longer lists it.
    let (status, body) = send(&h.app, "GET", ACCOUNT_ORGS, &token, None).await;
    assert_eq!(status, 200);
    assert!(!body["organizations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["organizationId"] == h.organization_id()));

    // Join requests go after the default retention.
    query("UPDATE cloud_organization_join_requests SET created_at = now() - interval '31 days' WHERE organization_id = $1")
        .bind(h.organization_id())
        .execute(&h.pool)
        .await
        .unwrap();
    retire_orphan(&h.pool, h.organization_id()).await.unwrap();
    let (left,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_organization_join_requests WHERE organization_id = $1",
    )
    .bind(h.organization_id())
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
}
