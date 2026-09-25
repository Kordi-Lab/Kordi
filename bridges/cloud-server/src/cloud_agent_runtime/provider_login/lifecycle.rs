//! Session lifecycle: answers from stored state, applies worker updates, and
//! claims a finished login exactly once.

use std::time::Duration;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::responses::{
    completed_response, invalid_input, login_expired, login_failed, login_not_found,
    not_awaiting_input, omp_busy, omp_not_configured, omp_unavailable, provider_auth_error,
    server_error, state_response, stored_state, LookupFailure,
};
use super::store::{self, LoginSession, SavedSnapshot};
use super::worker::{
    classification, client_auth, client_step, LoginWorker, WorkerError, WorkerLoginState,
};
use crate::cloud_agent_runtime::provider_auth::{
    publish_snapshot, EnvProviderAuthCipher, PublishProviderAuthSnapshotRequest,
    PublishSnapshotError,
};
use crate::server::ServerState;

const AUTH_CHOICE_PREFIX: &str = "cloud-login:";
const CLAIM_WAIT_POLLS: u32 = 100;
const CLAIM_WAIT_INTERVAL: Duration = Duration::from_millis(100);

/// Answers from the stored session when it no longer needs the worker. A
/// request that finds another request claiming the login waits for the saved
/// snapshot, so both return the same completed response.
pub(super) async fn stored_response(state: &ServerState, login: &LoginSession) -> Option<Response> {
    let awaited;
    let login = if login.status == "claiming" {
        match current_claim(state, login).await {
            Ok(current) => {
                awaited = current;
                &awaited
            }
            Err(failure) => return Some(failure.into_response()),
        }
    } else {
        login
    };
    if login.status == "expired" || (login.expired && login.status == "running") {
        return Some(expire(state, login).await);
    }
    match login.status.as_str() {
        "completed" => Some(completed_response(
            &login.session_id,
            login.snapshot.as_ref(),
        )),
        "failed" => Some(login_failed(
            login.failure_reason.as_deref().unwrap_or("unknown"),
        )),
        "cancelled" => Some(stored_state(&login.session_id, "cancelled")),
        // Still saving after the wait; an abandoned claim fails on a later poll.
        "claiming" => Some(saving_response(&login.session_id)),
        _ => None,
    }
}

/// The login finished and its account is being saved; the client polls again.
fn saving_response(session_id: &str) -> Response {
    state_response(
        session_id,
        "running",
        json!({ "type": "progress", "message": "Saving the account." }),
        Value::Null,
        None,
        StatusCode::OK,
    )
}

/// The session once its claim settles. An abandoned claim fails at once with
/// `timeout` instead of making every poll wait for it.
async fn current_claim(
    state: &ServerState,
    login: &LoginSession,
) -> Result<LoginSession, LookupFailure> {
    if !login.expired && !login.claim_stale {
        return await_claim(state, login).await;
    }
    let pool = state.db_pool();
    let reloaded = match store::transition(
        pool,
        &login.session_id,
        &["claiming"],
        "failed",
        Some("timeout"),
        None,
    )
    .await
    {
        Ok(_) => store::owned(pool, &login.session_id, &login.account_id).await,
        Err(err) => Err(err),
    };
    match reloaded {
        Ok(Some(current)) => Ok(current),
        Ok(None) => Err(LookupFailure::NotFound),
        Err(err) => {
            eprintln!("[provider_login] end abandoned login claim: {err}");
            Err(LookupFailure::ServerError)
        }
    }
}

async fn await_claim(
    state: &ServerState,
    login: &LoginSession,
) -> Result<LoginSession, LookupFailure> {
    let mut latest = None;
    for _ in 0..CLAIM_WAIT_POLLS {
        tokio::time::sleep(CLAIM_WAIT_INTERVAL).await;
        match store::owned(state.db_pool(), &login.session_id, &login.account_id).await {
            Ok(Some(current)) if current.status == "claiming" => latest = Some(current),
            Ok(Some(current)) => return Ok(current),
            Ok(None) => return Err(LookupFailure::NotFound),
            Err(err) => {
                eprintln!("[provider_login] await login claim: {err}");
                return Err(LookupFailure::ServerError);
            }
        }
    }
    latest.ok_or(LookupFailure::ServerError)
}

pub(super) async fn settle(
    state: &ServerState,
    worker: &LoginWorker,
    login: &LoginSession,
    update: WorkerLoginState,
    pending_status: StatusCode,
) -> Response {
    match update.status.as_str() {
        "running" | "awaiting-input" => state_response(
            &login.session_id,
            &update.status,
            client_step(&update.step),
            client_auth(&update.auth),
            update.version,
            pending_status,
        ),
        "completed" => claim_and_save(state, worker, login).await,
        "failed" => {
            let reason = classification(update.error.as_deref());
            finish(state, login, &["running"], "failed", Some(&reason)).await
        }
        "cancelled" => finish(state, login, &["running"], "cancelled", None).await,
        _ => login_failed("invalid_worker_state"),
    }
}

/// Claims the finished credential once, stores it as an encrypted snapshot,
/// and records the snapshot on the session before responding.
async fn claim_and_save(
    state: &ServerState,
    worker: &LoginWorker,
    login: &LoginSession,
) -> Response {
    // Check the cipher before claiming: a claim cannot be repeated.
    let Ok(cipher) = EnvProviderAuthCipher::from_env() else {
        return omp_not_configured();
    };
    let pool = state.db_pool();
    match store::transition(
        pool,
        &login.session_id,
        &["running"],
        "claiming",
        None,
        None,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => return reload(state, login).await,
        Err(err) => {
            eprintln!("[provider_login] begin claim: {err}");
            return server_error();
        }
    }
    let claimed = match worker.claim(&login.session_id).await {
        Ok(claimed) => claimed,
        // The worker still holds the credential when the request never
        // reached it, so the next poll claims again. If the worker did hand
        // it over, that retry finds the session gone and fails it.
        Err(WorkerError::Unreachable) => {
            return match store::transition(
                pool,
                &login.session_id,
                &["claiming"],
                "running",
                None,
                None,
            )
            .await
            {
                Ok(_) => saving_response(&login.session_id),
                Err(err) => {
                    eprintln!("[provider_login] reopen login claim: {err}");
                    server_error()
                }
            };
        }
        Err(_) => return finish(state, login, &["claiming"], "failed", Some("claim_failed")).await,
    };
    // A device login is a sign-in method of the chosen provider, so the saved
    // account keeps the provider the user picked.
    let claimed_provider = claimed.provider.trim();
    let request = PublishProviderAuthSnapshotRequest {
        provider: login.target.provider.clone(),
        auth_choice: format!("{AUTH_CHOICE_PREFIX}{}", login.session_id),
        label: Some(login.target.label.clone()),
        payload: claimed.material,
    };
    let input = (claimed_provider == login.target.provider
        || claimed_provider == login.target.worker_provider)
        .then(|| request.normalized())
        .flatten()
        .filter(|input| usable_material(&input.payload));
    let saved = match input {
        Some(input) => {
            match publish_snapshot(pool, &cipher, &login.account_id, &login.device_id, input).await
            {
                Ok(snapshot) => Some(snapshot),
                Err(PublishSnapshotError::LimitReached) => {
                    return finish(state, login, &["claiming"], "failed", Some("account_limit"))
                        .await;
                }
                Err(PublishSnapshotError::Store(_)) => None,
            }
        }
        None => None,
    };
    let Some(snapshot) = saved else {
        eprintln!(
            "[provider_login] could not save the claimed login for session {}",
            login.session_id
        );
        let _ = store::transition(
            pool,
            &login.session_id,
            &["claiming"],
            "failed",
            Some("save_failed"),
            None,
        )
        .await;
        return provider_auth_error();
    };
    match store::transition(
        pool,
        &login.session_id,
        &["claiming"],
        "completed",
        None,
        Some(&snapshot.snapshot_id),
    )
    .await
    {
        Ok(true) => completed_response(
            &login.session_id,
            Some(&SavedSnapshot {
                snapshot_id: snapshot.snapshot_id,
                provider: snapshot.provider,
                auth_choice: snapshot.auth_choice,
                label: snapshot.label,
            }),
        ),
        _ => provider_auth_error(),
    }
}

fn usable_material(material: &Value) -> bool {
    let text = |field: &str| {
        material
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    match material.get("apiMode").and_then(Value::as_str) {
        Some("api-key") => text("apiKey"),
        Some(mode) if mode.ends_with("-oauth") => text("accessToken"),
        _ => false,
    }
}

/// Records a terminal state, or reports the state another request recorded.
pub(super) async fn finish(
    state: &ServerState,
    login: &LoginSession,
    from: &[&str],
    to: &str,
    reason: Option<&str>,
) -> Response {
    match store::transition(state.db_pool(), &login.session_id, from, to, reason, None).await {
        Ok(true) if to == "failed" => login_failed(reason.unwrap_or("unknown")),
        Ok(true) => stored_state(&login.session_id, to),
        Ok(false) => reload(state, login).await,
        Err(err) => {
            eprintln!("[provider_login] update login session: {err}");
            server_error()
        }
    }
}

async fn reload(state: &ServerState, login: &LoginSession) -> Response {
    match store::owned(state.db_pool(), &login.session_id, &login.account_id).await {
        Ok(Some(current)) => match stored_response(state, &current).await {
            Some(response) => response,
            None => stored_state(&current.session_id, "running"),
        },
        Ok(None) => login_not_found(),
        Err(err) => {
            eprintln!("[provider_login] reload login session: {err}");
            server_error()
        }
    }
}

/// Ends a login that outlived the 20-minute window and cancels it at the worker.
pub(super) async fn expire(state: &ServerState, login: &LoginSession) -> Response {
    if login.status == "running" {
        if let Some(worker) = LoginWorker::from_env() {
            let _ = worker.cancel(&login.session_id).await;
        }
    }
    let _ = store::transition(
        state.db_pool(),
        &login.session_id,
        &["running"],
        "expired",
        None,
        None,
    )
    .await;
    login_expired()
}

/// Maps a worker rejection of a poll, input, or cancel request.
pub(super) async fn worker_failure(
    state: &ServerState,
    login: &LoginSession,
    error: WorkerError,
) -> Response {
    match error {
        WorkerError::Status(404, _) => {
            finish(state, login, &["running"], "failed", Some("session_lost")).await
        }
        WorkerError::Status(409, _) => not_awaiting_input(),
        WorkerError::Status(400 | 413 | 422, _) => invalid_input("OMP could not use this input."),
        WorkerError::Status(429, _) => omp_busy(),
        WorkerError::Status(..) | WorkerError::Unreachable | WorkerError::InvalidResponse => {
            omp_unavailable()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_usable_material_is_saved() {
        assert!(usable_material(
            &json!({ "apiMode": "api-key", "apiKey": "synthetic" })
        ));
        assert!(usable_material(
            &json!({ "apiMode": "openai-codex-oauth", "accessToken": "synthetic" })
        ));
        // OMP endpoint fields travel with the credential to the runner.
        assert!(usable_material(&json!({
            "apiMode": "api-key",
            "apiKey": "synthetic",
            "baseUrl": "https://api.mistral.ai/v1",
            "api": "openai-completions"
        })));
        assert!(!usable_material(&json!({ "apiMode": "api-key" })));
        assert!(!usable_material(&json!({ "accessToken": "synthetic" })));
    }
}
