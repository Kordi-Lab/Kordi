//! The key cache against a local key server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;

use super::*;
use crate::pool_workers::test_signer::{TestSigner, AUDIENCE, ISSUER, SUBJECT};
use crate::pool_workers::token::{verify, TokenError};

/// A key server on loopback whose answer the test controls: a key set, or
/// a failure when `None`.
struct KeyServer {
    keys: Arc<Mutex<Option<Value>>>,
    fetches: Arc<AtomicUsize>,
    uri: String,
}

async fn key_server(keys: Option<Value>) -> KeyServer {
    let keys = Arc::new(Mutex::new(keys));
    let fetches = Arc::new(AtomicUsize::new(0));
    let (served, counted) = (keys.clone(), fetches.clone());
    let app = Router::new().route(
        "/keys",
        get(move || {
            let (served, counted) = (served.clone(), counted.clone());
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                // A slow answer lets concurrent misses pile up.
                tokio::time::sleep(Duration::from_millis(50)).await;
                let keys = served.lock().unwrap().clone();
                match keys {
                    Some(keys) => Ok(Json(keys)),
                    None => Err(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    KeyServer {
        keys,
        fetches,
        uri: format!("http://{address}/keys"),
    }
}

/// An identity whose keys come from `uri` (built directly: configuration
/// only accepts https key URLs).
fn identity(uri: &str) -> WorkerIdentity {
    WorkerIdentity {
        issuer: ISSUER.to_string(),
        audience: AUDIENCE.to_string(),
        subject: Some(SUBJECT.to_string()),
        email: None,
        jwks_uri: Some(uri.to_string()),
        jwks: None,
    }
}

fn timing(refetch_after: Duration, failure_cache_for: Duration) -> Timing {
    Timing {
        cache_for: Duration::from_secs(3600),
        refetch_after,
        failure_cache_for,
    }
}

#[tokio::test]
async fn rotated_keys_are_picked_up_on_refresh() {
    let (old, new) = (TestSigner::new("old-key"), TestSigner::new("new-key"));
    let server = key_server(Some(old.jwks())).await;
    let cache = KeyCache::new(timing(Duration::ZERO, Duration::from_secs(30)));
    let identity = identity(&server.uri);
    let now = chrono::Utc::now().timestamp();

    let keys = cache.keys(&identity, false).await.unwrap();
    assert!(verify(&old.token(), &identity, &keys, now).is_ok());
    // A cached set is used without fetching again.
    cache.keys(&identity, false).await.unwrap();
    assert_eq!(server.fetches.load(Ordering::SeqCst), 1);

    *server.keys.lock().unwrap() = Some(new.jwks());
    let stale = cache.keys(&identity, false).await.unwrap();
    assert_eq!(
        verify(&new.token(), &identity, &stale, now),
        Err(TokenError::UnknownKey)
    );
    let fresh = cache.keys(&identity, true).await.unwrap();
    assert!(verify(&new.token(), &identity, &fresh, now).is_ok());
    assert_eq!(server.fetches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_recent_refresh_is_not_repeated() {
    let signer = TestSigner::new("key");
    let server = key_server(Some(signer.jwks())).await;
    let cache = KeyCache::new(timing(Duration::from_secs(60), Duration::from_secs(30)));
    let identity = identity(&server.uri);
    cache.keys(&identity, false).await.unwrap();
    // Tokens naming unknown keys cannot make every request fetch.
    for _ in 0..5 {
        cache.keys(&identity, true).await.unwrap();
    }
    assert_eq!(server.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_outage_is_remembered_briefly_and_fetches_are_shared() {
    let signer = TestSigner::new("key");
    let server = key_server(None).await;
    let cache = Arc::new(KeyCache::new(timing(
        Duration::from_secs(60),
        Duration::from_millis(300),
    )));
    let identity = identity(&server.uri);
    assert_eq!(
        cache.keys(&identity, false).await.unwrap_err(),
        KeyError::Unavailable
    );
    assert!(cache.keys(&identity, true).await.is_err());
    assert_eq!(
        server.fetches.load(Ordering::SeqCst),
        1,
        "failure is cached"
    );

    // Once the failure ages out, concurrent misses wait for one fetch.
    *server.keys.lock().unwrap() = Some(signer.jwks());
    tokio::time::sleep(Duration::from_millis(400)).await;
    let calls: Vec<_> = (0..8)
        .map(|_| {
            let (cache, identity) = (cache.clone(), identity.clone());
            tokio::spawn(async move { cache.keys(&identity, false).await })
        })
        .collect();
    for call in calls {
        assert!(call.await.unwrap().is_ok());
    }
    assert_eq!(server.fetches.load(Ordering::SeqCst), 2);
}
