use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct ErrorBody<'a> {
    #[serde(rename = "errorCode")]
    error_code: &'a str,
    message: &'a str,
}

pub(super) fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(ErrorBody {
            error_code: code,
            message,
        }),
    )
        .into_response()
}

pub(super) fn boxed_err(code: &str, message: &str, status: StatusCode) -> Box<Response> {
    Box::new(err(code, message, status))
}
