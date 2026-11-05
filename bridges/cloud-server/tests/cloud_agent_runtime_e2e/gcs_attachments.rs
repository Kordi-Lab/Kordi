//! Attachment routes on the Google Cloud Storage backend: transfers go
//! through the server, and URL endpoints return server routes, not links.

use super::*;
use crate::gcs_mock::MockGcs;
use sha2::Digest;

fn gcs_router(
    pool: sqlx_postgres::PgPool,
    store: kordi_cloud_server::object_storage::ObjectStore,
) -> axum::Router {
    test_router(Arc::new(
        signup_email_fixture::state(pool).with_object_store(store),
    ))
}

fn put_bytes(uri: &str, token: &str, content_type: &str, bytes: Vec<u8>) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", content_type)
        .body(Body::from(bytes))
        .unwrap()
}

#[tokio::test]
async fn gcs_attachments_upload_and_stream_ranges_through_the_server() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let mock = MockGcs::spawn("example-attachments").await;
    let router = gcs_router(pool, mock.store().await);
    let owner = signup(&router, "gcs-owner", "Owner").await;

    let initiated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/initiate",
            &owner.token,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(initiated.status(), StatusCode::OK);
    let initiated = read_json(initiated).await;
    let attachment_id = initiated["attachmentId"].as_str().unwrap().to_string();
    assert_eq!(
        initiated["uploadUrl"],
        format!("/v1/cloud/attachments/{attachment_id}/upload")
    );

    let uploaded = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{attachment_id}/upload"),
            &owner.token,
            "text/plain",
            b"hello from gcs".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::OK);
    let object_key = initiated["objectKey"].as_str().unwrap();
    assert_eq!(
        mock.object(object_key).await.unwrap().bytes,
        b"hello from gcs"
    );

    let link = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/download-url"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(
        read_json(link).await["downloadUrl"],
        format!("/v1/cloud/attachments/{attachment_id}/content")
    );

    let ranged = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/cloud/attachments/{attachment_id}/content"))
                .header("authorization", format!("Bearer {}", owner.token))
                .header("range", "bytes=6-9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.headers()["content-range"], "bytes 6-9/14");
    assert_eq!(
        to_bytes(ranged.into_body(), 64).await.unwrap().as_ref(),
        b"from"
    );
}

#[tokio::test]
async fn gcs_multipart_attachment_completes_and_cancels() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let mock = MockGcs::spawn("example-attachments").await;
    let router = gcs_router(pool, mock.store().await);
    let owner = signup(&router, "gcs-multipart", "Owner").await;
    let chunk_size = 8 * 1024 * 1024;
    let mut bytes = vec![3_u8; chunk_size];
    bytes.extend_from_slice(b"tail");

    let initiated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({ "sizeBytes": bytes.len(), "contentType": "application/zip" }),
        ))
        .await
        .unwrap();
    assert_eq!(initiated.status(), StatusCode::OK);
    let initiated = read_json(initiated).await;
    let attachment_id = initiated["attachmentId"].as_str().unwrap().to_string();
    let object_key = initiated["objectKey"].as_str().unwrap().to_string();
    for (part, range) in [(2, chunk_size..bytes.len()), (1, 0..chunk_size)] {
        let stored = router
            .clone()
            .oneshot(put_bytes(
                &format!("/v1/cloud/attachments/{attachment_id}/parts/{part}"),
                &owner.token,
                "application/octet-stream",
                bytes[range].to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(stored.status(), StatusCode::OK);
    }
    let complete = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/multipart"),
            &owner.token,
            json!({ "sha256Hex": hex::encode(sha2::Sha256::digest(&bytes)) }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let stored = mock.object(&object_key).await.unwrap();
    assert_eq!(stored.bytes, bytes);
    assert_eq!(stored.content_type, "application/zip");
    assert_eq!(mock.names().await, vec![object_key]);

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/multipart/initiate",
            &owner.token,
            json!({ "sizeBytes": 4 }),
        ))
        .await
        .unwrap();
    let second_id = read_json(second).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let part = router
        .clone()
        .oneshot(put_bytes(
            &format!("/v1/cloud/attachments/{second_id}/parts/1"),
            &owner.token,
            "application/octet-stream",
            b"abcd".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(part.status(), StatusCode::OK);
    let cancelled = router
        .oneshot(delete_with_token(
            &format!("/v1/cloud/attachments/{second_id}/multipart"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
    assert_eq!(mock.names().await.len(), 1);
}
