//! HTTP reads and writes of files after content removal deleted them.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use kordi_cloud_server::attachments::S3Config;
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::Value;
use tower::util::ServiceExt;

use super::content_removal::Chat;
use super::content_removal_worker::{
    delete_for_everyone, file_state, job_ids, send_files, settle, stored_photo, FakeObjects,
};
use super::*;

const PREVIEW: &str = "data:image/png;base64,iVBORw0KGgo=";

/// A router whose object store is never reached: every request here is
/// answered before the server would contact it.
fn router(pool: &PgPool) -> axum::Router {
    let s3 = S3Config {
        endpoint: url::Url::parse("http://127.0.0.1:9").unwrap(),
        region: "us-east-1".into(),
        bucket: "kordi-test".into(),
        access_key: "test-access".into(),
        secret_key: "test-secret".into(),
    };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()).with_s3(s3));
    router_with_rate_limiter(
        state,
        CloudRateLimiter::memory(CloudRateLimitConfig {
            per_ip_limit: 10_000,
            per_ip_window: Duration::from_secs(60),
            per_email_failure_limit: 5,
            per_email_lockout: Duration::from_secs(900),
            per_email_global_failure_limit: 50,
        }),
    )
}

async fn call(
    router: &axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Signs up through the API and returns (account id, token).
async fn signup(router: &axum::Router, label: &str) -> (String, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/cloud/auth/signup")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "email": format!("removal-{label}-{}@example.test", Uuid::new_v4().simple()),
                        "password": format!("pw-{}", Uuid::new_v4()),
                        "displayName": label,
                        "avatarSeed": label,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    (
        body["account"]["accountId"].as_str().unwrap().to_string(),
        body["session"]["token"].as_str().unwrap().to_string(),
    )
}

struct Http {
    router: axum::Router,
    chat: Chat,
    owner_token: String,
    peer_token: String,
}

async fn http_chat(pool: &PgPool, label: &str) -> Http {
    let router = router(pool);
    let (owner, owner_token) = signup(&router, &format!("{label}-owner")).await;
    let (peer, peer_token) = signup(&router, &format!("{label}-peer")).await;
    connect_accounts(pool, &owner, &peer).await;
    let session_id = direct_person_session_id(&owner, &peer);
    let conversation = store::create_conversation(
        pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: session_id.clone(),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .unwrap();
    Http {
        router,
        chat: Chat {
            owner,
            peer,
            conversation_id: conversation.value.id,
            session_id,
        },
        owner_token,
        peer_token,
    }
}

#[tokio::test]
async fn removed_files_are_not_found_for_anyone() {
    let Some(pool) = try_pool().await else { return };
    let http = http_chat(&pool, "http-purge").await;
    let file = stored_photo(&pool, &http.chat.owner).await;
    let message = send_files(&pool, &http.chat, std::slice::from_ref(&file)).await;
    let reads = |file: &str| {
        [
            ("GET", format!("/v1/cloud/attachments/{file}/content")),
            ("GET", format!("/v1/cloud/attachments/{file}/download-url")),
            (
                "GET",
                format!("/v1/cloud/attachments/{file}/preview-content"),
            ),
            ("POST", format!("/v1/cloud/attachments/{file}/playback")),
        ]
    };
    // Positive control: the member reads the file through the message.
    for (method, uri) in &reads(&file)[1..3] {
        let (status, _) = call(&http.router, method, uri, &http.peer_token, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
    }

    delete_for_everyone(&pool, &http.chat, &message).await;
    let objects = FakeObjects::default();
    settle(&pool, &objects, &job_ids(&pool, message.id).await).await;
    assert_eq!(objects.deleted(), vec![file.clone()]);
    for token in [&http.owner_token, &http.peer_token] {
        for (method, uri) in reads(&file) {
            let (status, _) = call(&http.router, method, &uri, token, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
        }
    }
    let (status, _) = call(
        &http.router,
        "POST",
        "/v1/cloud/expressive-media",
        &http.owner_token,
        Some(json!({"attachmentId": file, "kind": "sticker", "name": "saved.png"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &http.router,
        "POST",
        &format!("/v1/cloud/attachments/{file}/preview"),
        &http.owner_token,
        Some(json!({"previewUrl": PREVIEW})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(file_state(&pool, &file).await, (false, true, true, true));
}

#[tokio::test]
async fn a_saved_sticker_keeps_a_file_until_it_is_removed() {
    let Some(pool) = try_pool().await else { return };
    let http = http_chat(&pool, "http-sticker").await;
    let file = stored_photo(&pool, &http.chat.owner).await;
    let message = send_files(&pool, &http.chat, std::slice::from_ref(&file)).await;
    let (status, saved) = call(
        &http.router,
        "POST",
        "/v1/cloud/expressive-media",
        &http.peer_token,
        Some(json!({"attachmentId": file, "kind": "sticker", "name": "kept.png"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let item_id = saved["item"]["itemId"].as_str().unwrap().to_string();

    delete_for_everyone(&pool, &http.chat, &message).await;
    let objects = FakeObjects::default();
    settle(&pool, &objects, &job_ids(&pool, message.id).await).await;
    assert_eq!(file_state(&pool, &file).await, (true, false, false, false));
    assert!(objects.deleted().is_empty());
    // The person who saved it still has it; the message no longer grants it.
    let (status, _) = call(
        &http.router,
        "GET",
        &format!("/v1/cloud/attachments/{file}/download-url"),
        &http.peer_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(
        &http.router,
        "DELETE",
        &format!("/v1/cloud/expressive-media/{item_id}"),
        &http.peer_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let released: Vec<(Uuid,)> = query_as(
        "SELECT job_id FROM cloud_content_removal_jobs \
         WHERE reason = 'attachment_released' AND $1 = ANY(attachment_ids)",
    )
    .bind(&file)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(released.len(), 1);
    settle(&pool, &objects, &[released[0].0]).await;
    assert_eq!(file_state(&pool, &file).await, (false, true, true, true));
    assert_eq!(objects.deleted(), vec![file]);
}

#[tokio::test]
async fn files_panel_entries_do_not_keep_a_file_and_stay_hidden() {
    let Some(pool) = try_pool().await else { return };
    let http = http_chat(&pool, "http-files-panel").await;
    let file = stored_photo(&pool, &http.chat.owner).await;
    let message = send_files(&pool, &http.chat, std::slice::from_ref(&file)).await;
    let message_id = message.id.to_string();
    let entry = |artifact_id: &str, attachment: Option<&str>| {
        json!({
            "sessionId": http.chat.session_id, "artifactId": artifact_id, "name": "photo.png",
            "path": artifact_id, "kind": "image", "category": "artifact",
            "attachmentId": attachment, "participantAccountIds": [http.chat.peer]
        })
    };
    // An entry created from the message, with no file of its own.
    let from_message = |summary: &str| {
        let mut body = entry("from-message.md", None);
        body["sourceMessageId"] = json!(format!("collaboration-message:{message_id}"));
        body["summary"] = json!(summary);
        body
    };
    let publish = |body: Value| {
        call(
            &http.router,
            "POST",
            "/v1/cloud/session-activity/artifacts",
            &http.owner_token,
            Some(body),
        )
    };
    assert_eq!(
        publish(entry("removed.png", Some(&file))).await.0,
        StatusCode::OK
    );
    assert_eq!(publish(entry("kept.md", None)).await.0, StatusCode::OK);
    assert_eq!(
        publish(from_message("summary of the message")).await.0,
        StatusCode::OK
    );

    delete_for_everyone(&pool, &http.chat, &message).await;
    let objects = FakeObjects::default();
    settle(&pool, &objects, &job_ids(&pool, message.id).await).await;
    assert_eq!(objects.deleted(), vec![file.clone()]);
    for account in [&http.chat.owner, &http.chat.peer] {
        let (archived,): (i64,) = query_as(
            "SELECT count(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 \
             AND event_type = 'artifact.archived' AND payload #>> '{artifact,artifactId}' = 'removed.png'",
        )
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(archived, 1);
    }
    // Publishing the entries again neither lists nor changes them.
    assert_eq!(
        publish(entry("removed.png", Some(&file))).await.0,
        StatusCode::OK
    );
    let (status, republished) = publish(from_message("published again")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(republished["artifact"]["archivedAt"].is_string());
    assert_eq!(republished["artifact"]["summary"], "summary of the message");
    // Positive control: an unrelated entry still takes a new publish.
    let mut kept_again = entry("kept.md", None);
    kept_again["summary"] = json!("still here");
    assert_eq!(
        publish(kept_again).await.1["artifact"]["summary"],
        "still here"
    );
    let (status, activity) = call(
        &http.router,
        "GET",
        &format!(
            "/v1/cloud/session-activity?sessionId={}",
            url::form_urlencoded::byte_serialize(http.chat.session_id.as_bytes())
                .collect::<String>()
        ),
        &http.owner_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let listed: Vec<_> = activity["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|artifact| artifact["artifactId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(listed, vec!["kept.md".to_string()]);
}
