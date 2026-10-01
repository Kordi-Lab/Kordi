//! `POST /v1/cloud/reports` and `GET /v1/cloud/reports`.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Serialize;

use super::reports::{self, CreateReportRequest, ReportError, ReportReceipt};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision, REPORT_SUBMIT_LIMIT};
use crate::auth::routes::{cloud_session_middleware, write_audit, CloudSession};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>, rate_limiter: Arc<CloudRateLimiter>) -> Router {
    Router::new()
        .route("/v1/cloud/reports", get(list_reports).post(create_report))
        .layer(Extension(rate_limiter))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

#[derive(Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: String,
}

fn error(status: StatusCode, code: &'static str, message: &str) -> Response {
    (
        status,
        Json(ErrorBody {
            error_code: code,
            message: message.to_string(),
        }),
    )
        .into_response()
}

fn server_error(context: &str, error: &sqlx_core::Error) -> Response {
    // Database errors can quote row values, so only their code is logged.
    let code = error
        .as_database_error()
        .and_then(|error| error.code().map(|code| code.into_owned()));
    eprintln!("[safety] {context} failed (database code {code:?})");
    self::error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "server_error",
        "Couldn't send your report. Your selections are kept. Try again.",
    )
}

fn report_error(failure: ReportError) -> Response {
    match failure {
        ReportError::Invalid(message) => error(StatusCode::BAD_REQUEST, "invalid_report", message),
        ReportError::InvalidEvidence(message) => {
            error(StatusCode::BAD_REQUEST, "invalid_report_evidence", message)
        }
        ReportError::Conflict => error(
            StatusCode::CONFLICT,
            "report_conflict",
            "This report was already sent with different details.",
        ),
        ReportError::AccountMissing => error(
            StatusCode::NOT_FOUND,
            "account_missing",
            "No account found with that id.",
        ),
        ReportError::SelfReport => error(
            StatusCode::BAD_REQUEST,
            "self_report",
            "You can't report yourself.",
        ),
        ReportError::TooLarge => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "report_too_large",
            "The selected messages are too large to send together. Choose fewer messages.",
        ),
        ReportError::Database(database) => server_error("store report", &database),
    }
}

#[derive(Serialize)]
struct ReportResponse {
    report: ReportReceipt,
}

#[derive(Serialize)]
struct ReportListResponse {
    reports: Vec<ReportReceipt>,
}

/// Validation runs first, then the idempotency lookup, so replaying a report
/// that was already received never spends the rate limit; then the rate
/// limit, then the evidence checks against the database.
async fn create_report(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    body: Result<Json<CreateReportRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_report",
            "The report could not be read.",
        );
    };
    let report = match reports::validate(request) {
        Ok(report) => report,
        Err(error) => return report_error(error),
    };
    match reports::existing(
        state.db_pool(),
        &session.account_id,
        report.client_report_id,
    )
    .await
    {
        Ok(Some((fingerprint, receipt))) if fingerprint == report.fingerprint => {
            return Json(ReportResponse { report: receipt }).into_response();
        }
        Ok(Some(_)) => return report_error(ReportError::Conflict),
        Ok(None) => {}
        Err(error) => return server_error("find report", &error),
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(REPORT_SUBMIT_LIMIT, &session.account_id)
        .await
    {
        let mut response = error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "You've sent a lot of reports recently. Try again later.",
        );
        if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
            response.headers_mut().insert("Retry-After", value);
        }
        return response;
    }
    match reports::create(state.db_pool(), &session.account_id, &report).await {
        Ok((receipt, created)) => {
            if created {
                let _ = write_audit(
                    state.db_pool(),
                    Some(&session.account_id),
                    Some(&session.device_id),
                    "safety.report.created",
                    serde_json::json!({
                        "report_id": receipt.report_id,
                        "reason": receipt.reason,
                        "target_kind": receipt.target_kind,
                    }),
                )
                .await;
            }
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(ReportResponse { report: receipt })).into_response()
        }
        Err(error) => report_error(error),
    }
}

/// The caller's own reports, without evidence or how they were resolved.
async fn list_reports(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match reports::list(state.db_pool(), &session.account_id).await {
        Ok(reports) => Json(ReportListResponse { reports }).into_response(),
        Err(error) => server_error("list reports", &error),
    }
}
