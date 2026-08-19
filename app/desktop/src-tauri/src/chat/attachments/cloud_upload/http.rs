use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::DesktopCloudAttachmentUploadResult;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MultipartInitiateResponse {
    pub(super) attachment_id: String,
    pub(super) chunk_size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MultipartPart {
    pub(super) part_number: u32,
    pub(super) size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MultipartStatusResponse {
    pub(super) attachment_id: String,
    pub(super) status: String,
    pub(super) chunk_size_bytes: u64,
    pub(super) total_size_bytes: u64,
    pub(super) uploaded_bytes: u64,
    pub(super) uploaded_parts: Vec<MultipartPart>,
    object_key: String,
    content_type: Option<String>,
    sha256_hex: Option<String>,
    finalized_at: Option<String>,
}

impl MultipartStatusResponse {
    pub(super) fn completed_result(self) -> Option<DesktopCloudAttachmentUploadResult> {
        (self.status == "completed").then_some(DesktopCloudAttachmentUploadResult {
            attachment_id: self.attachment_id,
            object_key: self.object_key,
            size_bytes: i64::try_from(self.total_size_bytes).ok(),
            content_type: self.content_type,
            sha256_hex: self.sha256_hex,
            finalized_at: self.finalized_at,
        })
    }
}

#[derive(Debug)]
pub(super) struct UploadedPart {
    pub(super) size_bytes: u64,
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(10 * 60))
            .build()
            .expect("build attachment upload client")
    })
}

async fn response_error(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let body = response.json::<serde_json::Value>().await.ok();
    body.as_ref()
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{fallback} ({status})"))
}

pub(super) async fn load_server_status(
    base_url: &str,
    token: &str,
    attachment_id: &str,
    cancel: &CancellationToken,
) -> Result<Option<MultipartStatusResponse>, String> {
    let request = http_client()
        .get(format!(
            "{base_url}/v1/cloud/attachments/{attachment_id}/multipart"
        ))
        .bearer_auth(token)
        .send();
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("Upload cancelled.".to_string()),
        response = request => response.map_err(|error| format!("Unable to resume attachment upload: {error}"))?,
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(response_error(response, "Unable to resume attachment upload").await);
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|error| format!("Invalid attachment upload status: {error}"))
}

pub(super) async fn initiate_upload(
    base_url: &str,
    token: &str,
    size_bytes: u64,
    content_type: Option<&str>,
    cancel: &CancellationToken,
) -> Result<MultipartInitiateResponse, String> {
    let request = http_client()
        .post(format!(
            "{base_url}/v1/cloud/attachments/multipart/initiate"
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "sizeBytes": size_bytes,
            "contentType": content_type,
        }))
        .send();
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("Upload cancelled.".to_string()),
        response = request => response.map_err(|error| format!("Unable to start attachment upload: {error}"))?,
    };
    if !response.status().is_success() {
        return Err(response_error(response, "Unable to start attachment upload").await);
    }
    response
        .json()
        .await
        .map_err(|error| format!("Invalid attachment upload response: {error}"))
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(super) async fn upload_part(
    base_url: String,
    token: String,
    attachment_id: String,
    part_number: u32,
    bytes: bytes::Bytes,
    cancel: CancellationToken,
) -> Result<UploadedPart, String> {
    let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let mut last_error = "Unable to upload attachment part.".to_string();
    for attempt in 0..3 {
        if cancel.is_cancelled() {
            return Err("Upload cancelled.".to_string());
        }
        let request = http_client()
            .put(format!(
                "{base_url}/v1/cloud/attachments/{attachment_id}/parts/{part_number}"
            ))
            .bearer_auth(&token)
            .body(bytes.clone())
            .send();
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err("Upload cancelled.".to_string()),
            response = request => response,
        };
        match response {
            Ok(response) if response.status().is_success() => {
                return Ok(UploadedPart { size_bytes });
            }
            Ok(response) => {
                let retryable = retryable_status(response.status());
                last_error = response_error(response, "Unable to upload attachment part").await;
                if !retryable {
                    return Err(last_error);
                }
            }
            Err(error) => last_error = format!("Unable to upload attachment part: {error}"),
        }
        if attempt < 2 {
            let delay = tokio::time::sleep(Duration::from_millis(250 * (1 << attempt)));
            tokio::select! {
                _ = cancel.cancelled() => return Err("Upload cancelled.".to_string()),
                _ = delay => {}
            }
        }
    }
    Err(last_error)
}

pub(super) async fn complete_upload(
    base_url: &str,
    token: &str,
    attachment_id: &str,
    sha256_hex: &str,
    cancel: &CancellationToken,
) -> Result<DesktopCloudAttachmentUploadResult, String> {
    let request = http_client()
        .post(format!(
            "{base_url}/v1/cloud/attachments/{attachment_id}/multipart"
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({ "sha256Hex": sha256_hex }))
        .send();
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err("Upload cancelled.".to_string()),
        response = request => response.map_err(|error| format!("Unable to finish attachment upload: {error}"))?,
    };
    if !response.status().is_success() {
        return Err(response_error(response, "Unable to finish attachment upload").await);
    }
    response
        .json()
        .await
        .map_err(|error| format!("Invalid attachment completion response: {error}"))
}

pub(super) async fn cancel_server_upload(base_url: &str, token: &str, attachment_id: &str) {
    let _ = http_client()
        .delete(format!(
            "{base_url}/v1/cloud/attachments/{attachment_id}/multipart"
        ))
        .bearer_auth(token)
        .send()
        .await;
}
