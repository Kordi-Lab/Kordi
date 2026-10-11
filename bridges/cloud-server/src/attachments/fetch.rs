//! Bounded in-memory reads of attachment bytes for server-side rendering.

use axum::http::StatusCode;
use axum::response::Response;
use futures_util::StreamExt;

use super::presign_download_url;
use super::response::err;
use super::routes::s3_or_503;
use crate::server::ServerState;

/// Fetches the object at `object_key` from private object storage. Answers
/// `413 document_too_large` when it is larger than `max_bytes`, `503` when
/// storage is not configured, and `502` when storage fails.
pub(crate) async fn fetch_attachment_bytes(
    state: &ServerState,
    object_key: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, Response> {
    let s3 = s3_or_503(state).map_err(|response| *response)?;
    let url = presign_download_url(s3, object_key).map_err(|error| {
        eprintln!("[attachments] presign fetch: {error}");
        err(
            "server_error",
            "Could not sign download URL.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    let bad_gateway = || {
        err(
            "server_error",
            "Could not download attachment.",
            StatusCode::BAD_GATEWAY,
        )
    };
    let response = reqwest::Client::new()
        .get(url.to_string())
        .send()
        .await
        .map_err(|error| {
            eprintln!("[attachments] fetch request failed: {error}");
            bad_gateway()
        })?;
    if !response.status().is_success() {
        eprintln!("[attachments] fetch failed: {}", response.status());
        return Err(bad_gateway());
    }
    let too_large = || {
        err(
            "document_too_large",
            "This document is too large to open.",
            StatusCode::PAYLOAD_TOO_LARGE,
        )
    };
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            eprintln!("[attachments] fetch body failed: {error}");
            bad_gateway()
        })?;
        if bytes.len() + chunk.len() > max_bytes {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
