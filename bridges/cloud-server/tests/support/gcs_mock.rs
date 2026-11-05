//! In-process stand-in for the GCE metadata token endpoint and the Google
//! Cloud Storage JSON API, covering the calls the Cloud server makes.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::OriginalUri;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use kordi_cloud_server::object_storage::{GcsBucket, GcsTokenSource, ObjectStore};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

const LIST_PAGE_SIZE: usize = 2;

#[derive(Clone, Debug)]
pub struct MockObject {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub generation: u64,
}

struct MockState {
    bucket: String,
    objects: BTreeMap<String, MockObject>,
    next_generation: u64,
    tokens_issued: usize,
    token_lifetime_secs: u64,
    rejected_tokens: HashSet<String>,
    token_endpoint_up: bool,
}

#[derive(Clone)]
pub struct MockGcs {
    base: String,
    state: Arc<Mutex<MockState>>,
}

fn decode(value: &str) -> String {
    url::form_urlencoded::parse(format!("v={}", value.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, decoded)| decoded.into_owned())
        .unwrap_or_default()
}

fn status(code: StatusCode) -> Response {
    (
        code,
        axum::Json(json!({ "error": { "code": code.as_u16() } })),
    )
        .into_response()
}

impl MockGcs {
    pub async fn spawn(bucket: &str) -> Self {
        let state = Arc::new(Mutex::new(MockState {
            bucket: bucket.to_string(),
            objects: BTreeMap::new(),
            next_generation: 1_000,
            tokens_issued: 0,
            token_lifetime_secs: 3600,
            rejected_tokens: HashSet::new(),
            token_endpoint_up: true,
        }));
        let app_state = state.clone();
        let app = axum::Router::new().fallback(
            move |method: Method, uri: OriginalUri, headers: HeaderMap, body: Body| {
                let state = app_state.clone();
                async move { handle(state, method, uri.0, headers, body).await }
            },
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            base: format!("http://{addr}"),
            state,
        }
    }

    pub fn endpoint(&self) -> Url {
        Url::parse(&self.base).unwrap()
    }

    pub fn token_url(&self) -> Url {
        Url::parse(&format!("{}/token", self.base)).unwrap()
    }

    pub fn tokens(&self) -> Arc<GcsTokenSource> {
        Arc::new(GcsTokenSource::new(self.token_url()).unwrap())
    }

    pub fn bucket_handle(&self, bucket: &str) -> GcsBucket {
        GcsBucket::new(&self.endpoint(), bucket.to_string(), self.tokens()).unwrap()
    }

    pub async fn store(&self) -> ObjectStore {
        let bucket = self.state.lock().await.bucket.clone();
        ObjectStore::gcs(self.bucket_handle(&bucket))
    }

    pub async fn tokens_issued(&self) -> usize {
        self.state.lock().await.tokens_issued
    }

    pub async fn set_token_lifetime(&self, seconds: u64) {
        self.state.lock().await.token_lifetime_secs = seconds;
    }

    pub async fn reject_token(&self, token: &str) {
        self.state
            .lock()
            .await
            .rejected_tokens
            .insert(token.to_string());
    }

    pub async fn set_token_endpoint_up(&self, up: bool) {
        self.state.lock().await.token_endpoint_up = up;
    }

    pub async fn object(&self, name: &str) -> Option<MockObject> {
        self.state.lock().await.objects.get(name).cloned()
    }

    pub async fn insert(&self, name: &str, bytes: &[u8], content_type: &str) {
        let mut state = self.state.lock().await;
        state.next_generation += 1;
        let generation = state.next_generation;
        state.objects.insert(
            name.to_string(),
            MockObject {
                bytes: bytes.to_vec(),
                content_type: content_type.to_string(),
                generation,
            },
        );
    }

    pub async fn names(&self) -> Vec<String> {
        self.state.lock().await.objects.keys().cloned().collect()
    }
}

fn metadata(name: &str, object: &MockObject) -> Response {
    axum::Json(json!({
        "name": name,
        "size": object.bytes.len().to_string(),
        "generation": object.generation.to_string(),
        "contentType": object.content_type,
    }))
    .into_response()
}

fn media(object: &MockObject, range: Option<&str>) -> Response {
    let length = object.bytes.len();
    let Some(range) = range.and_then(|value| value.strip_prefix("bytes=")) else {
        return (
            [("content-type", object.content_type.clone())],
            object.bytes.clone(),
        )
            .into_response();
    };
    let (start, end) = range.split_once('-').unwrap();
    let start: usize = start.parse().unwrap();
    let end: usize = end.parse().unwrap_or(length.saturating_sub(1));
    if start >= length {
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [("content-range", format!("bytes */{length}"))],
        )
            .into_response();
    }
    let end = end.min(length - 1);
    (
        StatusCode::PARTIAL_CONTENT,
        [
            ("content-type", object.content_type.clone()),
            ("content-range", format!("bytes {start}-{end}/{length}")),
        ],
        object.bytes[start..=end].to_vec(),
    )
        .into_response()
}

async fn handle(
    state: Arc<Mutex<MockState>>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let path = uri.path().to_string();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let mut state = state.lock().await;
    if path == "/token" {
        if !state.token_endpoint_up {
            return status(StatusCode::SERVICE_UNAVAILABLE);
        }
        if headers.get("metadata-flavor").and_then(|v| v.to_str().ok()) != Some("Google") {
            return status(StatusCode::FORBIDDEN);
        }
        state.tokens_issued += 1;
        return axum::Json(json!({
            "access_token": format!("token-{}", state.tokens_issued),
            "expires_in": state.token_lifetime_secs,
            "token_type": "Bearer",
        }))
        .into_response();
    }
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let issued = token
        .strip_prefix("token-")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|number| number >= 1 && number <= state.tokens_issued);
    if !issued || state.rejected_tokens.contains(&token) {
        return status(StatusCode::UNAUTHORIZED);
    }
    let bucket_path = format!("/storage/v1/b/{}", state.bucket);
    let upload_path = format!("/upload/storage/v1/b/{}/o", state.bucket);
    if method == Method::POST && path == upload_path {
        assert_eq!(query.get("uploadType").map(String::as_str), Some("media"));
        let name = query.get("name").cloned().unwrap();
        let content_type = headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = to_bytes(body, 64 * 1024 * 1024).await.unwrap().to_vec();
        state.next_generation += 1;
        let object = MockObject {
            bytes,
            content_type,
            generation: state.next_generation,
        };
        state.objects.insert(name.clone(), object.clone());
        return metadata(&name, &object);
    }
    if path == bucket_path {
        return axum::Json(json!({ "name": state.bucket })).into_response();
    }
    if path == format!("{bucket_path}/o") {
        let prefix = query.get("prefix").cloned().unwrap_or_default();
        let after = query.get("pageToken").cloned().unwrap_or_default();
        let matching = state
            .objects
            .keys()
            .filter(|name| name.starts_with(&prefix) && **name > after)
            .cloned()
            .collect::<Vec<_>>();
        let page = matching
            .iter()
            .take(LIST_PAGE_SIZE)
            .cloned()
            .collect::<Vec<_>>();
        let mut reply = json!({
            "items": page.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
        });
        if matching.len() > LIST_PAGE_SIZE {
            reply["nextPageToken"] = Value::String(page.last().unwrap().clone());
        }
        return axum::Json(reply).into_response();
    }
    let Some(rest) = path.strip_prefix(&format!("{bucket_path}/o/")) else {
        return status(StatusCode::NOT_FOUND);
    };
    if let Some(destination) = rest.strip_suffix("/compose") {
        let destination = decode(destination);
        let request: Value =
            serde_json::from_slice(&to_bytes(body, 1024 * 1024).await.unwrap()).unwrap();
        let sources = request["sourceObjects"].as_array().unwrap();
        assert!(!sources.is_empty() && sources.len() <= 32);
        let mut bytes = Vec::new();
        for source in sources {
            let name = source["name"].as_str().unwrap();
            let Some(object) = state.objects.get(name) else {
                return status(StatusCode::NOT_FOUND);
            };
            if let Some(expected) = source["objectPreconditions"]["ifGenerationMatch"].as_str() {
                if expected != object.generation.to_string() {
                    return status(StatusCode::PRECONDITION_FAILED);
                }
            }
            bytes.extend_from_slice(&object.bytes);
        }
        state.next_generation += 1;
        let object = MockObject {
            bytes,
            content_type: request["destination"]["contentType"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .to_string(),
            generation: state.next_generation,
        };
        state.objects.insert(destination.clone(), object.clone());
        return metadata(&destination, &object);
    }
    let name = decode(rest);
    match method {
        Method::GET => match state.objects.get(&name) {
            Some(object) if query.get("alt").map(String::as_str) == Some("media") => media(
                object,
                headers.get("range").and_then(|value| value.to_str().ok()),
            ),
            Some(object) => metadata(&name, object),
            None => status(StatusCode::NOT_FOUND),
        },
        Method::DELETE => match state.objects.remove(&name) {
            Some(_) => StatusCode::NO_CONTENT.into_response(),
            None => status(StatusCode::NOT_FOUND),
        },
        _ => status(StatusCode::METHOD_NOT_ALLOWED),
    }
}
