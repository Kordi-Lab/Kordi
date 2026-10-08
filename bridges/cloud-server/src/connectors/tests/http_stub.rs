//! A local HTTP server standing in for provider APIs in tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Router;
use serde_json::Value;

#[derive(Debug, Clone)]
pub(super) struct Recorded {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: String,
    pub if_match: String,
    pub body: String,
}

/// A response used only when the request matches: its query contains
/// `query` and its bearer token is `token`, when given.
struct Conditional {
    route: String,
    query: Option<String>,
    token: Option<String>,
    status: u16,
    body: Value,
}

#[derive(Default)]
struct StubState {
    responses: Mutex<HashMap<String, (u16, Value)>>,
    conditional: Mutex<Vec<Conditional>>,
    rejected_tokens: Mutex<Vec<String>>,
    requests: Mutex<Vec<Recorded>>,
}

/// Canned JSON responses keyed by `"<METHOD> <path>"`. A bearer token in
/// the rejected list gets 401; unknown routes get 404.
#[derive(Clone)]
pub(super) struct HttpStub {
    pub base: String,
    state: Arc<StubState>,
}

impl HttpStub {
    pub async fn start() -> Self {
        let state = Arc::new(StubState::default());
        let app = Router::new().fallback(handle).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { base, state }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub fn respond(&self, method: &str, path: &str, body: Value) {
        self.respond_status(method, path, 200, body);
    }

    pub fn respond_status(&self, method: &str, path: &str, status: u16, body: Value) {
        self.state
            .responses
            .lock()
            .unwrap()
            .insert(format!("{method} {path}"), (status, body));
    }

    /// Answers requests to `path` whose query contains `query` (when given)
    /// and whose bearer token is `token` (when given). The latest matching
    /// registration wins over plain [`Self::respond`] entries.
    pub fn respond_when(
        &self,
        method: &str,
        path: &str,
        query: Option<&str>,
        token: Option<&str>,
        status: u16,
        body: Value,
    ) {
        self.state.conditional.lock().unwrap().push(Conditional {
            route: format!("{method} {path}"),
            query: query.map(str::to_string),
            token: token.map(str::to_string),
            status,
            body,
        });
    }

    pub fn reject_token(&self, token: &str) {
        self.state
            .rejected_tokens
            .lock()
            .unwrap()
            .push(token.to_string());
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.state.requests.lock().unwrap().clone()
    }

    pub fn requests_to(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|request| request.method == method && request.path == path)
            .collect()
    }
}

async fn handle(
    State(state): State<Arc<StubState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    state.requests.lock().unwrap().push(Recorded {
        method: method.to_string(),
        path: uri.path().to_string(),
        query: uri.query().unwrap_or_default().to_string(),
        authorization: authorization.clone(),
        if_match: headers
            .get("if-match")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string(),
        body: String::from_utf8_lossy(&body).into_owned(),
    });
    let rejected = state
        .rejected_tokens
        .lock()
        .unwrap()
        .iter()
        .any(|token| authorization == format!("Bearer {token}"));
    if rejected {
        return (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({}))).into_response();
    }
    let route = format!("{method} {}", uri.path());
    let query = uri.query().unwrap_or_default();
    let conditional = state
        .conditional
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|entry| {
            entry.route == route
                && entry
                    .query
                    .as_deref()
                    .is_none_or(|part| query.contains(part))
                && entry
                    .token
                    .as_deref()
                    .is_none_or(|token| authorization == format!("Bearer {token}"))
        })
        .map(|entry| (entry.status, entry.body.clone()));
    let found = conditional.or_else(|| state.responses.lock().unwrap().get(&route).cloned());
    match found {
        Some((status, body)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            axum::Json(body),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
