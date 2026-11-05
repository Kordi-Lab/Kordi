//! Organizations from the admission file, the last owner of a team, and
//! invitations whose inviter lost the right to send them.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{add, invite, team, token_for, ORGS};
use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

/// A team defined by the admission file, with `admins` as its admins and no
/// owner, as admission creates it.
async fn configured_team(pool: &PgPool, admins: &[&str]) -> String {
    let id = format!("org_test_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, config_id) \
         VALUES ($1, 'Example configured team', 'team', $1)",
    )
    .bind(&id)
    .execute(pool)
    .await
    .unwrap();
    for admin in admins {
        query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
             VALUES ($1, $2, 'admin')",
        )
        .bind(&id)
        .bind(admin)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn roles(pool: &PgPool, organization: &str) -> Vec<(String, String)> {
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
async fn configured_organizations_take_no_invitations_or_setting_changes() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "cfg_admin").await;
    let (priya, priya_token) = signed_in(&pool, "cfg_member").await;
    let organization = configured_team(&pool, &[&alex]).await;
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(&organization)
    .bind(&priya)
    .execute(&pool)
    .await
    .unwrap();
    let sam = account(&pool, "cfg_outsider").await;
    let configured = Some("configured_organization");

    let (status, body) = invite(&app, &alex_token, &organization, &sam, "member").await;
    assert_eq!((status, body["errorCode"].as_str()), (409, configured));
    let path = format!("{ORGS}/{organization}");
    for change in [
        json!({"name": "Renamed"}),
        json!({"memberOwnedContent": true}),
    ] {
        let (status, body) = send(&app, "PATCH", &path, &alex_token, Some(change)).await;
        assert_eq!((status, body["errorCode"].as_str()), (409, configured));
    }
    // An invitation sent before the file defined the organization cannot be
    // accepted afterwards.
    let invitation = format!("oinv_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organization_invitations (invitation_id, organization_id, \
          invitee_account_id, invited_by_account_id, role, expires_at) \
         VALUES ($1, $2, $3, $4, 'member', now() + interval '1 day')",
    )
    .bind(&invitation)
    .bind(&organization)
    .bind(&sam)
    .bind(&alex)
    .execute(&pool)
    .await
    .unwrap();
    let sam_token = token_for(&pool, &sam).await;
    let accept = format!("/v1/cloud/organization-invitations/{invitation}/accept");
    let (status, body) = send(&app, "POST", &accept, &sam_token, None).await;
    assert_eq!((status, body["errorCode"].as_str()), (409, configured));

    // Content does not move in or out of it through the transfer route.
    let alex_home = super::personal_organization(&pool, &alex).await;
    let agent_id = format!("agent_cfg_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_definitions (agent_id, owner_account_id, name, role, \
          system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
          avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, 'Helper', 'helper', 'Help.', now()::text, now()::text, 'generated', \
                 'thumbs', $1, 'fixture', 1, now()::text)",
    )
    .bind(&agent_id)
    .bind(&alex)
    .execute(&pool)
    .await
    .unwrap();
    let transfer = format!("{ORGS}/{alex_home}/transfers");
    let body = json!({"kind": "agent", "id": agent_id, "targetOrganizationId": organization});
    let (status, answer) = send(&app, "POST", &transfer, &alex_token, Some(body)).await;
    assert_eq!((status, answer["errorCode"].as_str()), (409, configured));

    // Leaving goes through admission, which keeps the configured admin.
    let leave = format!("{ORGS}/{organization}/leave");
    assert_eq!(send(&app, "POST", &leave, &priya_token, None).await.0, 204);
    assert_eq!(
        roles(&pool, &organization).await,
        [(alex, "admin".to_string())]
    );
}

#[tokio::test]
async fn only_a_lasting_admin_succeeds_the_last_owner_and_configured_teams_get_none() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "succ2_owner").await;
    let chen = account(&pool, "succ2_guest_admin").await;
    let dana = account(&pool, "succ2_member").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &dana, "member").await;
    let ends = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let path = format!("{ORGS}/{organization}/invitations");
    let body = json!({"accountId": chen, "role": "admin", "membershipExpiresAt": ends});
    let (status, answer) = send(&app, "POST", &path, &alex_token, Some(body)).await;
    assert_eq!(status, 201, "{answer}");
    let id = answer["invitation"]["invitationId"].as_str().unwrap();
    let chen_token = token_for(&pool, &chen).await;
    let accept = format!("/v1/cloud/organization-invitations/{id}/accept");
    assert_eq!(send(&app, "POST", &accept, &chen_token, None).await.0, 200);

    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&alex)
        .execute(&pool)
        .await
        .unwrap();
    let left = roles(&pool, &organization).await;
    assert!(
        left.iter().all(|(_, role)| role != "owner"),
        "neither a member nor an expiring admin becomes owner: {left:?}"
    );

    // A configured team has admins only and never gains an owner.
    let (admin, _) = signed_in(&pool, "succ2_cfg_admin").await;
    let other = account(&pool, "succ2_cfg_other").await;
    let configured = configured_team(&pool, &[&admin, &other]).await;
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        roles(&pool, &configured).await,
        [(other, "admin".to_string())]
    );
}

#[tokio::test]
async fn an_owner_leaving_while_another_is_deleted_still_leaves_an_owner() {
    let Some(pool) = pool().await else { return };
    let (alex, _) = signed_in(&pool, "race_owner_a").await;
    let bea = account(&pool, "race_owner_b").await;
    let chen = account(&pool, "race_admin").await;
    let organization = team(&pool, &alex).await;
    for (member, role) in [(&bea, "owner"), (&chen, "admin")] {
        query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
             VALUES ($1, $2, $3)",
        )
        .bind(&organization)
        .bind(member)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Bea leaves as the leave route does: lock, count two owners, delete.
    let mut leaving = pool.begin().await.unwrap();
    query("SELECT 1 FROM cloud_organizations WHERE organization_id = $1 FOR UPDATE")
        .bind(&organization)
        .execute(&mut *leaving)
        .await
        .unwrap();
    query("DELETE FROM cloud_organization_members WHERE organization_id = $1 AND account_id = $2")
        .bind(&organization)
        .bind(&bea)
        .execute(&mut *leaving)
        .await
        .unwrap();
    // Meanwhile Alex's account is deleted; its trigger waits for the lock.
    let deleting = {
        let pool = pool.clone();
        let alex = alex.clone();
        tokio::spawn(async move {
            query("DELETE FROM cloud_accounts WHERE account_id = $1")
                .bind(&alex)
                .execute(&pool)
                .await
                .unwrap();
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    leaving.commit().await.unwrap();
    deleting.await.unwrap();

    assert_eq!(
        roles(&pool, &organization).await,
        [(chen, "owner".to_string())]
    );
}

#[tokio::test]
async fn an_invitation_lapses_when_its_inviter_loses_the_right_to_send_it() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "inviter_owner").await;
    let (chen, chen_token) = signed_in(&pool, "inviter_admin").await;
    let dana = account(&pool, "inviter_invitee").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &chen, "admin").await;

    let (status, body) = invite(&app, &chen_token, &organization, &dana, "member").await;
    assert_eq!(status, 201, "{body}");
    let id = body["invitation"]["invitationId"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("{ORGS}/{organization}/members/{chen}");
    let (status, _) = send(
        &app,
        "PATCH",
        &path,
        &alex_token,
        Some(json!({"role": "member"})),
    )
    .await;
    assert_eq!(status, 200);

    let dana_token = token_for(&pool, &dana).await;
    let accept = format!("/v1/cloud/organization-invitations/{id}/accept");
    let (status, body) = send(&app, "POST", &accept, &dana_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("invitation_not_found"))
    );
    assert_eq!(roles(&pool, &organization).await.len(), 2);
}
