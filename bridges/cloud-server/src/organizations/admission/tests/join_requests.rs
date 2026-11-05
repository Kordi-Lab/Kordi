use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::super::store::purge_join_requests;
use super::{harness, ACCOUNT_ORGS};
use crate::common_ground::tests::db_fixture::{send, signed_in};

#[tokio::test]
async fn join_request_lifecycle_and_retention() {
    let Some(pool) = crate::common_ground::tests::db_fixture::pool().await else {
        return;
    };
    let (admin, admin_token) = signed_in(&pool, "jr_admin").await;
    let h = super::harness_on(pool, |_| {}, &[&admin]).await;
    let (applicant, token) = signed_in(&h.pool, "jr_applicant").await;
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let list = format!(
        "/v1/cloud/organizations/{}/join-requests",
        h.organization_id()
    );

    for bad in [
        json!({"fields": {"purpose": "Research"}}),
        json!({"fields": {"affiliation": "x".repeat(41)}}),
        json!({"fields": {"affiliation": "Example Lab", "phone": "1"}}),
    ] {
        let (status, body) = send(&h.app, "POST", &submit, &token, Some(bad)).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (400, Some("invalid_join_request"))
        );
    }
    let request = json!({"fields": {"affiliation": " Example Lab ", "purpose": "Teaching"}});
    let (status, body) = send(&h.app, "POST", &submit, &token, Some(request.clone())).await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["joinRequest"]["requestId"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, body) = send(&h.app, "POST", &submit, &token, Some(request)).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("join_request_exists"))
    );
    assert_eq!(h.entry(&token).await["admission"], "pending");

    // Only owners and admins review: a non-member sees nothing.
    let (status, _) = send(&h.app, "GET", &list, &token, None).await;
    assert_eq!(status, 404);
    let (status, body) = send(&h.app, "GET", &list, &admin_token, None).await;
    assert_eq!(status, 200, "{body}");
    let requests = body["joinRequests"].as_array().unwrap();
    assert_eq!(requests.len(), 1, "{body}");
    assert_eq!(requests[0]["accountId"], applicant.as_str());
    assert_eq!(requests[0]["fields"]["affiliation"], "Example Lab");
    assert_eq!(body["fields"][0]["key"], "affiliation");

    let approve = format!("{list}/{request_id}/approve");
    let (status, _) = send(&h.app, "POST", &approve, &token, None).await;
    assert_eq!(status, 404, "the applicant cannot approve themself");
    let (status, body) = send(
        &h.app,
        "POST",
        &approve,
        &admin_token,
        Some(json!({"expiresAt": "soon"})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("invalid_expiry"))
    );
    let (status, body) = send(
        &h.app,
        "POST",
        &approve,
        &admin_token,
        Some(json!({"expiry": 1})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("invalid_body"))
    );
    let expires_at = (chrono::Utc::now() + chrono::Duration::days(60)).to_rfc3339();
    let (status, body) = send(
        &h.app,
        "POST",
        &approve,
        &admin_token,
        Some(json!({"expiresAt": expires_at})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["joinRequest"]["status"], "approved");
    let (status, _) = send(&h.app, "POST", &approve, &admin_token, None).await;
    assert_eq!(status, 404, "a request is decided once");
    assert_eq!(h.role(&applicant).await.as_deref(), Some("member"));
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "member", "{entry}");
    assert!(entry["expiresAt"].is_string(), "{entry}");
    assert!(
        entry["reverifyBy"].is_null(),
        "approved members do not reverify"
    );
    let (approver,): (Option<String>,) = query_as(
        "SELECT approved_by_account_id FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(h.organization_id())
    .bind(&applicant)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(approver.as_deref(), Some(admin.as_str()));

    // A plain member cannot review.
    let (status, body) = send(&h.app, "GET", &list, &token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (403, Some("organization_forbidden"))
    );

    // Rows older than the retention period are deleted with their fields.
    query("UPDATE cloud_organization_join_requests SET created_at = now() - interval '31 days' WHERE request_id = $1")
        .bind(&request_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let org = &h.admission.organizations[0];
    assert_eq!(purge_join_requests(&h.pool, org).await.unwrap(), 1);
    let (left,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_organization_join_requests WHERE organization_id = $1",
    )
    .bind(h.organization_id())
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_rejected_request_blocks_another_until_purged() {
    let Some(pool) = crate::common_ground::tests::db_fixture::pool().await else {
        return;
    };
    let (admin, admin_token) = signed_in(&pool, "jr_rej_admin").await;
    let h = super::harness_on(pool, |_| {}, &[&admin]).await;
    let (applicant, token) = signed_in(&h.pool, "jr_rej").await;
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let request = json!({"fields": {"affiliation": "Example Lab"}});
    let (_, body) = send(&h.app, "POST", &submit, &token, Some(request.clone())).await;
    let request_id = body["joinRequest"]["requestId"].as_str().unwrap();
    let reject = format!(
        "/v1/cloud/organizations/{}/join-requests/{request_id}/reject",
        h.organization_id()
    );
    let (status, body) = send(&h.app, "POST", &reject, &admin_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(h.role(&applicant).await, None);
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "join", "{entry}");
    assert_eq!(entry["joinRequest"]["status"], "rejected");
    let (status, _) = send(&h.app, "POST", &submit, &token, Some(request)).await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn join_requests_are_refused_when_disabled() {
    let Some(h) = harness(
        |o| o["admission"]["joinRequests"]["enabled"] = json!(false),
        &[],
    )
    .await
    else {
        return;
    };
    let (_, token) = signed_in(&h.pool, "jr_off").await;
    let submit = format!("{ACCOUNT_ORGS}/{}/join-requests", h.config_id());
    let (status, body) = send(&h.app, "POST", &submit, &token, Some(json!({"fields": {}}))).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("join_requests_closed"))
    );
    let unknown = format!("{ACCOUNT_ORGS}/not-configured/join-requests");
    let (status, _) = send(
        &h.app,
        "POST",
        &unknown,
        &token,
        Some(json!({"fields": {}})),
    )
    .await;
    assert_eq!(status, 404);
}
