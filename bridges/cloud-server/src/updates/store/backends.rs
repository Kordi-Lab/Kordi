//! Response checks shared by the release store backends, and the Google Cloud
//! Storage backend. Both backends apply the same strict length and range
//! validation, so a release download behaves identically on either store.

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;

use super::{
    collect_bounded_metadata, ReleaseByteRange, ReleaseObjectStream, ReleaseStoreBackend,
    ReleaseStoreError,
};
use crate::object_storage::{GcsBucket, ObjectStoreError};

type Sent = Result<reqwest::Response, reqwest::Error>;

pub(super) fn range_header(range: ReleaseByteRange) -> String {
    format!("bytes={}-{}", range.start, range.end_inclusive)
}

fn received(response: Sent) -> Result<reqwest::Response, ReleaseStoreError> {
    let response = response.map_err(|_| ReleaseStoreError::Unavailable)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ReleaseStoreError::NotFound);
    }
    Ok(response)
}

pub(super) async fn metadata_from_response(
    response: Sent,
    max_bytes: usize,
) -> Result<Bytes, ReleaseStoreError> {
    let response = received(response)?;
    if !response.status().is_success() {
        return Err(ReleaseStoreError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(ReleaseStoreError::MetadataTooLarge);
    }
    collect_bounded_metadata(
        response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|_| ReleaseStoreError::Unavailable)),
        max_bytes,
    )
    .await
}

pub(super) fn size_from_head_response(response: Sent) -> Result<u64, ReleaseStoreError> {
    let response = received(response)?;
    if !response.status().is_success() {
        return Err(ReleaseStoreError::Unavailable);
    }
    let content_lengths = response.headers().get_all(reqwest::header::CONTENT_LENGTH);
    let mut values = content_lengths.iter();
    let value = values.next().ok_or(ReleaseStoreError::Unavailable)?;
    if values.next().is_some() {
        return Err(ReleaseStoreError::Unavailable);
    }
    let value = value.to_str().map_err(|_| ReleaseStoreError::Unavailable)?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ReleaseStoreError::Unavailable);
    }
    value.parse().map_err(|_| ReleaseStoreError::Unavailable)
}

pub(super) fn stream_from_response(
    response: Sent,
    byte_range: Option<ReleaseByteRange>,
) -> Result<ReleaseObjectStream, ReleaseStoreError> {
    let response = received(response)?;
    let expected_status = if byte_range.is_some() {
        reqwest::StatusCode::PARTIAL_CONTENT
    } else {
        reqwest::StatusCode::OK
    };
    if response.status() != expected_status {
        return Err(ReleaseStoreError::Unavailable);
    }
    if let Some(range) = byte_range {
        let expected = format!(
            "bytes {}-{}/{}",
            range.start, range.end_inclusive, range.complete_length
        );
        if response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            != Some(expected.as_str())
        {
            return Err(ReleaseStoreError::Unavailable);
        }
    }
    let size_bytes = response
        .content_length()
        .ok_or(ReleaseStoreError::Unavailable)?;
    let body = response
        .bytes_stream()
        .map(|chunk| chunk.map_err(|_| ReleaseStoreError::Unavailable));
    Ok(ReleaseObjectStream {
        size_bytes,
        body: Box::pin(body),
    })
}

fn store_error(error: ObjectStoreError) -> ReleaseStoreError {
    match error {
        ObjectStoreError::NotFound => ReleaseStoreError::NotFound,
        ObjectStoreError::PreconditionFailed | ObjectStoreError::Unavailable => {
            ReleaseStoreError::Unavailable
        }
    }
}

/// Reads desktop releases from a private GCS bucket with the instance identity.
#[derive(Debug, Clone)]
pub struct GcsReleaseStore {
    bucket: GcsBucket,
}

impl GcsReleaseStore {
    pub fn new(bucket: GcsBucket) -> Self {
        Self { bucket }
    }
}

#[async_trait]
impl ReleaseStoreBackend for GcsReleaseStore {
    async fn get_metadata(&self, key: &str, max_bytes: usize) -> Result<Bytes, ReleaseStoreError> {
        let response = self.bucket.get(key, None).await.map_err(store_error)?;
        metadata_from_response(Ok(response), max_bytes).await
    }

    async fn head_object(&self, key: &str) -> Result<u64, ReleaseStoreError> {
        self.bucket.size(key).await.map_err(store_error)
    }

    async fn stream_object(
        &self,
        key: &str,
        byte_range: Option<ReleaseByteRange>,
    ) -> Result<ReleaseObjectStream, ReleaseStoreError> {
        let range = byte_range.map(range_header);
        let response = self
            .bucket
            .get(key, range.as_deref())
            .await
            .map_err(store_error)?;
        stream_from_response(Ok(response), byte_range)
    }
}
