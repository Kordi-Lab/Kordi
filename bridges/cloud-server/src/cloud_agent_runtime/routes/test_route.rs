use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query_as::query_as;

use super::*;
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::cloud_agent_runtime::provider_auth::{
    equivalent_provider_ids, provider_auth_for_account_route,
};
use crate::cloud_agent_runtime::provider_login::{
    omp_not_configured, omp_unavailable, rate_limited,
};
use worker_errors::{key_check_failure, route_test_failure, worker_error_code};

mod worker_errors;

/// Each of key validation and the route test may reach a provider, so each
/// allows 10 calls per account in 10 minutes.
const PROVIDER_CHECK_LIMIT: u32 = 10;
const PROVIDER_CHECK_WINDOW: Duration = Duration::from_secs(10 * 60);

async fn over_limit(
    limiter: &CloudRateLimiter,
    action: &str,
    account_id: &str,
) -> Option<Response> {
    match limiter
        .observe_account_action(
            action,
            account_id,
            PROVIDER_CHECK_LIMIT,
            PROVIDER_CHECK_WINDOW,
        )
        .await
    {
        RateLimitDecision::Limited { retry_after } => Some(rate_limited(retry_after)),
        RateLimitDecision::Allowed => None,
    }
}

#[derive(Deserialize)]
pub(super) struct TestRouteRequest {
    provider: String,
    #[serde(rename = "authChoice")]
    auth_choice: String,
    model: String,
    thinking: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct ValidateProviderKeyRequest {
    provider: String,
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[derive(Deserialize)]
struct WorkerResult {
    provider: String,
    model: String,
    response: String,
}

#[derive(Serialize)]
struct TestRouteResponse {
    runner: &'static str,
    provider: String,
    #[serde(rename = "accountLabel")]
    account_label: String,
    model: String,
    response: String,
}

fn clean(value: &str, max_chars: usize) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control))
    .then_some(value)
}

fn same_provider(left: &str, right: &str) -> bool {
    let right = right.trim().to_ascii_lowercase();
    equivalent_provider_ids(Some(left)).is_some_and(|family| family.contains(&right))
}

pub(super) async fn provider_catalog() -> Response {
    let Some(worker_url) = std::env::var("KORDI_OMP_ROUTE_WORKER_URL")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return omp_not_configured();
    };
    let response = reqwest::Client::new()
        .get(format!("{}/catalog", worker_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    let Ok(response) = response else {
        return error_response(
            "omp_unavailable",
            "The OMP provider catalog could not be reached.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    if !response.status().is_success() {
        return error_response(
            "omp_unavailable",
            "The OMP provider catalog could not be loaded.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    }
    match response.json::<serde_json::Value>().await {
        Ok(catalog) => Json(catalog).into_response(),
        Err(_) => omp_unavailable(),
    }
}

pub(super) async fn validate_provider_key(
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(input): Json<ValidateProviderKeyRequest>,
) -> Response {
    if let Some(limited) =
        over_limit(&rate_limiter, "provider-validate-key", &session.account_id).await
    {
        return limited;
    }
    let (Some(provider), Some(api_key)) =
        (clean(&input.provider, 80), clean(&input.api_key, 16_384))
    else {
        return error_response(
            "invalid_provider_key",
            "Enter a provider and API key.",
            StatusCode::BAD_REQUEST,
        );
    };
    let (Some(worker_url), Some(worker_token)) = (
        std::env::var("KORDI_OMP_ROUTE_WORKER_URL")
            .ok()
            .filter(|value| !value.is_empty()),
        std::env::var("KORDI_OMP_ROUTE_WORKER_TOKEN")
            .ok()
            .filter(|value| !value.is_empty()),
    ) else {
        return omp_not_configured();
    };
    let response = reqwest::Client::new()
        .post(format!("{}/validate-key", worker_url.trim_end_matches('/')))
        .bearer_auth(worker_token)
        .json(&json!({ "provider": provider, "apiKey": api_key }))
        .timeout(Duration::from_secs(35))
        .send()
        .await;
    let Ok(response) = response else {
        return omp_unavailable();
    };
    if !response.status().is_success() {
        return key_check_failure(&worker_error_code(response).await);
    }
    match response.json::<serde_json::Value>().await {
        Ok(result)
            if result
                .get("verified")
                .and_then(serde_json::Value::as_bool)
                .is_some() =>
        {
            Json(result).into_response()
        }
        _ => omp_unavailable(),
    }
}

pub(super) async fn test_provider_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(input): Json<TestRouteRequest>,
) -> Response {
    if let Some(limited) =
        over_limit(&rate_limiter, "provider-test-route", &session.account_id).await
    {
        return limited;
    }
    let (Some(provider), Some(auth_choice), Some(model)) = (
        clean(&input.provider, 80),
        clean(&input.auth_choice, 160),
        clean(&input.model, 160),
    ) else {
        return error_response(
            "invalid_route",
            "Choose a provider, account, and model.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some((model_provider, model_id)) = model.split_once('/') else {
        return error_response(
            "invalid_route",
            "Choose a provider model.",
            StatusCode::BAD_REQUEST,
        );
    };
    if !same_provider(provider, model_provider) || clean(model_id, 120).is_none() {
        return error_response(
            "invalid_route",
            "The model does not match the selected provider.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(worker_url) = std::env::var("KORDI_OMP_ROUTE_WORKER_URL")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return omp_not_configured();
    };
    let Some(worker_token) = std::env::var("KORDI_OMP_ROUTE_WORKER_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return omp_not_configured();
    };
    let Ok(cipher) = EnvProviderAuthCipher::from_env() else {
        return omp_not_configured();
    };
    let route = json!({
        "defaultAuthProvider": provider,
        "defaultAuthChoice": auth_choice,
        "defaultModel": model,
        "thinking": input.thinking.as_deref().and_then(|value| clean(value, 20)),
    });
    let material = match provider_auth_for_account_route(
        state.db_pool(),
        Some(&cipher),
        &session.account_id,
        &route,
        None,
    )
    .await
    {
        Ok(ProviderAuthForRunResult::Found(material)) => material,
        Ok(ProviderAuthForRunResult::ProviderAuthNotFound) => {
            return error_response(
                "account_unavailable",
                "This saved account is unavailable. Choose another account or reconnect it.",
                StatusCode::NOT_FOUND,
            )
        }
        _ => {
            return error_response(
                "provider_auth_error",
                "Could not use this saved account.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let label: Option<(Option<String>,)> = query_as(
        "SELECT label FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1 AND account_id = $2 AND revoked_at IS NULL",
    )
    .bind(&material.snapshot_id)
    .bind(&session.account_id)
    .fetch_optional(state.db_pool())
    .await
    .ok()
    .flatten();
    let account_label = label
        .and_then(|row| row.0)
        .unwrap_or_else(|| "Saved account".to_string());

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return error_response(
                "omp_unavailable",
                "The OMP route test could not start.",
                StatusCode::SERVICE_UNAVAILABLE,
            )
        }
    };
    let request = json!({ "route": route, "material": material });
    let worker_response = client
        .post(format!("{}/run", worker_url.trim_end_matches('/')))
        .bearer_auth(worker_token)
        .json(&request)
        .send()
        .await;
    let worker_response = match worker_response {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return error_response(
                "omp_timeout",
                "The provider did not answer in time. Try again.",
                StatusCode::GATEWAY_TIMEOUT,
            )
        }
        Err(_) => {
            return error_response(
                "omp_unavailable",
                "The OMP worker could not be reached.",
                StatusCode::SERVICE_UNAVAILABLE,
            )
        }
    };
    if !worker_response.status().is_success() {
        return route_test_failure(&worker_error_code(worker_response).await);
    }
    let Ok(result) = worker_response.json::<WorkerResult>().await else {
        return error_response(
            "omp_failed",
            "The OMP worker returned an invalid result.",
            StatusCode::BAD_GATEWAY,
        );
    };
    if result.provider != material.provider || result.model != model_id {
        return error_response(
            "omp_route_mismatch",
            "The OMP worker did not confirm the selected route.",
            StatusCode::BAD_GATEWAY,
        );
    }
    Json(TestRouteResponse {
        runner: "OMP",
        provider: material.provider,
        account_label,
        model: model.to_string(),
        response: result.response.chars().take(1_000).collect(),
    })
    .into_response()
}
