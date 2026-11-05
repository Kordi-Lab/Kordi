//! Invitations, leaving, expiry, and the last owner.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::{add, invite, team, ORGS};
use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

const MINE: &str = "/v1/cloud/organization-invitations";

async fn member_rows(pool: &sqlx_postgres::PgPool, organization: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT account_id, role FROM cloud_organization_members \
         WHERE organization_id = $1 ORDER BY account_id",
    )
    .bind(organization)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn joining_a_team_takes_the_invitees_consent() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "inv_owner").await;
    let (priya, priya_token) = signed_in(&pool, "inv_invitee").await;
    let organization = team(&pool, &alex).await;

    let (status, body) = invite(&app, &alex_token, &organization, &priya, "member").await;
    assert_eq!(status, 201, "{body}");
    let first = body["invitation"]["invitationId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(member_rows(&pool, &organization).await.len(), 1, "not yet");
    let (status, body) = send(&app, "GET", MINE, &priya_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["invitations"][0]["invitationId"], first.as_str());
    assert_eq!(body["invitations"][0]["organizationName"], "Example team");

    let (status, _) = send(
        &app,
        "POST",
        &format!("{MINE}/{first}/decline"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    let (status, body) = send(
        &app,
        "POST",
        &format!("{MINE}/{first}/accept"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("invitation_not_found"))
    );

    let (_, body) = invite(&app, &alex_token, &organization, &priya, "member").await;
    let second = body["invitation"]["invitationId"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("{ORGS}/{organization}/invitations");
    let (status, body) = send(&app, "GET", &path, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["invitations"].as_array().unwrap().len(), 1);
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("{path}/{second}"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    let (status, _) = send(
        &app,
        "POST",
        &format!("{MINE}/{second}/accept"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 404, "a revoked invitation cannot be accepted");

    let (_, body) = invite(&app, &alex_token, &organization, &priya, "member").await;
    let third = body["invitation"]["invitationId"]
        .as_str()
        .unwrap()
        .to_string();
    // Only the invitee can accept.
    let (status, _) = send(
        &app,
        "POST",
        &format!("{MINE}/{third}/accept"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 404);
    let (status, body) = send(
        &app,
        "POST",
        &format!("{MINE}/{third}/accept"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["organization"]["role"], "member");
    assert_eq!(member_rows(&pool, &organization).await.len(), 2);

    // A plain member does not see or send invitations.
    let (status, _) = send(&app, "GET", &path, &priya_token, None).await;
    assert_eq!(status, 403);
    let sam = account(&pool, "inv_other").await;
    let (status, _) = invite(&app, &priya_token, &organization, &sam, "member").await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn unavailable_invitees_get_one_generic_answer() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "inv_generic").await;
    let organization = team(&pool, &alex).await;
    crate::system_account::ensure_account(&pool).await.unwrap();
    for id in [
        crate::system_account::SYSTEM_ACCOUNT_ID,
        "acct_missing_example",
        alex.as_str(),
    ] {
        let (status, body) = invite(&app, &alex_token, &organization, id, "member").await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (404, Some("invitee_unavailable")),
            "{id}"
        );
    }
}

#[tokio::test]
async fn members_leave_but_a_team_keeps_an_owner() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "leave_owner").await;
    let (priya, priya_token) = signed_in(&pool, "leave_member").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &priya, "member").await;

    let leave = format!("{ORGS}/{organization}/leave");
    let (status, _) = send(&app, "POST", &leave, &priya_token, None).await;
    assert_eq!(status, 204, "a plain member can leave");
    let (status, _) = send(
        &app,
        "GET",
        &format!("{ORGS}/{organization}"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 404);
    let (status, body) = send(&app, "POST", &leave, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("last_owner"))
    );
    let personal = super::personal_organization(&pool, &alex).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("{ORGS}/{personal}/leave"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("personal_organization"))
    );
}

#[tokio::test]
async fn deleting_the_last_owner_promotes_the_longest_standing_admin() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "succ_owner").await;
    let dana = account(&pool, "succ_member").await;
    let chen = account(&pool, "succ_admin").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &dana, "member").await;
    add(&app, &pool, &alex_token, &organization, &chen, "admin").await;

    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&alex)
        .execute(&pool)
        .await
        .unwrap();
    let mut expected = vec![(chen, "owner".to_string()), (dana, "member".to_string())];
    expected.sort();
    assert_eq!(member_rows(&pool, &organization).await, expected);
}

#[tokio::test]
async fn memberships_can_expire() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "exp_owner").await;
    let (priya, priya_token) = signed_in(&pool, "exp_guest").await;
    let organization = team(&pool, &alex).await;
    let ends = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let path = format!("{ORGS}/{organization}/invitations");
    let body = json!({"accountId": priya, "role": "owner", "membershipExpiresAt": ends});
    let (status, answer) = send(&app, "POST", &path, &alex_token, Some(body)).await;
    assert_eq!(
        (status, answer["errorCode"].as_str()),
        (400, Some("invalid_expiry")),
        "owners never expire"
    );
    let body = json!({"accountId": priya, "role": "member", "membershipExpiresAt": ends});
    let (status, answer) = send(&app, "POST", &path, &alex_token, Some(body)).await;
    assert_eq!(status, 201, "{answer}");
    let id = answer["invitation"]["invitationId"].as_str().unwrap();
    let (status, answer) = send(
        &app,
        "POST",
        &format!("{MINE}/{id}/accept"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(answer["organization"]["membershipExpiresAt"].is_string());

    query(
        "UPDATE cloud_organization_members SET expires_at = now() - interval '1 minute' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization)
    .bind(&priya)
    .execute(&pool)
    .await
    .unwrap();
    let (_, answer) = send(&app, "GET", ORGS, &priya_token, None).await;
    assert_eq!(
        answer["organizations"].as_array().unwrap().len(),
        1,
        "an expired membership is not listed: {answer}"
    );
    assert!(
        super::super::selection::expire_memberships(&pool)
            .await
            .unwrap()
            >= 1
    );
    assert_eq!(member_rows(&pool, &organization).await.len(), 1);
}
