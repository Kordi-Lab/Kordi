//! Webhook and push signatures, replay handling, settings, and the list
//! response's agents and catalog scopes.

use super::http_stub::HttpStub;
use super::service_fixture::{connect_service, service_runtime, stored_events, unique_number};
use super::*;
use crate::connectors::webhooks::{self, verify};
use crate::connectors::ConnectorHooks;

const GITHUB_SECRET: &str = "github-hook-key";
const SLACK_SECRET: &str = "slack-signing-key";

fn post(path: &str, headers: &[(&str, String)], body: &str) -> Request<Body> {
    let mut builder = Request::post(path).header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

fn github_request(delivery: &str, body: &str, key: &str) -> Request<Body> {
    let signature = format!("sha256={}", verify::sign_hex(key, &[body.as_bytes()]));
    post(
        webhooks::GITHUB_PATH,
        &[
            ("x-github-event", "pull_request".into()),
            ("x-github-delivery", delivery.into()),
            ("x-hub-signature-256", signature),
        ],
        body,
    )
}

fn slack_request(body: &str, timestamp: i64, key: &str) -> Request<Body> {
    let ts = timestamp.to_string();
    let signature = format!(
        "v0={}",
        verify::sign_hex(key, &[b"v0:", ts.as_bytes(), b":", body.as_bytes()])
    );
    post(
        webhooks::SLACK_PATH,
        &[
            ("x-slack-request-timestamp", ts),
            ("x-slack-signature", signature),
        ],
        body,
    )
}

#[test]
fn signatures_reject_tampering_and_stale_slack_requests() {
    let body = br#"{"action":"opened"}"#;
    let good = format!("sha256={}", verify::sign_hex(GITHUB_SECRET, &[body]));
    assert!(verify::github_signature_valid(
        GITHUB_SECRET,
        body,
        Some(&good)
    ));
    assert!(!verify::github_signature_valid("other", body, Some(&good)));
    assert!(!verify::github_signature_valid(
        GITHUB_SECRET,
        b"{}",
        Some(&good)
    ));
    assert!(!verify::github_signature_valid(GITHUB_SECRET, body, None));

    let now = Utc::now();
    let ts = now.timestamp().to_string();
    let sig = format!(
        "v0={}",
        verify::sign_hex(SLACK_SECRET, &[b"v0:", ts.as_bytes(), b":", body])
    );
    let check = |ts: &str, sig: &str, body: &[u8]| {
        verify::slack_signature_check(SLACK_SECRET, Some(ts), Some(sig), body, now)
    };
    assert_eq!(check(&ts, &sig, body), Ok(()));
    assert_eq!(
        check(&ts, &sig, b"{}"),
        Err(verify::SlackSignatureError::Invalid)
    );
    let old = (now.timestamp() - 600).to_string();
    let old_sig = format!(
        "v0={}",
        verify::sign_hex(SLACK_SECRET, &[b"v0:", old.as_bytes(), b":", body])
    );
    assert_eq!(
        check(&old, &old_sig, body),
        Err(verify::SlackSignatureError::Stale)
    );

    let claims = json!({ "iss": "https://accounts.google.com", "aud": "https://kordi.test/push",
                         "email": "push@project.iam.gserviceaccount.com", "email_verified": "true",
                         "exp": (now.timestamp() + 300).to_string() });
    let valid = |claims: &Value| {
        verify::google_claims_valid(
            claims,
            "https://kordi.test/push",
            "push@project.iam.gserviceaccount.com",
            now,
        )
    };
    assert!(valid(&claims));
    for (key, value) in [
        ("aud", json!("https://elsewhere.test")),
        ("email", json!("attacker@other.iam.gserviceaccount.com")),
        ("iss", json!("https://evil.test")),
        ("exp", json!((now.timestamp() - 1).to_string())),
        ("email_verified", json!("false")),
    ] {
        let mut changed = claims.clone();
        changed[key] = value;
        assert!(!valid(&changed), "{key}");
    }
}

#[tokio::test]
async fn webhooks_fail_closed_without_configuration() {
    let app = crate::server::router(lazy_state(stub_runtime().0));
    for (path, expected) in [
        (webhooks::GITHUB_PATH, StatusCode::SERVICE_UNAVAILABLE),
        (webhooks::SLACK_PATH, StatusCode::SERVICE_UNAVAILABLE),
        (webhooks::GOOGLE_PATH, StatusCode::FORBIDDEN),
    ] {
        let response = app.clone().oneshot(post(path, &[], "{}")).await.unwrap();
        assert_eq!(response.status(), expected, "{path}");
    }
    let hooks = ConnectorHooks {
        github_webhook_secret: Some(GITHUB_SECRET.into()),
        slack_signing_secret: Some(SLACK_SECRET.into()),
        ..Default::default()
    };
    let app = crate::server::router(lazy_state(stub_runtime().0.with_hooks(hooks)));
    let forged = app
        .clone()
        .oneshot(github_request("d-1", "{}", "wrong-key"))
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
    let stale = app
        .clone()
        .oneshot(slack_request(
            "{}",
            Utc::now().timestamp() - 600,
            SLACK_SECRET,
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::UNAUTHORIZED);
    let challenge = app
        .oneshot(slack_request(
            r#"{"type":"url_verification","challenge":"abc123"}"#,
            Utc::now().timestamp(),
            SLACK_SECRET,
        ))
        .await
        .unwrap();
    assert_eq!(challenge.status(), StatusCode::OK);
    assert_eq!(body_json(challenge).await, json!({ "challenge": "abc123" }));
}

#[tokio::test]
async fn github_webhook_records_once_per_delivery() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let hooks = ConnectorHooks {
        github_webhook_secret: Some(GITHUB_SECRET.into()),
        ..Default::default()
    };
    let runtime = service_runtime(&stub, hooks);
    let user_id = unique_number();
    stub.respond(
        "POST",
        "/token",
        json!({ "access_token": "gh-access", "scope": "read:user,notifications" }),
    );
    stub.respond("GET", "/user", json!({ "id": user_id }));
    let (owner, _) = signed_in_account(&pool, "gh_hook").await;
    let connector_id =
        connect_service(&pool, &runtime, &owner, "github", ConnectorToolGroup::Read).await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ));
    let body = json!({ "action": "review_requested",
        "requested_reviewer": { "id": user_id }, "sender": { "id": 1, "login": "alex" },
        "repository": { "full_name": "kordi/app" },
        "pull_request": { "number": 7, "title": "Fix login", "html_url": "https://github.com/kordi/app/pull/7",
                          "user": { "id": 1 } } })
    .to_string();
    let delivery = format!("delivery-{}", Uuid::new_v4());
    let first = app
        .clone()
        .oneshot(github_request(&delivery, &body, GITHUB_SECRET))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(body_json(first).await["recorded"], 1);
    let replayed = app
        .clone()
        .oneshot(github_request(&delivery, &body, GITHUB_SECRET))
        .await
        .unwrap();
    assert_eq!(replayed.status(), StatusCode::OK);
    assert_eq!(body_json(replayed).await["recorded"], 0);
    let tampered = body.replace("Fix login", "Other");
    let mut request = github_request(&delivery, &body, GITHUB_SECRET);
    *request.body_mut() = Body::from(tampered);
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        stored_events(&pool, &connector_id, "delivery:").await,
        [(
            "pull_request.review_requested".to_string(),
            format!("delivery:{delivery}")
        )]
    );
    let last: (Option<chrono::DateTime<Utc>>,) =
        query_as("SELECT last_event_at FROM cloud_connectors WHERE connector_id = $1")
            .bind(&connector_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(last.0.is_some());
}

#[tokio::test]
async fn slack_settings_choose_channels_and_events_follow_them() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let hooks = ConnectorHooks {
        slack_signing_secret: Some(SLACK_SECRET.into()),
        ..Default::default()
    };
    let runtime = service_runtime(&stub, hooks);
    let team = format!("T{}", unique_number());
    stub.respond(
        "POST",
        "/token",
        json!({ "ok": true, "team": { "id": team },
                "authed_user": { "id": "U1", "access_token": "xoxp-1",
                                 "scope": "channels:read,channels:history,groups:read,groups:history,users:read" } }),
    );
    let (owner, token) = signed_in_account(&pool, "slack_hook").await;
    let connector_id =
        connect_service(&pool, &runtime, &owner, "slack", ConnectorToolGroup::Read).await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ));
    let settings_uri = format!("/v1/cloud/connectors/{connector_id}/settings");
    let invalid = app
        .clone()
        .oneshot(authed(
            "PUT",
            &settings_uri,
            &token,
            Some(json!({ "channels": ["#general"] })),
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let saved = app
        .clone()
        .oneshot(authed(
            "PUT",
            &settings_uri,
            &token,
            Some(json!({ "channels": ["C0CHOSEN"] })),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        body_json(saved).await["connector"]["settings"],
        json!({ "channels": ["C0CHOSEN"] })
    );

    let list = body_json(
        app.clone()
            .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        list["agents"][0]["agentId"],
        store::default_agent_id(&owner)
    );
    assert_eq!(list["agents"][0]["isDefault"], true);
    assert!(list["agents"][0]["name"].is_string());
    assert_eq!(
        list["connectors"][0]["grantedScopeIds"],
        json!(["slack.channels.read"])
    );
    assert!(list["connectors"][0]["lastEventAt"].is_null());
    assert_no_secret_keys("GET /v1/cloud/connectors", list);

    let event = |channel: &str, ts: &str| {
        json!({ "type": "event_callback", "team_id": team, "event_id": format!("Ev{ts}"),
                "authorizations": [{ "team_id": team, "user_id": "U1" }],
                "event": { "type": "message", "channel": channel, "user": "U2", "text": "Ship it?", "ts": ts } })
        .to_string()
    };
    let now = Utc::now().timestamp();
    let chosen = event("C0CHOSEN", "1759800000.000100");
    for expected in [1, 0] {
        let response = app
            .clone()
            .oneshot(slack_request(&chosen, now, SLACK_SECRET))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["recorded"], expected);
    }
    let other = app
        .clone()
        .oneshot(slack_request(
            &event("C0OTHER", "1759800000.000200"),
            now,
            SLACK_SECRET,
        ))
        .await
        .unwrap();
    assert_eq!(body_json(other).await["recorded"], 0);
    let forged = app
        .oneshot(slack_request(&chosen, now, "wrong-key"))
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        stored_events(&pool, &connector_id, "message:").await,
        [(
            "message".to_string(),
            "message:C0CHOSEN:1759800000.000100".to_string()
        )]
    );
}

#[tokio::test]
async fn google_push_requires_a_verified_token() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let hooks = ConnectorHooks {
        google_push_audience: Some("https://kordi.test/push".into()),
        google_push_service_account: Some("push@project.iam.gserviceaccount.com".into()),
        google_tokeninfo_url: stub.url("/tokeninfo"),
        ..Default::default()
    };
    let runtime = service_runtime(&stub, hooks);
    let email = format!("user-{}@example.com", unique_number());
    stub.respond(
        "POST",
        "/token",
        json!({ "access_token": "g-access", "refresh_token": "g-refresh", "expires_in": 3600,
                "scope": "https://www.googleapis.com/auth/gmail.readonly" }),
    );
    stub.respond("GET", "/profile", json!({ "emailAddress": email }));
    let (owner, _) = signed_in_account(&pool, "gmail_push").await;
    let connector_id =
        connect_service(&pool, &runtime, &owner, "gmail", ConnectorToolGroup::Read).await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ));
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD
        .encode(json!({ "emailAddress": email.to_uppercase(), "historyId": 4242 }).to_string());
    let body =
        json!({ "message": { "data": data, "messageId": "m1" }, "subscription": "s" }).to_string();
    let push = |bearer: Option<&str>| {
        let headers = bearer
            .map(|token| vec![("authorization", format!("Bearer {token}"))])
            .unwrap_or_default();
        post(webhooks::GOOGLE_PATH, &headers, &body)
    };
    assert_eq!(
        app.clone().oneshot(push(None)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    stub.respond(
        "GET",
        "/tokeninfo",
        json!({ "iss": "accounts.google.com", "aud": "https://elsewhere.test",
                "email": "push@project.iam.gserviceaccount.com", "email_verified": "true",
                "exp": (Utc::now().timestamp() + 300).to_string() }),
    );
    assert_eq!(
        app.clone()
            .oneshot(push(Some("oidc")))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    stub.respond(
        "GET",
        "/tokeninfo",
        json!({ "iss": "accounts.google.com", "aud": "https://kordi.test/push",
                "email": "push@project.iam.gserviceaccount.com", "email_verified": "true",
                "exp": (Utc::now().timestamp() + 300).to_string() }),
    );
    for expected in [1, 0] {
        let response = app.clone().oneshot(push(Some("oidc"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["recorded"], expected);
    }
    assert_eq!(
        stored_events(&pool, &connector_id, "push:").await,
        [("mailbox.changed".to_string(), "push:4242".to_string())]
    );
}
