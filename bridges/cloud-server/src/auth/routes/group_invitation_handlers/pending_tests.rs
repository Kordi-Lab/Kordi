//! Pending group invitations against a disposable PostgreSQL database at
//! `$DATABASE_URL`. Run with `--ignored`.

use super::*;
use crate::auth::password::PasswordHasherConfig;
use crate::auth::rate_limit::CloudRateLimitConfig;
use crate::auth::routes::web_session_handlers::{
    web_csrf_token, WEB_CSRF_HEADER, WEB_SESSION_COOKIE,
};
use axum::body::Body;
use serde_json::{json, Value};
use tower::ServiceExt;

pub(super) struct Harness {
    app: Router,
    pool: PgPool,
}

pub(super) struct Account {
    id: String,
    pub(super) token: String,
}

pub(super) struct Group {
    group_id: String,
    conversation_id: String,
    pub(super) token: String,
    invitation_id: String,
}

pub(super) async fn harness() -> Harness {
    let url = std::env::var("DATABASE_URL").expect("a disposable database is required");
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        ..CloudRateLimitConfig::production()
    });
    let app =
        crate::auth::routes::routes_with_config(state, PasswordHasherConfig::for_tests(), limiter);
    Harness { app, pool }
}

impl Harness {
    pub(super) async fn account(&self, name: &str) -> Account {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let id = format!("acct_pending_{suffix}");
        let device_id = format!("dev_pending_{suffix}");
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
              avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
             VALUES ($1, $2, $3, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
        )
        .bind(&id)
        .bind(name)
        .bind(format!("{id}@example.test"))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_devices \
             (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
             VALUES ($1, $2, 'Test device', $3, $4, $4)",
        )
        .bind(&device_id)
        .bind(&id)
        .bind(format!("legacy:{suffix}"))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        let session = crate::auth::session::issue_session(&self.pool, &id, &device_id, 30)
            .await
            .unwrap();
        Account {
            id,
            token: session.plaintext_token,
        }
    }

    /// A group of `admin` and `member` with a live invitation link.
    pub(super) async fn group(&self, admin: &Account, member: &Account) -> Group {
        let now = Utc::now().to_rfc3339();
        for (owner, peer) in [(&admin.id, &member.id), (&member.id, &admin.id)] {
            query(
                "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(owner)
            .bind(peer)
            .bind(&now)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        let group_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
        let conversation = crate::chat_sync::store::create_conversation(
            &self.pool,
            &admin.id,
            crate::chat_sync::models::CreateConversationRequest {
                client_operation_id: uuid::Uuid::now_v7(),
                kind: crate::chat_sync::models::ConversationKind::Group,
                shared_title: Some("Reading group".to_string()),
                client_session_id: group_id.clone(),
                member_account_ids: vec![member.id.clone()],
                organization_id: None,
            },
        )
        .await
        .unwrap()
        .value;
        let body =
            json!({ "groupId": group_id, "groupSpaceId": group_id, "groupTitle": "Reading group" });
        let (status, created) = self
            .send(
                "POST",
                "/v1/cloud/invitations/groups",
                Some(&admin.token),
                Some(body.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let (status, _) = self
            .send(
                "POST",
                "/v1/cloud/invitations/groups",
                Some(&member.token),
                Some(body),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "only owners and admins create links"
        );
        let token = created["inviteUrl"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        Group {
            group_id,
            conversation_id: conversation.id.to_string(),
            token: token.to_string(),
            invitation_id: created["invitationId"].as_str().unwrap().to_string(),
        }
    }

    pub(super) async fn request(
        &self,
        request: axum::http::Request<Body>,
    ) -> (StatusCode, HeaderMap, String) {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, headers, String::from_utf8_lossy(&bytes).to_string())
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = axum::http::Request::builder().method(method).uri(uri);
        if let Some(token) = bearer {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => {
                request = request.header("Content-Type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let (status, _, text) = self.request(request.body(body).unwrap()).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn claim(&self, account: &Account, token: &str) -> (StatusCode, Value) {
        let uri = format!("/v1/cloud/invitations/groups/claim/{token}");
        self.send("POST", &uri, Some(&account.token), None).await
    }

    pub(super) async fn pending(&self, account: &Account) -> Vec<Value> {
        let (status, body) = self
            .send(
                "GET",
                "/v1/cloud/invitations/groups/pending",
                Some(&account.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["invitations"].as_array().unwrap().clone()
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn claim_is_idempotent_and_accept_joins_once_for_the_owner_only() {
    let h = harness().await;
    let (admin, member) = (h.account("Maya Chen").await, h.account("Ethan").await);
    let (friend, stranger) = (h.account("Ana").await, h.account("Other").await);
    let group = h.group(&admin, &member).await;

    let (status, first) = h.claim(&friend, &group.token).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let pending = &first["pending"];
    assert_eq!(pending["invitationId"], group.invitation_id.as_str());
    assert_eq!(pending["groupName"], "Reading group");
    assert_eq!(pending["inviterName"], "Maya Chen");
    assert_eq!(pending["memberCount"], 2);
    assert!(pending["expiresAt"].as_str().is_some());
    assert_eq!(
        first["deepLink"],
        group_invite_deep_link(&group.token).as_str()
    );
    let (status, second) = h.claim(&friend, &group.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["pending"]["id"], pending["id"]);
    let listed = h.pending(&friend).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0], *pending);
    assert!(h.pending(&stranger).await.is_empty());

    let id = pending["id"].as_str().unwrap();
    let accept = format!("/v1/cloud/invitations/groups/pending/{id}/accept");
    let dismiss = format!("/v1/cloud/invitations/groups/pending/{id}");
    let (status, body) = h.send("POST", &accept, Some(&stranger.token), None).await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::NOT_FOUND, json!("invitation_unavailable"))
    );
    let (status, _) = h
        .send("DELETE", &dismiss, Some(&stranger.token), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, joined) = h.send("POST", &accept, Some(&friend.token), None).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["conversationId"], group.conversation_id.as_str());
    assert_eq!(joined["status"], "joined");
    assert_eq!(joined["groupId"], group.group_id.as_str());
    assert!(
        h.pending(&friend).await.is_empty(),
        "a member sees no pending invitation"
    );
    let (status, again) = h.send("POST", &accept, Some(&friend.token), None).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["status"], "already_joined");
    assert_eq!(again["conversationId"], group.conversation_id.as_str());

    let (status, body) = h.claim(&friend, &group.token).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "already_member");
    assert_eq!(body["conversationId"], group.conversation_id.as_str());
    let (status, body) = h.claim(&admin, &group.token).await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::CONFLICT, json!("already_member"))
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_account_holds_at_most_five_live_pending_invitations() {
    let h = harness().await;
    let (admin, member, friend) = (
        h.account("Maya").await,
        h.account("Ethan").await,
        h.account("Ana").await,
    );
    let mut groups = Vec::new();
    for _ in 0..6 {
        groups.push(h.group(&admin, &member).await);
    }
    let mut ids = Vec::new();
    for group in &groups[..5] {
        let (status, body) = h.claim(&friend, &group.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        ids.push(body["pending"]["id"].as_str().unwrap().to_string());
    }
    let (status, body) = h.claim(&friend, &groups[5].token).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["errorCode"], "too_many_pending");
    let (status, _) = h.claim(&friend, &groups[0].token).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "claiming a held invitation again still works"
    );
    assert_eq!(h.pending(&friend).await.len(), 5);

    let dismiss = format!("/v1/cloud/invitations/groups/pending/{}", ids[0]);
    let (status, _) = h.send("DELETE", &dismiss, Some(&friend.token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = h.send("DELETE", &dismiss, Some(&friend.token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "dismissing is idempotent");
    let (status, body) = h.claim(&friend, &groups[5].token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let listed = h.pending(&friend).await;
    assert_eq!(listed.len(), 5);
    assert_eq!(listed[0]["id"], body["pending"]["id"], "newest first");
    assert!(listed.iter().all(|item| item["id"] != ids[0].as_str()));
    let accept = format!("/v1/cloud/invitations/groups/pending/{}/accept", ids[0]);
    let (status, _) = h.send("POST", &accept, Some(&friend.token), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a dismissed invitation cannot be accepted"
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn expired_revoked_and_full_invitations_are_unavailable() {
    let h = harness().await;
    let (admin, member, friend) = (
        h.account("Maya").await,
        h.account("Ethan").await,
        h.account("Ana").await,
    );
    let revoked = h.group(&admin, &member).await;
    let expired = h.group(&admin, &member).await;
    let full = h.group(&admin, &member).await;
    for group in [&revoked, &expired] {
        let (status, _) = h.claim(&friend, &group.token).await;
        assert_eq!(status, StatusCode::OK);
    }
    assert_eq!(h.pending(&friend).await.len(), 2);

    let revoke = format!("/v1/cloud/invitations/groups/{}", revoked.invitation_id);
    let (status, _) = h.send("DELETE", &revoke, Some(&admin.token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    query("UPDATE cloud_group_invitations SET expires_at = $1 WHERE invitation_id = $2")
        .bind((Utc::now() - ChronoDuration::minutes(1)).to_rfc3339())
        .bind(&expired.invitation_id)
        .execute(&h.pool)
        .await
        .unwrap();
    assert!(h.pending(&friend).await.is_empty());
    for group in [&revoked, &expired] {
        let (status, body) = h.claim(&friend, &group.token).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["errorCode"], "invitation_unavailable");
    }
    let (status, body) = h.claim(&friend, "kordi_gi_unknown").await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::NOT_FOUND, json!("invitation_unavailable"))
    );

    let conversation = uuid::Uuid::parse_str(&full.conversation_id).unwrap();
    for index in 0..(GROUP_INVITE_MAX_MEMBERS - 2) {
        let filler = h.account(&format!("Filler {index}")).await;
        query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2)")
            .bind(conversation)
            .bind(&filler.id)
            .execute(&h.pool)
            .await
            .unwrap();
    }
    let (status, body) = h.claim(&friend, &full.token).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "group_full");
}

pub(super) fn cookie_request(
    method: &str,
    uri: &str,
    web_token: &str,
) -> axum::http::request::Builder {
    axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("Cookie", format!("{WEB_SESSION_COOKIE}={web_token}"))
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn web_session_claims_need_the_csrf_token_and_the_page_never_claims_on_load() {
    let h = harness().await;
    let (admin, member, friend) = (
        h.account("Maya Chen").await,
        h.account("Ethan").await,
        h.account("Ana Silva").await,
    );
    let group = h.group(&admin, &member).await;
    let origin = crate::distribution::public_origin();
    let csrf = web_csrf_token(&friend.token);
    let api = format!("/v1/cloud/invitations/groups/claim/{}", group.token);
    let page = format!("/g/{}", group.token);

    let (status, _, signed_out) = h
        .request(axum::http::Request::get(&page).body(Body::empty()).unwrap())
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(signed_out.contains("Maya Chen invited you to Reading group"));
    assert!(signed_out.contains("2 members on Kordi"));
    let (status, _, signed_in) = h
        .request(
            cookie_request("GET", &page, &friend.token)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(signed_in.contains(&format!(r#"name="csrf" value="{csrf}""#)));
    assert!(
        h.pending(&friend).await.is_empty(),
        "loading the page claims nothing"
    );

    let (status, _, body) = h
        .request(
            cookie_request("POST", &api, &friend.token)
                .header("Origin", &origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _, body) = h
        .request(
            cookie_request("POST", &api, &friend.token)
                .header("Origin", &origin)
                .header(WEB_CSRF_HEADER, &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = h.pending(&friend).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let dismiss = format!("/v1/cloud/invitations/groups/pending/{id}");
    let (status, _) = h.send("DELETE", &dismiss, Some(&friend.token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let form = |value: &str| format!("csrf={value}");
    let form_post = |origin: Option<&str>, value: &str| {
        let mut request = cookie_request("POST", &page, &friend.token)
            .header("Content-Type", "application/x-www-form-urlencoded");
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        request.body(Body::from(form(value))).unwrap()
    };
    let (status, _, _) = h.request(form_post(Some(&origin), "wrong")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = h.request(form_post(None, &csrf)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = h
        .request(form_post(Some("https://evil.example.test"), &csrf))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        h.pending(&friend).await.is_empty(),
        "refused form posts claim nothing"
    );
    let (status, headers, _) = h.request(form_post(Some(&origin), &csrf)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(
        headers.get("location").unwrap(),
        group_invite_deep_link(&group.token).as_str()
    );
    assert_eq!(
        h.pending(&friend).await[0]["id"],
        id.as_str(),
        "claiming revives the dismissed invitation"
    );

    let (status, _, member_page) = h
        .request(
            cookie_request("GET", &page, &member.token)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(member_page.contains("You&#39;re in Reading group"));
}
