use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Extension;

use super::access::attachment_access_row;
use super::response::err;
use super::{presign_download_url, routes::s3_or_503};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// Streams attachment bytes through the authenticated Cloud API while keeping
/// object storage private and preserving HTTP range requests for media.
pub async fn content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    request_headers: HeaderMap,
) -> Response {
    stream_attachment_content(&state, &session, &attachment_id, &request_headers).await
}

pub(super) async fn stream_attachment_content(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
    request_headers: &HeaderMap,
) -> Response {
    let s3 = match s3_or_503(state) {
        Ok(value) => value,
        Err(resp) => return *resp,
    };

    let (object_key, _, _, content_type, detected_content_type, size_bytes, _) =
        match attachment_access_row(state, session, attachment_id).await {
            Ok(value) => value,
            Err(resp) => return *resp,
        };

    let url = match presign_download_url(s3, &object_key) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[attachments] presign content download: {error}");
            return err(
                "server_error",
                "Could not sign download URL.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let mut object_request = reqwest::Client::new().get(url.to_string());
    if let Some(value) = request_headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        object_request = object_request.header(reqwest::header::RANGE, value);
    }
    let object_response = match object_request.send().await {
        Ok(resp)
            if resp.status().is_success()
                || resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE =>
        {
            resp
        }
        Ok(resp) => {
            eprintln!("[attachments] content fetch failed: {}", resp.status());
            return err(
                "server_error",
                "Could not download attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
        Err(error) => {
            eprintln!("[attachments] content fetch request failed: {error}");
            return err(
                "server_error",
                "Could not download attachment.",
                StatusCode::BAD_GATEWAY,
            );
        }
    };

    let object_content_type = object_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let object_content_length = object_response.content_length();
    let object_status = object_response.status();

    let mut headers = HeaderMap::new();
    if let Some(value) = detected_content_type
        .as_deref()
        .or(object_content_type.as_deref())
        .or(content_type.as_deref())
    {
        if let Ok(header_value) = HeaderValue::from_str(value) {
            headers.insert(header::CONTENT_TYPE, header_value);
        }
    }
    let length =
        object_content_length.or_else(|| size_bytes.and_then(|value| u64::try_from(value).ok()));
    if let Some(length) = length {
        if let Ok(header_value) = HeaderValue::from_str(&length.to_string()) {
            headers.insert(header::CONTENT_LENGTH, header_value);
        }
    }
    for name in [header::ACCEPT_RANGES, header::CONTENT_RANGE] {
        if let Some(value) = object_response.headers().get(name.as_str()) {
            if let Ok(value) = HeaderValue::from_bytes(value.as_bytes()) {
                headers.insert(name, value);
            }
        }
    }
    let mut response = Response::new(Body::from_stream(object_response.bytes_stream()));
    *response.status_mut() =
        StatusCode::from_u16(object_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    *response.headers_mut() = headers;
    response
}
