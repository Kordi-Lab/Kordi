use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::OriginalUri;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use url::Url;

use super::*;
use crate::chat_sync::removal::{ObjectDeleteError, ObjectStoreDeleter};

fn config(endpoint: &str) -> S3Config {
    S3Config {
        endpoint: Url::parse(endpoint).unwrap(),
        region: "us-east-1".to_string(),
        bucket: "kordi-test".to_string(),
        access_key: "test-access".to_string(),
        secret_key: "test-secret".to_string(),
    }
}

#[test]
fn delete_urls_are_signed_for_the_object() {
    let url = presign_delete_url(&config("http://127.0.0.1:9"), "attachments/a/att_1").unwrap();
    assert_eq!(url.path(), "/kordi-test/attachments/a/att_1");
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(query["X-Amz-Algorithm"], "AWS4-HMAC-SHA256");
    assert!(query.contains_key("X-Amz-Signature"));
    assert!(query["X-Amz-Credential"].starts_with("test-access/"));
    // A delete signature does not authorize a read of the same object.
    let read = presign_download_url(&config("http://127.0.0.1:9"), "attachments/a/att_1").unwrap();
    let read: HashMap<String, String> = read.query_pairs().into_owned().collect();
    assert_ne!(query["X-Amz-Signature"], read["X-Amz-Signature"]);
}

type Seen = Arc<Mutex<Vec<(Method, String)>>>;

/// A local object store that answers every request with `status` and
/// records the method and path it received.
async fn object_store(status: StatusCode) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let recorded = seen.clone();
    let app = axum::Router::new().fallback(move |method: Method, uri: OriginalUri| {
        let recorded = recorded.clone();
        async move {
            recorded
                .lock()
                .unwrap()
                .push((method, uri.0.path().to_string()));
            if status == StatusCode::FOUND {
                return (status, [("location", "http://127.0.0.1:9/elsewhere")]).into_response();
            }
            status.into_response()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), seen)
}

#[tokio::test]
async fn object_deletion_maps_store_responses_to_codes() {
    for (status, expected) in [
        (StatusCode::NO_CONTENT, Ok(())),
        (StatusCode::OK, Ok(())),
        (StatusCode::NOT_FOUND, Ok(())),
        (StatusCode::FORBIDDEN, Err(ObjectDeleteError::Forbidden)),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Err(ObjectDeleteError::Failed),
        ),
        (StatusCode::FOUND, Err(ObjectDeleteError::Failed)),
    ] {
        let (endpoint, seen) = object_store(status).await;
        let deleter = S3ObjectDeleter::new(config(&endpoint));
        assert_eq!(
            deleter.delete_object("attachments/a/att_1").await,
            expected,
            "{status}"
        );
        let seen = seen.lock().unwrap().clone();
        // Exactly one DELETE of the object, and a redirect is not followed.
        assert_eq!(
            seen,
            vec![(
                Method::DELETE,
                "/kordi-test/attachments/a/att_1".to_string()
            )]
        );
    }
}

#[tokio::test]
async fn an_unreachable_object_store_is_a_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let deleter = S3ObjectDeleter::new(config(&format!("http://{address}")));
    assert_eq!(
        deleter.delete_object("attachments/a/att_1").await,
        Err(ObjectDeleteError::Failed)
    );
}
