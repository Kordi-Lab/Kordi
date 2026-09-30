use super::*;
use sha2::{Digest, Sha256};

fn put_part(uri: &str, token: &str, bytes: Vec<u8>) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(bytes))
        .unwrap()
}

#[tokio::test]
async fn multipart_attachment_resumes_and_completes_without_public_object_storage() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "multipart-owner", "Owner").await;
    let stranger = signup(&router, "multipart-stranger", "Stranger").await;
    let chunk_size = 8 * 1024 * 1024;
    let mut bytes = vec![7_u8; chunk_size];
    bytes.extend_from_slice(b"end");

    let initiated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({
                "sizeBytes": bytes.len(),
                "contentType": "application/zip",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(initiated.status(), StatusCode::OK);
    let initiated = read_json(initiated).await;
    let attachment_id = initiated["attachmentId"].as_str().unwrap();
    assert_eq!(initiated["chunkSizeBytes"], chunk_size);

    let hidden = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &stranger.token,
        ))
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    let first = router
        .clone()
        .oneshot(put_part(
            &format!("/v1/cloud/attachments/{attachment_id}/parts/1"),
            &owner.token,
            bytes[..chunk_size].to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let duplicate = router
        .clone()
        .oneshot(put_part(
            &format!("/v1/cloud/attachments/{attachment_id}/parts/1"),
            &owner.token,
            bytes[..chunk_size].to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::OK);

    let status = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let status = read_json(status).await;
    assert_eq!(status["uploadedBytes"], chunk_size);
    assert_eq!(status["uploadedParts"].as_array().unwrap().len(), 1);

    let incomplete = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
            json!({ "sha256Hex": "a".repeat(64) }),
        ))
        .await
        .unwrap();
    assert_eq!(incomplete.status(), StatusCode::CONFLICT);

    let last = router
        .clone()
        .oneshot(put_part(
            &format!("/v1/cloud/attachments/{attachment_id}/parts/2"),
            &owner.token,
            bytes[chunk_size..].to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(last.status(), StatusCode::OK);

    let digest = hex::encode(Sha256::digest(&bytes));
    let complete = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
            json!({ "sha256Hex": digest }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let complete = read_json(complete).await;
    assert_eq!(complete["sizeBytes"], bytes.len());

    let content = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(content.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(content.into_body(), bytes.len()).await.unwrap(),
        bytes
    );
}

#[tokio::test]
async fn cancelling_multipart_attachment_removes_its_state() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "multipart-cancel", "Owner").await;
    let oversized = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({ "sizeBytes": 2_i64 * 1024 * 1024 * 1024 + 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let initiated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({ "sizeBytes": 4, "contentType": "application/zip" }),
        ))
        .await
        .unwrap();
    let attachment_id = read_json(initiated).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();

    let cancelled = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
    let status = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::NOT_FOUND);
}

const PNG_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const PNG_PREVIEW: &str = "data:image/png;base64,iVBORw0KGgo=";

fn put_bytes(uri: &str, token: &str, content_type: Option<&str>, bytes: &[u8]) -> Request<Body> {
    let mut request = Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    if let Some(content_type) = content_type {
        request = request.header("content-type", content_type);
    }
    request.body(Body::from(bytes.to_vec())).unwrap()
}

async fn initiate_attachment(router: &axum::Router, token: &str) -> Value {
    let initiated = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/attachments/initiate", token))
        .await
        .unwrap();
    assert_eq!(initiated.status(), StatusCode::OK);
    read_json(initiated).await
}

async fn proxy_upload(
    router: &axum::Router,
    token: &str,
    content_type: Option<&str>,
    bytes: &[u8],
) -> String {
    let attachment_id = initiate_attachment(router, token).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let uploaded = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{attachment_id}/upload"),
            token,
            content_type,
            bytes,
        ))
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::OK);
    attachment_id
}

async fn content_response(
    router: &axum::Router,
    token: &str,
    attachment_id: &str,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            token,
        ))
        .await
        .unwrap()
}

fn header<'a>(response: &'a axum::response::Response, name: &str) -> Option<&'a str> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

#[tokio::test]
async fn attachment_bytes_are_served_as_inert_downloads_unless_media() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "attachment-types", "Owner").await;

    for (declared, bytes) in [
        (
            Some("text/html"),
            b"<html><script>1</script></html>".as_slice(),
        ),
        (
            Some("image/svg+xml"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".as_slice(),
        ),
        (Some("application/pdf"), b"%PDF-1.7".as_slice()),
        (None, b"<html></html>".as_slice()),
    ] {
        let attachment_id = proxy_upload(&router, &owner.token, declared, bytes).await;
        let content = content_response(&router, &owner.token, &attachment_id).await;
        assert_eq!(content.status(), StatusCode::OK, "{declared:?}");
        assert_eq!(
            header(&content, "content-type"),
            Some("application/octet-stream"),
            "{declared:?}"
        );
        assert_eq!(header(&content, "content-disposition"), Some("attachment"));
        assert_eq!(header(&content, "x-content-type-options"), Some("nosniff"));
        assert_eq!(
            header(&content, "content-security-policy"),
            Some("default-src 'none'; sandbox")
        );
        assert_eq!(
            to_bytes(content.into_body(), 1024).await.unwrap(),
            bytes,
            "bytes stay intact"
        );
    }

    let image_id = proxy_upload(&router, &owner.token, Some("image/png"), PNG_BYTES).await;
    let image = content_response(&router, &owner.token, &image_id).await;
    assert_eq!(header(&image, "content-type"), Some("image/png"));
    assert_eq!(header(&image, "content-disposition"), None);
    assert_eq!(header(&image, "x-content-type-options"), Some("nosniff"));

    let audio_id = proxy_upload(&router, &owner.token, Some("audio/mpeg"), b"ID3").await;
    let audio = content_response(&router, &owner.token, &audio_id).await;
    assert_eq!(header(&audio, "content-type"), Some("audio/mpeg"));
    assert_eq!(header(&audio, "content-disposition"), None);

    let html_id = proxy_upload(&router, &owner.token, Some("text/html"), b"<p>").await;
    let download = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{html_id}/download-url"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    let download_url = read_json(download).await["downloadUrl"]
        .as_str()
        .unwrap()
        .to_string();
    let download_url = url::Url::parse(&download_url).unwrap();
    let query = download_url
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(query["response-content-type"], "application/octet-stream");
    assert_eq!(query["response-content-disposition"], "attachment");
}

#[tokio::test]
async fn finalized_attachment_bytes_cannot_be_replaced() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "attachment-immutable", "Owner").await;
    let attachment_id = proxy_upload(&router, &owner.token, Some("image/png"), PNG_BYTES).await;

    let replaced = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{attachment_id}/upload"),
            &owner.token,
            Some("text/html"),
            b"<html>replacement</html>",
        ))
        .await
        .unwrap();
    assert_eq!(replaced.status(), StatusCode::CONFLICT);
    assert_eq!(
        read_json(replaced).await["errorCode"],
        "attachment_immutable"
    );
    let refinalized = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/finalize"),
            &owner.token,
            json!({ "sizeBytes": 3, "contentType": "text/html" }),
        ))
        .await
        .unwrap();
    assert_eq!(refinalized.status(), StatusCode::CONFLICT);
    let content = content_response(&router, &owner.token, &attachment_id).await;
    assert_eq!(header(&content, "content-type"), Some("image/png"));
    assert_eq!(
        to_bytes(content.into_body(), 1024).await.unwrap(),
        PNG_BYTES
    );

    // Multipart attachments accept bytes only through their part routes.
    let multipart = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({ "sizeBytes": 3, "contentType": "application/zip" }),
        ))
        .await
        .unwrap();
    let multipart_id = read_json(multipart).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let proxied = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{multipart_id}/upload"),
            &owner.token,
            None,
            b"abc",
        ))
        .await
        .unwrap();
    assert_eq!(proxied.status(), StatusCode::CONFLICT);
    let cancelled = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/attachments/{multipart_id}/multipart"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn direct_upload_finalize_verifies_the_stored_object() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "attachment-finalize", "Owner").await;
    let stranger = signup(&router, "attachment-finalize-stranger", "Stranger").await;
    let initiated = initiate_attachment(&router, &owner.token).await;
    let attachment_id = initiated["attachmentId"].as_str().unwrap().to_string();
    let finalize_uri = format!("/v1/cloud/attachments/{attachment_id}/finalize");

    let missing = router
        .clone()
        .oneshot(post_json_with_token(
            &finalize_uri,
            &owner.token,
            json!({ "sizeBytes": 5 }),
        ))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::CONFLICT);
    assert_eq!(
        read_json(missing).await["errorCode"],
        "attachment_not_uploaded"
    );

    let put = reqwest::Client::new()
        .put(initiated["uploadUrl"].as_str().unwrap())
        .body(b"hello".to_vec())
        .send()
        .await
        .unwrap();
    assert!(put.status().is_success());

    let wrong_size = router
        .clone()
        .oneshot(post_json_with_token(
            &finalize_uri,
            &owner.token,
            json!({ "sizeBytes": 50 }),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_size.status(), StatusCode::BAD_REQUEST);
    let hidden = router
        .clone()
        .oneshot(post_json_with_token(
            &finalize_uri,
            &stranger.token,
            json!({ "sizeBytes": 5 }),
        ))
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    let metadata = json!({ "sizeBytes": 5, "contentType": "text/plain", "sha256Hex": null });
    let finalized = router
        .clone()
        .oneshot(post_json_with_token(
            &finalize_uri,
            &owner.token,
            metadata.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(finalized.status(), StatusCode::OK);
    let retried = router
        .clone()
        .oneshot(post_json_with_token(&finalize_uri, &owner.token, metadata))
        .await
        .unwrap();
    assert_eq!(retried.status(), StatusCode::OK);
    let changed = router
        .clone()
        .oneshot(post_json_with_token(
            &finalize_uri,
            &owner.token,
            json!({ "sizeBytes": 5, "contentType": "text/html" }),
        ))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::CONFLICT);
    let replaced = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{attachment_id}/upload"),
            &owner.token,
            None,
            b"other",
        ))
        .await
        .unwrap();
    assert_eq!(replaced.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn only_the_attachment_owner_sets_its_shared_preview() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "attachment-preview-owner", "Owner").await;
    let member = signup(&router, "attachment-preview-member", "Member").await;
    let stranger = signup(&router, "attachment-preview-stranger", "Stranger").await;
    accept_contacts(&router, &owner, &member).await;
    let attachment_id = proxy_upload(&router, &owner.token, Some("image/png"), PNG_BYTES).await;
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &format!(
            "session:direct-person:{}",
            [owner.account_id.as_str(), member.account_id.as_str()]
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(":")
        ),
        ConversationKind::Direct,
        vec![member.account_id.clone()],
    )
    .await;
    chat_store::send_message(
        &pool,
        &owner.account_id,
        conversation,
        SendMessageRequest {
            client_message_id: uuid::Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": "photo" }] }),
            reply_to_message_id: None,
            attachment_ids: vec![attachment_id.clone()],
        },
    )
    .await
    .expect("share attachment");
    let preview_uri = format!("/v1/cloud/attachments/{attachment_id}/preview");
    let preview_content_uri = format!("/v1/cloud/attachments/{attachment_id}/preview-content");

    let member_preview = router
        .clone()
        .oneshot(post_json_with_token(
            &preview_uri,
            &member.token,
            json!({ "previewUrl": PNG_PREVIEW }),
        ))
        .await
        .unwrap();
    assert_eq!(member_preview.status(), StatusCode::OK);
    assert_eq!(read_json(member_preview).await["updatedLinks"], 0);
    let stranger_preview = router
        .clone()
        .oneshot(post_json_with_token(
            &preview_uri,
            &stranger.token,
            json!({ "previewUrl": PNG_PREVIEW }),
        ))
        .await
        .unwrap();
    assert_eq!(stranger_preview.status(), StatusCode::NOT_FOUND);
    let absent = router
        .clone()
        .oneshot(get_with_token(&preview_content_uri, &member.token))
        .await
        .unwrap();
    assert_eq!(absent.status(), StatusCode::NOT_FOUND);

    let owner_preview = router
        .clone()
        .oneshot(post_json_with_token(
            &preview_uri,
            &owner.token,
            json!({ "previewUrl": PNG_PREVIEW }),
        ))
        .await
        .unwrap();
    assert_eq!(owner_preview.status(), StatusCode::OK);
    assert_eq!(read_json(owner_preview).await["updatedLinks"], 1);
    let stored = router
        .clone()
        .oneshot(get_with_token(&preview_content_uri, &member.token))
        .await
        .unwrap();
    assert_eq!(stored.status(), StatusCode::OK);
    assert_eq!(header(&stored, "content-type"), Some("image/png"));
    assert_eq!(header(&stored, "x-content-type-options"), Some("nosniff"));
}
