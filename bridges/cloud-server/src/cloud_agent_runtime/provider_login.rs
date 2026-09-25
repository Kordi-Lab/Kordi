//! Server-owned interactive provider login sessions.
//!
//! The OMP route worker runs each provider's real login steps. The server owns
//! the session: it checks ownership and the 20-minute login window, forwards
//! steps and user input, claims the finished credential exactly once, and
//! stores it only as an encrypted provider-auth snapshot. Claimed material and
//! user input never appear in a response, log line, or error.

mod lifecycle;
mod responses;
mod store;
mod worker;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::provider_auth::{
    snapshot_capacity_available, EnvProviderAuthCipher,
};
use crate::server::ServerState;
use lifecycle::{expire, finish, settle, stored_response, worker_failure};
use responses::{
    invalid_input, login_unsupported, not_awaiting_input, omp_busy, server_error, LookupFailure,
};
pub(crate) use responses::{
    omp_not_configured, omp_unavailable, provider_auth_limit_reached, rate_limited,
};
use store::{LoginSession, LoginTarget};
use worker::{LoginWorker, WorkerError};

const START_ACTION: &str = "provider-login-start";
const START_LIMIT: u32 = 5;
const START_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_INPUT_BYTES: usize = 16 * 1024;

pub(super) fn mount(router: Router<Arc<ServerState>>) -> Router<Arc<ServerState>> {
    router
        .route(
            "/v1/cloud/agent-provider-auth/login/start",
            post(start_login),
        )
        .route(
            "/v1/cloud/agent-provider-auth/login/:session_id",
            get(login_state),
        )
        .route(
            "/v1/cloud/agent-provider-auth/login/:session_id/input",
            post(login_input),
        )
        .route(
            "/v1/cloud/agent-provider-auth/login/:session_id/cancel",
            post(cancel_login),
        )
}

#[derive(Deserialize)]
struct StartLoginRequest {
    provider: Option<String>,
    label: Option<String>,
    mode: Option<String>,
    /// Kept as JSON so a non-string value is an invalid input, not a
    /// malformed request.
    method: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct LoginStateQuery {
    wait: Option<u64>,
    after: Option<u64>,
}

#[derive(Deserialize)]
struct LoginInputRequest {
    value: Option<String>,
}

fn login_target(input: &StartLoginRequest) -> Option<LoginTarget> {
    let provider = input.provider.as_deref()?.trim();
    let provider_is_id = provider.len() <= 80
        && provider
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && provider.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
        });
    let label = input.label.as_deref()?.trim();
    if !provider_is_id
        || label.is_empty()
        || label.chars().count() > 80
        || label.chars().any(char::is_control)
    {
        return None;
    }
    let method = match input.method.as_ref().map(serde_json::Value::as_str) {
        None => "default",
        Some(Some(method @ ("default" | "api-key"))) => method,
        Some(_) => return None,
    };
    let worker_provider = match input.mode.as_deref().map(str::trim) {
        None | Some("") => provider.to_string(),
        // The device sign-in is an OAuth flow and cannot take a pasted key.
        Some("device") if provider == "openai-codex" && method == "default" => {
            "openai-codex-device".to_string()
        }
        Some(_) => return None,
    };
    Some(LoginTarget {
        provider: provider.to_string(),
        worker_provider,
        label: label.to_string(),
        method: method.to_string(),
    })
}

async fn start_login(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(input): Json<StartLoginRequest>,
) -> Response {
    let Some(target) = login_target(&input) else {
        return invalid_input("Choose a provider and enter an account name.");
    };
    let Some(worker) = LoginWorker::from_env() else {
        return omp_not_configured();
    };
    // A finished login is saved at once, so refuse before the user signs in
    // when the account could not be saved.
    if EnvProviderAuthCipher::from_env().is_err() {
        return omp_not_configured();
    }
    if let Err(err) = store::sweep_stale(state.db_pool(), &session.account_id).await {
        eprintln!("[provider_login] end abandoned login sessions: {err}");
    }
    match snapshot_capacity_available(state.db_pool(), &session.account_id).await {
        Ok(true) => {}
        Ok(false) => return provider_auth_limit_reached(),
        Err(err) => {
            eprintln!("[provider_login] count saved accounts: {err}");
            return server_error();
        }
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_action(START_ACTION, &session.account_id, START_LIMIT, START_WINDOW)
        .await
    {
        return rate_limited(retry_after);
    }
    let session_id = Uuid::new_v4().to_string();
    let (worker_provider, method) = (target.worker_provider.clone(), target.method.clone());
    let login = match store::insert(
        state.db_pool(),
        &session_id,
        &session.account_id,
        &session.device_id,
        target,
    )
    .await
    {
        Ok(login) => login,
        Err(err) => {
            eprintln!("[provider_login] record login session: {err}");
            return server_error();
        }
    };
    match worker.start(&worker_provider, &session_id, &method).await {
        Ok(update) => settle(&state, &worker, &login, update, StatusCode::ACCEPTED).await,
        Err(error) => {
            let reason = match &error {
                WorkerError::Status(_, code) => code.clone(),
                WorkerError::Unreachable | WorkerError::InvalidResponse => "start_failed".into(),
            };
            let _ = store::transition(
                state.db_pool(),
                &session_id,
                &["running"],
                "failed",
                Some(&reason),
                None,
            )
            .await;
            match error {
                WorkerError::Status(422, _) => login_unsupported(&reason),
                WorkerError::Status(429, _) => omp_busy(),
                WorkerError::Status(400, _) => {
                    invalid_input("OMP cannot sign in to this provider.")
                }
                _ => omp_unavailable(),
            }
        }
    }
}

async fn login_state(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(session_id): Path<String>,
    Query(query): Query<LoginStateQuery>,
) -> Response {
    let login = match owned_login(&state, &session_id, &session.account_id).await {
        Ok(login) => login,
        Err(failure) => return failure.into_response(),
    };
    if let Some(response) = stored_response(&state, &login).await {
        return response;
    }
    let Some(worker) = LoginWorker::from_env() else {
        return omp_not_configured();
    };
    match worker
        .state(&login.session_id, query.wait.unwrap_or(0), query.after)
        .await
    {
        Ok(update) => settle(&state, &worker, &login, update, StatusCode::OK).await,
        Err(error) => worker_failure(&state, &login, error).await,
    }
}

async fn login_input(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(session_id): Path<String>,
    Json(input): Json<LoginInputRequest>,
) -> Response {
    let Some(value) = input.value.filter(|value| value.len() <= MAX_INPUT_BYTES) else {
        return invalid_input("Enter a value of at most 16 KB.");
    };
    let login = match owned_login(&state, &session_id, &session.account_id).await {
        Ok(login) => login,
        Err(failure) => return failure.into_response(),
    };
    if login.status == "expired" || (login.expired && login.status == "running") {
        return expire(&state, &login).await;
    }
    if login.status != "running" {
        return not_awaiting_input();
    }
    let Some(worker) = LoginWorker::from_env() else {
        return omp_not_configured();
    };
    match worker.input(&login.session_id, &value).await {
        Ok(update) => settle(&state, &worker, &login, update, StatusCode::OK).await,
        Err(error) => worker_failure(&state, &login, error).await,
    }
}

async fn cancel_login(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(session_id): Path<String>,
) -> Response {
    let login = match owned_login(&state, &session_id, &session.account_id).await {
        Ok(login) => login,
        Err(failure) => return failure.into_response(),
    };
    if let Some(response) = stored_response(&state, &login).await {
        return response;
    }
    let Some(worker) = LoginWorker::from_env() else {
        return omp_not_configured();
    };
    match worker.cancel(&login.session_id).await {
        Ok(()) | Err(WorkerError::Status(404 | 409, _)) => {}
        Err(_) => return omp_unavailable(),
    }
    finish(&state, &login, &["running"], "cancelled", None).await
}

async fn owned_login(
    state: &ServerState,
    raw_session_id: &str,
    account_id: &str,
) -> Result<LoginSession, LookupFailure> {
    // Only canonical server-issued IDs reach the database or the worker URL.
    let Ok(session_id) = Uuid::parse_str(raw_session_id) else {
        return Err(LookupFailure::NotFound);
    };
    match store::owned(state.db_pool(), &session_id.to_string(), account_id).await {
        Ok(Some(login)) => Ok(login),
        Ok(None) => Err(LookupFailure::NotFound),
        Err(err) => {
            eprintln!("[provider_login] load login session: {err}");
            Err(LookupFailure::ServerError)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(provider: &str, label: &str, mode: Option<&str>) -> Option<LoginTarget> {
        login_target(&StartLoginRequest {
            provider: Some(provider.into()),
            label: Some(label.into()),
            mode: mode.map(Into::into),
            method: None,
        })
    }

    #[test]
    fn login_methods_are_default_or_api_key() {
        let with_method = |mode: Option<&str>, method: &str| {
            login_target(&StartLoginRequest {
                provider: Some("openai-codex".into()),
                label: Some("Keys".into()),
                mode: mode.map(Into::into),
                method: Some(serde_json::json!(method)),
            })
        };
        assert_eq!(with_method(None, "api-key").unwrap().method, "api-key");
        assert_eq!(with_method(None, "default").unwrap().method, "default");
        assert_eq!(target("groq", "Keys", None).unwrap().method, "default");
        assert!(with_method(None, "password").is_none());
        assert!(with_method(None, "API-KEY").is_none());
        assert!(with_method(Some("device"), "api-key").is_none());
        let numeric = StartLoginRequest {
            provider: Some("anthropic".into()),
            label: Some("Keys".into()),
            mode: None,
            method: Some(serde_json::json!(7)),
        };
        assert!(login_target(&numeric).is_none());
    }

    #[test]
    fn login_targets_validate_provider_label_and_mode() {
        let device = target("openai-codex", " Work ", Some("device")).unwrap();
        assert_eq!(device.provider, "openai-codex");
        assert_eq!(device.worker_provider, "openai-codex-device");
        assert_eq!(device.label, "Work");
        assert_eq!(
            target("groq", "Keys", None).unwrap().worker_provider,
            "groq"
        );
        assert!(target("Groq", "Keys", None).is_none());
        assert!(target("-groq", "Keys", None).is_none());
        assert!(target("groq", "", None).is_none());
        assert!(target("groq", "Line\nbreak", None).is_none());
        assert!(target("groq", &"x".repeat(81), None).is_none());
        assert!(target("groq", "Keys", Some("device")).is_none());
        assert!(target(&"a".repeat(81), "Keys", None).is_none());
    }
}
