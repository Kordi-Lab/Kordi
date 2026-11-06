//! Block and report routes: `/v1/cloud/blocks` and `/v1/cloud/reports`.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Extension, Json, Router};
use serde::Serialize;

use super::block_routes::{block_account, block_account_for, list_blocks, unblock_account};
use super::reports::{self, CreateReportRequest, ReportError, ReportReceipt};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision, REPORT_SUBMIT_LIMIT};
use crate::auth::routes::{cloud_session_middleware, err, write_audit, CloudSession};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>, rate_limiter: Arc<CloudRateLimiter>) -> Router {
    Router::new()
        .route("/v1/cloud/blocks", get(list_blocks))
        .route(
            "/v1/cloud/blocks/:account_id",
            put(block_account).delete(unblock_account),
        )
        .route("/v1/cloud/reports", get(list_reports).post(create_report))
        .layer(Extension(rate_limiter))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

fn server_error(context: &str, error: &sqlx_core::Error) -> Response {
    // Database errors can quote row values, so only their code is logged.
    let code = error
        .as_database_error()
        .and_then(|error| error.code().map(|code| code.into_owned()));
    eprintln!("[safety] {context} failed (database code {code:?})");
    err(
        "server_error",
        "Couldn't send your report. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn report_error(failure: ReportError) -> Response {
    match failure {
        ReportError::Invalid(message) => err("invalid_report", message, StatusCode::BAD_REQUEST),
        ReportError::InvalidEvidence(message) => {
            err("invalid_report_evidence", message, StatusCode::BAD_REQUEST)
        }
        ReportError::Conflict => err(
            "report_conflict",
            "This report was already sent with different details.",
            StatusCode::CONFLICT,
        ),
        ReportError::AccountMissing => err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        ),
        ReportError::SelfReport => err(
            "self_report",
            "You can't report yourself.",
            StatusCode::BAD_REQUEST,
        ),
        ReportError::TooLarge => err(
            "report_too_large",
            "The selected messages are too large to send together. Choose fewer messages.",
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        ReportError::Database(database) => server_error("store report", &database),
    }
}

#[derive(Serialize)]
struct ReportResponse {
    report: ReportReceipt,
    /// Whether the reported account is blocked after this request, when the
    /// report asked for a block.
    blocked: bool,
}

#[derive(Serialize)]
struct ReportListResponse {
    reports: Vec<ReportReceipt>,
}

/// `POST /v1/cloud/reports`. Validation runs first, then the idempotency
/// lookup, so replaying a report that was already received never spends the
/// rate limit; then the rate limit, then the evidence checks. The reported
/// account is never told.
async fn create_report(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    body: Result<Json<CreateReportRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return err(
            "invalid_report",
            "The report could not be read.",
            StatusCode::BAD_REQUEST,
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
            return Json(ReportResponse {
                report: receipt,
                blocked: report.also_block,
            })
            .into_response();
        }
        Ok(Some(_)) => return report_error(ReportError::Conflict),
        Ok(None) => {}
        Err(error) => return server_error("find report", &error),
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(REPORT_SUBMIT_LIMIT, &session.account_id)
        .await
    {
        let mut response = err(
            "rate_limited",
            "You've sent a lot of reports recently. Try again later.",
            StatusCode::TOO_MANY_REQUESTS,
        );
        if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
            response.headers_mut().insert("Retry-After", value);
        }
        return response;
    }
    let stored = match reports::create(state.db_pool(), &session.account_id, &report).await {
        Ok(stored) => stored,
        Err(error) => return report_error(error),
    };
    if stored.created {
        let _ = write_audit(
            state.db_pool(),
            Some(&session.account_id),
            Some(&session.device_id),
            "safety.report.created",
            serde_json::json!({
                "report_id": stored.receipt.report_id,
                "reason": stored.receipt.reason,
                "target_kind": stored.receipt.target_kind,
            }),
        )
        .await;
        super::notify::deliver_soon(&state, stored.receipt.report_id.clone());
    }
    let mut blocked = report.also_block && !stored.created;
    if let (true, Some(reported)) = (report.also_block, stored.reported_account_id.as_deref()) {
        blocked = block_account_for(&state, &session, reported).await.is_ok();
    }
    let status = if stored.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (
        status,
        Json(ReportResponse {
            report: stored.receipt,
            blocked,
        }),
    )
        .into_response()
}

/// `GET /v1/cloud/reports`: the caller's own reports, without evidence or
/// how they were resolved.
async fn list_reports(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match reports::list(state.db_pool(), &session.account_id).await {
        Ok(reports) => Json(ReportListResponse { reports }).into_response(),
        Err(error) => server_error("list reports", &error),
    }
}
