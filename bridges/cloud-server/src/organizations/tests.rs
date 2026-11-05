//! Database tests for organizations, through the public routes. They use the
//! Common ground fixture and its skip rule. Team organizations have no create
//! route yet, so tests insert them directly. Members join by invitation.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

mod configured;
mod eligibility;
mod membership;
mod ownership;
mod selection;
mod spaces;

const ORGS: &str = "/v1/cloud/organizations";

async fn personal_organization(pool: &PgPool, account_id: &str) -> String {
    let (id,): (String,) =
        query_as("SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1")
            .bind(account_id)
            .fetch_one(pool)
            .await
            .unwrap();
    id
}

/// A team organization with `owner` as its owner.
async fn team(pool: &PgPool, owner: &str) -> String {
    let id = format!("org_test_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Example team', 'team', $2)",
    )
    .bind(&id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(&id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn member_ids(body: &Value) -> Vec<(String, String)> {
    body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["accountId"].as_str().unwrap().to_string(),
                m["role"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// A session token for an account made with `account`.
async fn token_for(pool: &PgPool, account_id: &str) -> String {
    let device_id = format!("dev_{account_id}");
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Test device', $3, now()::text, now()::text) \
         ON CONFLICT (device_id) DO NOTHING",
    )
    .bind(&device_id)
    .bind(account_id)
    .bind(format!("legacy:{device_id}"))
    .execute(pool)
    .await
    .unwrap();
    crate::auth::session::issue_session(pool, account_id, &device_id, 30)
        .await
        .unwrap()
        .plaintext_token
}

async fn invite(
    app: &axum::Router,
    token: &str,
    organization: &str,
    account_id: &str,
    role: &str,
) -> (u16, Value) {
    send(
        app,
        "POST",
        &format!("{ORGS}/{organization}/invitations"),
        token,
        Some(json!({"accountId": account_id, "role": role})),
    )
    .await
}

/// Invites `account_id` and, when that succeeds, accepts as the invitee.
/// Returns the invitation answer.
async fn add(
    app: &axum::Router,
    pool: &PgPool,
    token: &str,
    organization: &str,
    account_id: &str,
    role: &str,
) -> (u16, Value) {
    let (status, body) = invite(app, token, organization, account_id, role).await;
    if status == 201 {
        let id = body["invitation"]["invitationId"].as_str().unwrap();
        let invitee = token_for(pool, account_id).await;
        let path = format!("/v1/cloud/organization-invitations/{id}/accept");
        let (accepted, answer) = send(app, "POST", &path, &invitee, None).await;
        assert_eq!(accepted, 200, "{answer}");
    }
    (status, body)
}

async fn set_role(
    app: &axum::Router,
    token: &str,
    organization: &str,
    account_id: &str,
    role: &str,
) -> (u16, Value) {
    send(
        app,
        "PATCH",
        &format!("{ORGS}/{organization}/members/{account_id}"),
        token,
        Some(json!({"role": role})),
    )
    .await
}

async fn remove(
    app: &axum::Router,
    token: &str,
    organization: &str,
    account_id: &str,
) -> (u16, Value) {
    send(
        app,
        "DELETE",
        &format!("{ORGS}/{organization}/members/{account_id}"),
        token,
        None,
    )
    .await
}

#[tokio::test]
async fn a_new_account_has_one_personal_organization_it_owns() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, token) = signed_in(&pool, "org_new").await;

    let (status, body) = send(&app, "GET", ORGS, &token, None).await;
    assert_eq!(status, 200, "{body}");
    let organizations = body["organizations"].as_array().unwrap();
    assert_eq!(organizations.len(), 1, "{body}");
    let personal = &organizations[0];
    assert_eq!(personal["kind"], "personal");
    assert_eq!(personal["role"], "owner");
    assert_eq!(personal["memberCount"], 1);
    let id = personal["organizationId"].as_str().unwrap();
    assert_eq!(id, personal_organization(&pool, &alex).await);

    let (status, body) = send(&app, "GET", &format!("{ORGS}/{id}"), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["organization"]["organizationId"], id);
    let (status, body) = send(&app, "GET", &format!("{ORGS}/{id}/members"), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(member_ids(&body), vec![(alex, "owner".to_string())]);
    assert!(body["nextAfter"].is_null());
}

#[tokio::test]
async fn a_personal_organization_never_gains_members_or_loses_its_owner() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, token) = signed_in(&pool, "org_personal").await;
    let priya = account(&pool, "org_personal_peer").await;
    let personal = personal_organization(&pool, &alex).await;

    let (status, body) = add(&app, &pool, &token, &personal, &priya, "member").await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("personal_organization"))
    );
    let (status, body) = set_role(&app, &token, &personal, &alex, "admin").await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("personal_organization"))
    );
    let (status, body) = remove(&app, &token, &personal, &alex).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("personal_organization"))
    );

    let direct = query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(&personal)
    .bind(&priya)
    .execute(&pool)
    .await;
    assert!(direct.is_err(), "the database refuses it too");
    let (count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_organization_members WHERE organization_id = $1")
            .bind(&personal)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn non_members_cannot_see_or_change_an_organization() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, _alex_token) = signed_in(&pool, "org_hidden_owner").await;
    let (sam, sam_token) = signed_in(&pool, "org_hidden_other").await;
    let organization = team(&pool, &alex).await;
    let personal = personal_organization(&pool, &alex).await;

    for id in [organization.as_str(), personal.as_str(), "org_missing"] {
        for path in [format!("{ORGS}/{id}"), format!("{ORGS}/{id}/members")] {
            let (status, body) = send(&app, "GET", &path, &sam_token, None).await;
            assert_eq!(
                (status, body["errorCode"].as_str()),
                (404, Some("organization_not_found")),
                "{path}"
            );
        }
        let (status, _) = add(&app, &pool, &sam_token, id, &sam, "owner").await;
        assert_eq!(status, 404, "a non-member cannot add itself to {id}");
        let (status, _) = set_role(&app, &sam_token, id, &alex, "member").await;
        assert_eq!(status, 404);
        let (status, _) = remove(&app, &sam_token, id, &alex).await;
        assert_eq!(status, 404);
    }
    let (_, body) = send(&app, "GET", ORGS, &sam_token, None).await;
    assert_eq!(body["organizations"].as_array().unwrap().len(), 1, "{body}");
    let (status, _) = send(&app, "GET", ORGS, "kordi_sess_invalid", None).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn members_cannot_change_members() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "org_member_owner").await;
    let (priya, priya_token) = signed_in(&pool, "org_member_plain").await;
    let sam = account(&pool, "org_member_other").await;
    let organization = team(&pool, &alex).await;
    assert_eq!(
        add(&app, &pool, &alex_token, &organization, &priya, "member")
            .await
            .0,
        201
    );

    let (status, body) = send(
        &app,
        "GET",
        &format!("{ORGS}/{organization}/members"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "a member can read the member list");
    assert_eq!(member_ids(&body).len(), 2);
    let forbidden = Some("organization_forbidden");
    let (status, body) = add(&app, &pool, &priya_token, &organization, &sam, "member").await;
    assert_eq!((status, body["errorCode"].as_str()), (403, forbidden));
    let (status, body) = set_role(&app, &priya_token, &organization, &priya, "admin").await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (403, forbidden),
        "no self-promotion"
    );
    let (status, body) = remove(&app, &priya_token, &organization, &alex).await;
    assert_eq!((status, body["errorCode"].as_str()), (403, forbidden));
}

#[tokio::test]
async fn owners_and_admins_manage_members_within_the_rules() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "org_rules_owner").await;
    let (chen, chen_token) = signed_in(&pool, "org_rules_admin").await;
    let dana = account(&pool, "org_rules_member").await;
    let organization = team(&pool, &alex).await;

    let (status, body) = add(&app, &pool, &alex_token, &organization, &chen, "admin").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["invitation"]["role"], "admin");
    // A member and a missing account get the same answer.
    for id in [chen.as_str(), "acct_missing"] {
        let (status, body) = add(&app, &pool, &alex_token, &organization, id, "member").await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (404, Some("invitee_unavailable"))
        );
    }
    let (status, body) = add(&app, &pool, &alex_token, &organization, &dana, "superuser").await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("invalid_role"))
    );

    // An admin manages non-owners only.
    assert_eq!(
        add(&app, &pool, &chen_token, &organization, &dana, "member")
            .await
            .0,
        201
    );
    let owner_required = Some("organization_owner_required");
    let (status, body) = set_role(&app, &chen_token, &organization, &dana, "owner").await;
    assert_eq!((status, body["errorCode"].as_str()), (403, owner_required));
    let (status, body) = set_role(&app, &chen_token, &organization, &alex, "member").await;
    assert_eq!((status, body["errorCode"].as_str()), (403, owner_required));
    let (status, body) = remove(&app, &chen_token, &organization, &alex).await;
    assert_eq!((status, body["errorCode"].as_str()), (403, owner_required));
    let (status, body) = set_role(&app, &chen_token, &organization, &dana, "admin").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(remove(&app, &chen_token, &organization, &dana).await.0, 204);

    // The last owner stays until another owner exists.
    let last_owner = Some("last_owner");
    let (status, body) = set_role(&app, &alex_token, &organization, &alex, "admin").await;
    assert_eq!((status, body["errorCode"].as_str()), (409, last_owner));
    let (status, body) = remove(&app, &alex_token, &organization, &alex).await;
    assert_eq!((status, body["errorCode"].as_str()), (409, last_owner));
    assert_eq!(
        set_role(&app, &alex_token, &organization, &chen, "owner")
            .await
            .0,
        200
    );
    assert_eq!(remove(&app, &alex_token, &organization, &alex).await.0, 204);

    let (status, body) = send(
        &app,
        "GET",
        &format!("{ORGS}/{organization}/members"),
        &chen_token,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(member_ids(&body), vec![(chen.clone(), "owner".to_string())]);
    let (status, _) = send(
        &app,
        "GET",
        &format!("{ORGS}/{organization}"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 404, "a removed owner no longer sees it");
    let (_, body) = send(&app, "GET", ORGS, &chen_token, None).await;
    let kinds: Vec<_> = body["organizations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["kind"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(kinds, ["personal", "team"], "personal comes first");
}

#[tokio::test]
async fn ids_from_another_organization_are_not_found() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "org_cross_a").await;
    let (chen, chen_token) = signed_in(&pool, "org_cross_c").await;
    let priya = account(&pool, "org_cross_p").await;
    let dana = account(&pool, "org_cross_d").await;
    let first = team(&pool, &alex).await;
    let second = team(&pool, &chen).await;
    assert_eq!(
        add(&app, &pool, &alex_token, &first, &priya, "member")
            .await
            .0,
        201
    );
    assert_eq!(
        add(&app, &pool, &chen_token, &second, &dana, "member")
            .await
            .0,
        201
    );

    // A member of another organization, through an organization Alex owns.
    let not_member = Some("member_not_found");
    let (status, body) = set_role(&app, &alex_token, &first, &dana, "admin").await;
    assert_eq!((status, body["errorCode"].as_str()), (404, not_member));
    let (status, body) = remove(&app, &alex_token, &first, &dana).await;
    assert_eq!((status, body["errorCode"].as_str()), (404, not_member));
    // An organization Alex does not belong to.
    let (status, body) = remove(&app, &alex_token, &second, &dana).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("organization_not_found"))
    );
    let (status, _) = add(&app, &pool, &chen_token, &first, &dana, "member").await;
    assert_eq!(status, 404);

    let (rows,): (i64,) =
        query_as("SELECT count(*) FROM cloud_organization_members WHERE organization_id = ANY($1)")
            .bind(vec![first, second])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 4, "nothing changed");
}

#[tokio::test]
async fn member_lists_page_by_account_id() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "org_page_owner").await;
    let organization = team(&pool, &alex).await;
    let prefix = format!("acct_org_page_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_accounts (account_id, display_name, created_at, updated_at, \
          avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, \
          avatar_updated_at) \
         SELECT $1 || '_' || lpad(n::text, 3, '0'), 'Paged', now()::text, now()::text, \
                'generated', 'lorelei', $1 || n, 'fixture', 1, now()::text \
         FROM generate_series(1, 205) n",
    )
    .bind(&prefix)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         SELECT $1, account_id, 'member' FROM cloud_accounts WHERE starts_with(account_id, $2)",
    )
    .bind(&organization)
    .bind(&prefix)
    .execute(&pool)
    .await
    .unwrap();
    let (total,): (i64,) =
        query_as("SELECT count(*) FROM cloud_organization_members WHERE organization_id = $1")
            .bind(&organization)
            .fetch_one(&pool)
            .await
            .unwrap();

    let mut seen = Vec::new();
    let mut path = format!("{ORGS}/{organization}/members");
    loop {
        let (status, body) = send(&app, "GET", &path, &alex_token, None).await;
        assert_eq!(status, 200, "{body}");
        let page = member_ids(&body);
        assert!(page.len() <= 200);
        seen.extend(page.into_iter().map(|(id, _)| id));
        match body["nextAfter"].as_str() {
            Some(after) => path = format!("{ORGS}/{organization}/members?after={after}"),
            None => break,
        }
    }
    assert_eq!(seen.len() as i64, total);
    let mut sorted = seen.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted, seen, "each member once, in order");
}
