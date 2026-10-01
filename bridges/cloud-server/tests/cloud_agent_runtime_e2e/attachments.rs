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
