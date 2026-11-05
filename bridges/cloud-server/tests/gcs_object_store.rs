//! Google Cloud Storage backend against an in-process JSON API stand-in.
//! These tests need no database or network access.

#[path = "support/gcs_mock.rs"]
mod gcs_mock;

use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use gcs_mock::MockGcs;
use kordi_cloud_server::object_storage::{ObjectStore, ObjectStoreError};
use kordi_cloud_server::updates::store::{
    GcsReleaseStore, ReleaseByteRange, ReleaseStoreBackend, ReleaseStoreError,
};

const BUCKET: &str = "example-attachments";

async fn spawn() -> (MockGcs, ObjectStore) {
    let mock = MockGcs::spawn(BUCKET).await;
    let store = mock.store().await;
    (mock, store)
}

#[tokio::test]
async fn instance_token_is_fetched_once_and_reused() {
    let (mock, store) = spawn().await;
    store
        .put("a/one.txt", Some("text/plain"), Bytes::from_static(b"one"))
        .await
        .unwrap();
    assert_eq!(store.size("a/one.txt").await.unwrap(), 3);
    store.delete("a/one.txt").await.unwrap();
    assert_eq!(mock.tokens_issued().await, 1);
    assert_eq!(store.backend_name(), "gcs");
    assert_eq!(store.bucket(), BUCKET);
    assert!(store.direct_download_url("a/one.txt").is_none());
    assert!(store.direct_upload_url("a/one.txt").is_none());
    assert!(!format!("{store:?}").contains("token-"));
}

#[tokio::test]
async fn token_is_refreshed_before_expiry_and_after_rejection() {
    let (mock, store) = spawn().await;
    mock.set_token_lifetime(1).await;
    store
        .put("k", None, Bytes::from_static(b"x"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(store.size("k").await.unwrap(), 1);
    assert_eq!(mock.tokens_issued().await, 2);

    mock.set_token_lifetime(3600).await;
    mock.reject_token("token-2").await;
    mock.reject_token("token-3").await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    // token-3 is fetched on expiry and rejected; one retry gets token-4.
    assert_eq!(store.size("k").await.unwrap(), 1);
    assert_eq!(mock.tokens_issued().await, 4);
}

#[tokio::test]
async fn downloads_support_ranges_and_report_missing_objects() {
    let (mock, store) = spawn().await;
    store
        .put(
            "attachments/acct/att 1",
            Some("image/png"),
            Bytes::from_static(b"0123456789"),
        )
        .await
        .unwrap();
    let stored = mock.object("attachments/acct/att 1").await.unwrap();
    assert_eq!(stored.content_type, "image/png");

    let full = store.get("attachments/acct/att 1", None).await.unwrap();
    assert_eq!(full.status(), 200);
    assert_eq!(full.headers()["content-type"], "image/png");
    assert_eq!(full.bytes().await.unwrap().as_ref(), b"0123456789");

    let ranged = store
        .get("attachments/acct/att 1", Some("bytes=2-5"))
        .await
        .unwrap();
    assert_eq!(ranged.status(), 206);
    assert_eq!(ranged.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(ranged.bytes().await.unwrap().as_ref(), b"2345");

    let unsatisfiable = store
        .get("attachments/acct/att 1", Some("bytes=50-"))
        .await
        .unwrap();
    assert_eq!(unsatisfiable.status(), 416);

    let missing = store.get("attachments/acct/none", None).await.unwrap();
    assert_eq!(missing.status(), 404);
    assert_eq!(
        store.size("attachments/acct/none").await,
        Err(ObjectStoreError::NotFound)
    );
    store.delete("attachments/acct/att 1").await.unwrap();
    store.delete("attachments/acct/att 1").await.unwrap();
    assert!(mock.object("attachments/acct/att 1").await.is_none());
}

#[tokio::test]
async fn multipart_parts_compose_in_order_and_are_removed() {
    let (mock, store) = spawn().await;
    let key = "attachments/acct/att_multi";
    let upload_id = store.create_multipart(key).await.unwrap();
    let mut tokens = vec![String::new(); 3];
    for part in [3_u16, 1, 2] {
        let body = Bytes::from(format!("part{part};"));
        tokens[usize::from(part) - 1] = store
            .upload_part(key, &upload_id, part, body)
            .await
            .unwrap();
    }
    store
        .complete_multipart(key, &upload_id, &tokens, Some("application/zip"))
        .await
        .unwrap();
    let object = mock.object(key).await.unwrap();
    assert_eq!(object.bytes, b"part1;part2;part3;");
    assert_eq!(object.content_type, "application/zip");
    assert_eq!(store.size(key).await.unwrap(), 18);
    assert_eq!(mock.names().await, vec![key.to_string()]);
}

#[tokio::test]
async fn large_uploads_compose_through_intermediate_objects() {
    let (mock, store) = spawn().await;
    let key = "attachments/acct/att_large";
    let upload_id = store.create_multipart(key).await.unwrap();
    let mut tokens = Vec::new();
    let mut expected = Vec::new();
    for part in 1..=70_u16 {
        let body = part.to_be_bytes();
        expected.extend_from_slice(&body);
        tokens.push(
            store
                .upload_part(key, &upload_id, part, Bytes::copy_from_slice(&body))
                .await
                .unwrap(),
        );
    }
    store
        .complete_multipart(key, &upload_id, &tokens, None)
        .await
        .unwrap();
    assert_eq!(mock.object(key).await.unwrap().bytes, expected);
    assert_eq!(mock.names().await, vec![key.to_string()]);
}

#[tokio::test]
async fn replaced_parts_fail_completion_and_abort_cleans_up() {
    let (mock, store) = spawn().await;
    let key = "attachments/acct/att_stale";
    let upload_id = store.create_multipart(key).await.unwrap();
    let mut tokens = Vec::new();
    for part in 1..=3_u16 {
        tokens.push(
            store
                .upload_part(key, &upload_id, part, Bytes::from_static(b"abc"))
                .await
                .unwrap(),
        );
    }
    // A part rewritten after it was recorded no longer matches its generation.
    store
        .upload_part(key, &upload_id, 2, Bytes::from_static(b"xyz"))
        .await
        .unwrap();
    assert_eq!(
        store
            .complete_multipart(key, &upload_id, &tokens, None)
            .await,
        Err(ObjectStoreError::PreconditionFailed)
    );
    assert!(mock.object(key).await.is_none());
    store.abort_multipart(key, &upload_id).await.unwrap();
    assert!(mock.names().await.is_empty());
    // Upload ids from another backend have nothing to remove.
    store.abort_multipart(key, "s3-upload-id").await.unwrap();
}

#[tokio::test]
async fn readiness_reads_bucket_metadata() {
    let (mock, store) = spawn().await;
    assert!(store.ready(Duration::from_secs(2)).await);
    let other = ObjectStore::gcs(mock.bucket_handle("someone-elses-bucket"));
    assert!(!other.ready(Duration::from_secs(2)).await);
    mock.set_token_endpoint_up(false).await;
    let fresh = mock.store().await;
    assert!(!fresh.ready(Duration::from_secs(2)).await);
}

#[tokio::test]
async fn release_store_streams_ranges_from_gcs() {
    let mock = MockGcs::spawn("example-releases").await;
    mock.insert("channels/stable.json", b"{\"v\":1}", "application/json")
        .await;
    mock.insert("assets/app.dmg", b"0123456789", "application/octet-stream")
        .await;
    let store = GcsReleaseStore::new(mock.bucket_handle("example-releases"));

    let metadata = store
        .get_metadata("channels/stable.json", 1024)
        .await
        .unwrap();
    assert_eq!(metadata.as_ref(), b"{\"v\":1}");
    assert_eq!(
        store.get_metadata("channels/stable.json", 3).await,
        Err(ReleaseStoreError::MetadataTooLarge)
    );
    assert_eq!(store.head_object("assets/app.dmg").await, Ok(10));
    assert_eq!(
        store.head_object("assets/missing.dmg").await,
        Err(ReleaseStoreError::NotFound)
    );

    let range = ReleaseByteRange {
        start: 3,
        end_inclusive: 6,
        complete_length: 10,
    };
    let object = store
        .stream_object("assets/app.dmg", Some(range))
        .await
        .unwrap();
    assert_eq!(object.size_bytes, 4);
    let bytes = object
        .body
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    assert_eq!(bytes, b"3456");
    assert!(matches!(
        store.stream_object("assets/missing.dmg", None).await,
        Err(ReleaseStoreError::NotFound)
    ));
}
