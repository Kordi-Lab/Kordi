//! The mock worker's `/login/*` state machine, following
//! `experiments/omp-provider-routing/login-sessions.ts`: every state carries
//! `{sessionId, status, step, auth, error, version}`, input returns 202 while
//! the flow keeps running, a claim hands out material once and then forgets
//! the session, and every error body is `{error: <fixed code>}`.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;

use super::*;

type SharedState = Arc<MockWorkerShared>;

pub(super) fn routes(router: axum::Router<SharedState>) -> axum::Router<SharedState> {
    router
        .route("/login/start", post(start))
        .route("/login/:session_id", get(poll))
        .route("/login/:session_id/input", post(input))
        .route("/login/:session_id/cancel", post(cancel))
        .route("/login/:session_id/claim", post(claim))
}

fn fail(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn state_body(session_id: &str, login: &MockLogin) -> Value {
    json!({
        "sessionId": session_id,
        "status": login.status,
        "step": login.step,
        "auth": login.auth,
        "error": login.error,
        "version": login.version,
    })
}

/// Runs `update` on one unclaimed login after the bearer check.
fn with_login(
    shared: &MockWorkerShared,
    headers: &HeaderMap,
    session_id: &str,
    update: impl FnOnce(&mut MockLogin) -> Response,
) -> Response {
    if !authorized(shared, headers) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    match shared.logins.lock().unwrap().get_mut(session_id) {
        Some(login) if !login.claimed => update(login),
        _ => fail(StatusCode::NOT_FOUND, "not_found"),
    }
}

/// Codex shows its sign-in link first, then waits for the pasted redirect.
/// Groq, and Anthropic with the `api-key` method, ask for a key straight away.
async fn start(
    State(shared): State<SharedState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if !authorized(&shared, &headers) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let (Some(provider), Some(session_id)) =
        (input["provider"].as_str(), input["sessionId"].as_str())
    else {
        return fail(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let method = match input.get("method").map(Value::as_str) {
        None => "default",
        Some(Some(method @ ("default" | "api-key"))) => method,
        Some(_) => return fail(StatusCode::BAD_REQUEST, "invalid_request"),
    };
    let key_step = |instructions: &str, placeholder: &str| {
        json!({
            "type": "api-key",
            "instructions": instructions,
            "prompt": null,
            "placeholder": placeholder,
            "authUrl": "https://console.example.test/keys"
        })
    };
    let (status, step) = match (provider, method) {
        ("groq", _) => (
            "awaiting-input",
            key_step("Paste a Groq API key.", "gsk_..."),
        ),
        ("anthropic", "api-key") => (
            "awaiting-input",
            key_step("Paste an Anthropic API key.", "sk-ant-..."),
        ),
        (_, "api-key") => return fail(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_flow"),
        ("openai-codex" | "openai-codex-device", _) => (
            "running",
            json!({
                "type": "open-url",
                "url": "https://auth.example.test/oauth/authorize?client_id=kordi-e2e",
                "launchUrl": null,
                "instructions": "Sign in with ChatGPT."
            }),
        ),
        ("busy-provider", _) => return fail(StatusCode::TOO_MANY_REQUESTS, "too_many_sessions"),
        _ => return fail(StatusCode::UNPROCESSABLE_ENTITY, "unknown_provider"),
    };
    let auth = if step["type"] == "open-url" {
        step.clone()
    } else {
        Value::Null
    };
    let login = MockLogin {
        provider: provider.to_string(),
        method: method.to_string(),
        status,
        step,
        auth,
        error: None,
        version: 2,
        outcome: None,
        material: None,
        claim_attempts: 0,
        claimed: false,
        drop_next_claim: false,
        last_after: None,
    };
    let body = state_body(session_id, &login);
    let mut logins = shared.logins.lock().unwrap();
    if logins.contains_key(session_id) {
        return fail(StatusCode::CONFLICT, "session_exists");
    }
    logins.insert(session_id.to_string(), login);
    (StatusCode::ACCEPTED, Json(body)).into_response()
}

async fn poll(
    State(shared): State<SharedState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    with_login(&shared, &headers, &session_id, |login| {
        login.last_after = query.get("after").and_then(|value| value.parse().ok());
        if login.status == "running" {
            match login.outcome.take() {
                Some(Ok(material)) => {
                    login.status = "completed";
                    login.material = Some(material);
                    login.step = Value::Null;
                }
                Some(Err(error)) => {
                    login.status = "failed";
                    login.error = Some(error);
                    login.step = Value::Null;
                }
                // The browser step was shown; now the flow waits for the
                // redirect. The undocumented field must never reach clients.
                None => {
                    login.status = "awaiting-input";
                    login.step = json!({
                        "type": "paste-code",
                        "instructions": "Paste the redirect URL.",
                        "verifier": "synthetic-verifier"
                    });
                }
            }
            login.version += 1;
        }
        Json(state_body(&session_id, login)).into_response()
    })
}

async fn input(
    State(shared): State<SharedState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<Value>,
) -> Response {
    with_login(&shared, &headers, &session_id, |login| {
        let Some(value) = input["value"].as_str() else {
            return fail(StatusCode::BAD_REQUEST, "invalid_input");
        };
        if value.len() > 16_384 {
            return fail(StatusCode::PAYLOAD_TOO_LARGE, "invalid_input");
        }
        if login.status != "awaiting-input" {
            return fail(StatusCode::CONFLICT, "no_pending_input");
        }
        login.drop_next_claim = value == "synthetic-claim-drop";
        login.outcome = Some(match (login.provider.as_str(), value) {
            (_, "synthetic-bad-key") => Err("invalid_input"),
            (_, key) if login.method == "api-key" || login.provider == "groq" => {
                Ok(json!({ "apiMode": "api-key", "apiKey": key }))
            }
            (_, "synthetic-redirect") => Ok(json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "synthetic-access",
                "refreshToken": "synthetic-refresh",
                "expiresAtMs": 4_102_444_800_000_i64,
                "email": null,
                "orgName": null,
                "accountId": "acct-example",
                "apiEndpoint": null,
                "enterpriseUrl": null,
                "projectId": null
            })),
            _ => Err("provider_rejected"),
        });
        login.status = "running";
        login.step = json!({ "type": "progress", "message": "Checking the sign-in." });
        login.version += 1;
        (StatusCode::ACCEPTED, Json(state_body(&session_id, login))).into_response()
    })
}

async fn cancel(
    State(shared): State<SharedState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    with_login(&shared, &headers, &session_id, |login| {
        if !matches!(login.status, "failed" | "cancelled") {
            login.status = "cancelled";
            login.step = Value::Null;
            login.material = None;
            login.version += 1;
        }
        Json(state_body(&session_id, login)).into_response()
    })
}

/// Hands out a completed login's material once; the session is then gone.
async fn claim(
    State(shared): State<SharedState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    if !authorized(&shared, &headers) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let mut logins = shared.logins.lock().unwrap();
    let Some(login) = logins.get_mut(&session_id) else {
        return fail(StatusCode::NOT_FOUND, "not_found");
    };
    login.claim_attempts += 1;
    if login.claimed {
        return fail(StatusCode::NOT_FOUND, "not_found");
    }
    if login.drop_next_claim {
        // Close the connection without an answer, as an unreachable worker
        // would, keeping the material for the next claim. `resume_unwind`
        // ends only this connection's task and prints nothing.
        login.drop_next_claim = false;
        drop(logins);
        std::panic::resume_unwind(Box::new("synthetic dropped claim"));
    }
    let (Some(material), "completed") = (login.material.take(), login.status) else {
        return fail(StatusCode::CONFLICT, "not_completed");
    };
    login.claimed = true;
    let provider = if login.provider == "openai-codex-device" {
        "openai-codex"
    } else {
        login.provider.as_str()
    };
    Json(json!({ "provider": provider, "material": material })).into_response()
}
