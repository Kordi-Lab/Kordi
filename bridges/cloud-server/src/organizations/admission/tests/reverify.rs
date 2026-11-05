use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::super::config::SignInMethod;
use super::super::store::{expire_due, sweep};
use super::harness;
use crate::common_ground::tests::db_fixture::signed_in;

async fn set_verified_days_ago(h: &super::Harness, account: &str, days: i32) {
    query(
        "UPDATE cloud_organization_admissions \
         SET verified_at = now() - make_interval(days => $3) \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(h.organization_id())
    .bind(account)
    .bind(days)
    .execute(&h.pool)
    .await
    .unwrap();
}

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
async fn google_sign_in_renews_and_an_overdue_membership_lapses() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "rv_google").await;
    let email = format!("{account}@example.test");
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;

    // Due within the notice window: still a member, asked to verify.
    set_verified_days_ago(&h, &account, 170).await;
    assert_eq!(h.entry(&token).await["admission"], "reverify");
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(h.entry(&token).await["admission"], "member");

    // Past the interval: the sweep ends the membership.
    set_verified_days_ago(&h, &account, 200).await;
    sweep(&h.pool, &h.admission).await;
    assert_eq!(h.role(&account).await, None);
    assert_eq!(
        lapse_reason(&h, &account).await.as_deref(),
        Some("reverification_due")
    );
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "lapsed", "{entry}");
    let (audits,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_audit_events \
         WHERE account_id = $1 AND event_type = 'organization.membership_lapsed'",
    )
    .bind(&account)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    // A fresh qualifying sign-in admits again.
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(h.role(&account).await.as_deref(), Some("member"));
    assert_eq!(lapse_reason(&h, &account).await, None);
}

#[tokio::test]
async fn without_google_reverification_only_an_email_code_renews() {
    let Some(h) = harness(
        |o| o["admission"]["googleSignInReverifies"] = json!(false),
        &[],
    )
    .await
    else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "rv_code").await;
    let email = format!("{account}@example.test");
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(h.role(&account).await.as_deref(), Some("member"));
    set_verified_days_ago(&h, &account, 170).await;
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    assert_eq!(
        h.entry(&token).await["admission"],
        "reverify",
        "Google does not renew"
    );
    h.sign_in(&account, SignInMethod::EmailCode, &email, true, None)
        .await;
    assert_eq!(h.entry(&token).await["admission"], "member");
}

#[tokio::test]
async fn an_expired_approval_lapses_but_configured_admins_stay() {
    let Some(pool) = crate::common_ground::tests::db_fixture::pool().await else {
        return;
    };
    let (admin, _) = signed_in(&pool, "rv_admin").await;
    let h = super::harness_on(pool, |_| {}, &[&admin]).await;
    let (member, _) = signed_in(&h.pool, "rv_member").await;
    for account in [&admin, &member] {
        h.sign_in(
            account,
            SignInMethod::EmailCode,
            &format!("{account}@example.test"),
            true,
            None,
        )
        .await;
        set_verified_days_ago(&h, account, 400).await;
    }
    let org = &h.admission.organizations[0];
    let mut lapsed = expire_due(&h.pool, org, None).await.unwrap();
    lapsed.sort();
    let mut expected = vec![admin.clone(), member.clone()];
    expected.sort();
    assert_eq!(lapsed, expected);
    assert_eq!(h.role(&admin).await.as_deref(), Some("admin"));
    assert_eq!(h.role(&member).await, None);

    // Approval expiry, independent of the verification interval.
    h.sign_in(
        &member,
        SignInMethod::EmailCode,
        &format!("{member}@example.test"),
        true,
        None,
    )
    .await;
    query(
        "UPDATE cloud_organization_admissions SET source = 'join_request', \
           expires_at = now() - interval '1 minute' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(h.organization_id())
    .bind(&member)
    .execute(&h.pool)
    .await
    .unwrap();
    assert_eq!(
        expire_due(&h.pool, org, Some(&member)).await.unwrap(),
        vec![member.clone()]
    );
    assert_eq!(
        lapse_reason(&h, &member).await.as_deref(),
        Some("approval_expired")
    );
}
