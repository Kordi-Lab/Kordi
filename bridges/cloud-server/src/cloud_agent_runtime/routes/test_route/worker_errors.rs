//! Client responses for the OMP worker's `/run` and `/validate-key`
//! refusals. The worker answers every failure with `{"error": "<fixed code>"}`;
//! each known code maps to a fixed message and status, and nothing the worker
//! or a provider wrote reaches the client.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::cloud_agent_runtime::runs::error_response;

/// The worker's fixed error code, or `unknown` for any other body.
pub(super) async fn worker_error_code(response: reqwest::Response) -> String {
    let code = response.json::<Value>().await.ok().and_then(|body| {
        body.get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    match code {
        Some(code)
            if !code.is_empty()
                && code.len() <= 64
                && code.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                }) =>
        {
            code
        }
        _ => "unknown".to_string(),
    }
}

/// A refused `/run` route test.
pub(super) fn route_test_failure(code: &str) -> Response {
    let (error_code, message, status) = match code {
        "unsupported_model" => (
            "unsupported_model",
            "OMP cannot use this model. Choose another model.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "invalid_custom_endpoint" => (
            "invalid_custom_endpoint",
            "Kordi Cloud cannot reach this endpoint. Use a public HTTPS address.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "credential_expired" | "credential_missing" => (
            "account_needs_reconnect",
            "This saved account must be reconnected before it can run.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "provider_rejected" => (
            "provider_rejected",
            "The provider rejected this account or model. Reconnect or choose another model.",
            StatusCode::BAD_GATEWAY,
        ),
        "route_mismatch" => (
            "omp_route_mismatch",
            "The OMP worker did not confirm the selected route.",
            StatusCode::BAD_GATEWAY,
        ),
        _ => (
            "omp_failed",
            "The OMP route test failed. Try again.",
            StatusCode::BAD_GATEWAY,
        ),
    };
    error_response(error_code, message, status)
}

/// A refused `/validate-key` check. The error code stays
/// `provider_key_not_verified`; `reason` names the worker's classification.
pub(super) fn key_check_failure(code: &str) -> Response {
    let (reason, message, status) = match code {
        "api_key_rejected" => (
            "api_key_rejected",
            "The provider rejected this API key. Check it and try again.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "invalid_api_key" => (
            "invalid_api_key",
            "This is not a valid API key for this provider.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "unsupported_auth_method" => (
            "unsupported_auth_method",
            "This provider cannot be added with an API key.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "invalid_custom_endpoint" => (
            "invalid_custom_endpoint",
            "Kordi Cloud cannot reach this endpoint. Use a public HTTPS address.",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        "provider_unavailable" => (
            "provider_unavailable",
            "The provider could not be reached. Try again shortly.",
            StatusCode::BAD_GATEWAY,
        ),
        "invalid_request" | "request_too_large" => (
            "invalid_request",
            "Enter a provider and an API key of at most 16 KB.",
            StatusCode::BAD_REQUEST,
        ),
        _ => (
            "unknown",
            "OMP could not verify this provider key.",
            StatusCode::BAD_GATEWAY,
        ),
    };
    (
        status,
        Json(json!({
            "errorCode": "provider_key_not_verified",
            "message": message,
            "reason": reason,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn route_test_codes_map_to_fixed_client_errors() {
        for (code, status, error_code) in [
            ("unsupported_model", 422, "unsupported_model"),
            ("invalid_custom_endpoint", 422, "invalid_custom_endpoint"),
            ("credential_expired", 422, "account_needs_reconnect"),
            ("credential_missing", 422, "account_needs_reconnect"),
            ("provider_rejected", 502, "provider_rejected"),
            ("route_mismatch", 502, "omp_route_mismatch"),
            ("route_test_failed", 502, "omp_failed"),
            ("unknown", 502, "omp_failed"),
        ] {
            let (actual, body) = body(route_test_failure(code)).await;
            assert_eq!(actual.as_u16(), status, "{code}");
            assert_eq!(body["errorCode"], error_code, "{code}");
        }
    }

    #[tokio::test]
    async fn key_check_codes_keep_one_error_code_and_name_the_reason() {
        for (code, status, reason) in [
            ("api_key_rejected", 422, "api_key_rejected"),
            ("invalid_api_key", 422, "invalid_api_key"),
            ("unsupported_auth_method", 422, "unsupported_auth_method"),
            ("invalid_custom_endpoint", 422, "invalid_custom_endpoint"),
            ("provider_unavailable", 502, "provider_unavailable"),
            ("request_too_large", 400, "invalid_request"),
            ("unauthorized", 502, "unknown"),
        ] {
            let (actual, body) = body(key_check_failure(code)).await;
            assert_eq!(actual.as_u16(), status, "{code}");
            assert_eq!(body["errorCode"], "provider_key_not_verified", "{code}");
            assert_eq!(body["reason"], reason, "{code}");
        }
    }
}
