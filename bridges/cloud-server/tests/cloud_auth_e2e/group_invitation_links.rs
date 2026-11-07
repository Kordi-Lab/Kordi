//! One live invitation link per group: every admin gets the same link, a
//! reset replaces it, and older random links keep working until they expire.

use super::*;
use sha2::{Digest, Sha256};

/// A synthetic secret for deriving group links in tests.
const TEST_LINK_SECRET: &str = "group-invite-link-test-secret-0123456789";

pub(super) fn use_link_secret() {
    std::env::set_var("KORDI_DOCUMENT_SHARE_SECRET", TEST_LINK_SECRET);
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

struct Group {
    id: String,
    conversation_id: uuid::Uuid,
}

async fn create_group(
    pool: &sqlx_postgres::PgPool,
    owner_id: &str,
    members: &[&str],
    admins: &[&str],
) -> Group {
    let id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    for member in members {
        for (account, peer) in [(owner_id, *member), (*member, owner_id)] {
            sqlx_core::query::query(
                "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(account)
            .bind(peer)
            .bind(&now)
            .execute(pool)
            .await
            .unwrap();
        }
    }
    let conversation = kordi_cloud_server::chat_sync::store::create_conversation(
        pool,
        owner_id,
        kordi_cloud_server::chat_sync::models::CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: kordi_cloud_server::chat_sync::models::ConversationKind::Group,
            shared_title: Some("Link Team".to_string()),
            client_session_id: id.clone(),
            member_account_ids: members.iter().map(|member| member.to_string()).collect(),
            organization_id: None,
        },
    )
    .await
    .unwrap()
    .value;
    for admin in admins {
        set_role(pool, conversation.id, admin, "admin").await;
    }
    Group {
        id,
        conversation_id: conversation.id,
    }
}

async fn set_role(
    pool: &sqlx_postgres::PgPool,
    conversation_id: uuid::Uuid,
    account_id: &str,
    role: &str,
) {
    sqlx_core::query::query(
        "UPDATE cloud_chat_conversation_members SET role = $1
         WHERE conversation_id = $2 AND account_id = $3",
    )
    .bind(role)
    .bind(conversation_id)
    .bind(account_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn ask_link(
    router: &axum::Router,
    token: &str,
    group_id: &str,
    reset: bool,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/invitations/groups",
            token,
            json!({
                "groupId": group_id,
                "groupSpaceId": group_id,
                "groupTitle": "Link Team",
                "reset": reset,
            }),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn current_links(router: &axum::Router, token: &str, group_id: &str) -> serde_json::Value {
    let response = router
        .clone()
        .oneshot(get_with_token(
            &format!(
                "/v1/cloud/invitations/groups/active/{}",
                group_id.replace(':', "%3A")
            ),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await["invitations"].clone()
}

async fn resolve_status(router: &axum::Router, url: &str) -> StatusCode {
    let invite_token = url.rsplit('/').next().unwrap();
    router
        .clone()
        .oneshot(get(&format!(
            "/v1/cloud/invitations/groups/resolve/{invite_token}"
        )))
        .await
        .unwrap()
        .status()
}

fn days_from_now(expires_at: &serde_json::Value) -> i64 {
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at.as_str().unwrap()).unwrap();
    (expires_at.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days()
}

#[tokio::test]
async fn every_admin_gets_the_same_group_link_until_one_resets_it() {
    let Some(pool) = try_pool().await else { return };
    use_link_secret();
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "group-link-owner").await;
    let (admin_token, admin_id) = signup_account(&router, "group-link-admin").await;
    let (member_token, member_id) = signup_account(&router, "group-link-member").await;
    let (recipient_token, _) = signup_account(&router, "group-link-recipient").await;
    let group = create_group(&pool, &owner_id, &[&admin_id, &member_id], &[&admin_id]).await;

    // A member who is not an admin can neither see, make nor reset the link.
    assert_eq!(
        current_links(&router, &member_token, &group.id).await,
        json!([])
    );
    assert_eq!(
        ask_link(&router, &member_token, &group.id, false).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        ask_link(&router, &member_token, &group.id, true).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        current_links(&router, &owner_token, &group.id).await,
        json!([])
    );

    let (status, first) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(status, StatusCode::OK, "got body {first}");
    let (_, again) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(again["inviteUrl"], first["inviteUrl"]);
    assert_eq!(again["invitationId"], first["invitationId"]);
    let (_, from_admin) = ask_link(&router, &admin_token, &group.id, false).await;
    assert_eq!(from_admin["inviteUrl"], first["inviteUrl"]);
    let listed = current_links(&router, &admin_token, &group.id).await;
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert_eq!(listed[0]["inviteUrl"], first["inviteUrl"]);
    assert_eq!(listed[0]["invitationId"], first["invitationId"]);
    let live: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_group_invitations
         WHERE group_space_id = $1 AND revoked_at IS NULL",
    )
    .bind(&group.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live.0, 1, "repeat requests never mint more links");

    // A link an admin asks for again does not run out under its group.
    sqlx_core::query::query(
        "UPDATE cloud_group_invitations SET expires_at = $1 WHERE invitation_id = $2",
    )
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .bind(first["invitationId"].as_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let (_, renewed) = ask_link(&router, &admin_token, &group.id, false).await;
    assert_eq!(renewed["inviteUrl"], first["inviteUrl"]);
    assert!(days_from_now(&renewed["expiresAt"]) >= 29);

    let (status, reset) = ask_link(&router, &admin_token, &group.id, true).await;
    assert_eq!(status, StatusCode::OK, "got body {reset}");
    assert_ne!(reset["inviteUrl"], first["inviteUrl"]);
    assert_eq!(
        resolve_status(&router, first["inviteUrl"].as_str().unwrap()).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        resolve_status(&router, reset["inviteUrl"].as_str().unwrap()).await,
        StatusCode::OK
    );
    let (_, after_reset) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(after_reset["inviteUrl"], reset["inviteUrl"]);

    let reset_token = reset["inviteUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let old_token = first["inviteUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let refused = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{old_token}"),
            &recipient_token,
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
    let joined = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{reset_token}"),
            &recipient_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_json(joined).await["status"], "joined");
}

#[tokio::test]
async fn a_link_whose_creator_is_no_longer_admin_is_replaced() {
    let Some(pool) = try_pool().await else { return };
    use_link_secret();
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "group-link-demote-owner").await;
    let (admin_token, admin_id) = signup_account(&router, "group-link-demote-admin").await;
    let group = create_group(&pool, &owner_id, &[&admin_id], &[&admin_id]).await;

    let (_, first) = ask_link(&router, &admin_token, &group.id, false).await;
    set_role(&pool, group.conversation_id, &admin_id, "member").await;
    let (status, replacement) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(status, StatusCode::OK, "got body {replacement}");
    assert_ne!(replacement["inviteUrl"], first["inviteUrl"]);
    assert_eq!(
        resolve_status(&router, replacement["inviteUrl"].as_str().unwrap()).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn an_older_random_link_keeps_working_and_is_replaced_once() {
    let Some(pool) = try_pool().await else { return };
    use_link_secret();
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "group-link-legacy-owner").await;
    let group = create_group(&pool, &owner_id, &[], &[]).await;

    // Turn a fresh link into one made the old way: a random token whose hash
    // is all the database keeps.
    let (_, made) = ask_link(&router, &owner_token, &group.id, false).await;
    let legacy_token = format!("kordi_gi_legacy{}", uuid::Uuid::new_v4().simple());
    sqlx_core::query::query(
        "UPDATE cloud_group_invitations SET token_hash = $1 WHERE invitation_id = $2",
    )
    .bind(hex::encode(Sha256::digest(legacy_token.as_bytes())))
    .bind(made["invitationId"].as_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let legacy_url = format!("https://kordi.test/g/{legacy_token}");
    assert_eq!(
        current_links(&router, &owner_token, &group.id).await,
        json!([])
    );

    let (status, replacement) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(status, StatusCode::OK, "got body {replacement}");
    assert_ne!(replacement["invitationId"], made["invitationId"]);
    let (_, again) = ask_link(&router, &owner_token, &group.id, false).await;
    assert_eq!(again["inviteUrl"], replacement["inviteUrl"]);
    assert_eq!(resolve_status(&router, &legacy_url).await, StatusCode::OK);
}
