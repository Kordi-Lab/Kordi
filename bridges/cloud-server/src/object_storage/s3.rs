//! S3-compatible operations (MinIO) through short-lived presigned requests.

use std::sync::OnceLock;
use std::time::Duration;

use bytes::Bytes;
use reqwest::{Response, StatusCode};
use rusty_s3::actions::{CreateMultipartUpload, HeadBucket, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};

use super::ObjectStoreError;
use crate::attachments::{
    presign_abort_multipart_url, presign_complete_multipart, presign_create_multipart_url,
    presign_download_url, presign_head_url, presign_upload_part_url, presign_upload_url, S3Config,
};

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

fn signed<T, E>(value: Result<T, E>) -> Result<T, ObjectStoreError> {
    value.map_err(|_| ObjectStoreError::Unavailable)
}

fn sent(value: Result<Response, reqwest::Error>) -> Result<Response, ObjectStoreError> {
    value.map_err(|_| ObjectStoreError::Unavailable)
}

fn status(response: &Response) -> Result<(), ObjectStoreError> {
    match response.status() {
        value if value.is_success() => Ok(()),
        StatusCode::NOT_FOUND => Err(ObjectStoreError::NotFound),
        StatusCode::PRECONDITION_FAILED => Err(ObjectStoreError::PreconditionFailed),
        _ => Err(ObjectStoreError::Unavailable),
    }
}

pub(super) async fn put(
    config: &S3Config,
    key: &str,
    content_type: Option<&str>,
    body: Bytes,
) -> Result<(), ObjectStoreError> {
    let url = signed(presign_upload_url(config, key))?;
    let mut request = client().put(url.to_string()).body(body);
    if let Some(value) = content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, value);
    }
    status(&sent(request.send().await)?)
}

pub(super) async fn get(
    config: &S3Config,
    key: &str,
    range: Option<&str>,
) -> Result<Response, ObjectStoreError> {
    let url = signed(presign_download_url(config, key))?;
    let mut request = client().get(url.to_string());
    if let Some(value) = range {
        request = request.header(reqwest::header::RANGE, value);
    }
    sent(request.send().await)
}

pub(super) async fn size(config: &S3Config, key: &str) -> Result<u64, ObjectStoreError> {
    let url = signed(presign_head_url(config, key))?;
    let response = sent(client().head(url).send().await)?;
    status(&response)?;
    response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or(ObjectStoreError::Unavailable)
}

pub(super) async fn delete(config: &S3Config, key: &str) -> Result<(), ObjectStoreError> {
    let bucket = signed(config_bucket(config))?;
    let credentials = Credentials::new(config.access_key.clone(), config.secret_key.clone());
    let url = rusty_s3::actions::DeleteObject::new(&bucket, Some(&credentials), key)
        .sign(crate::attachments::PRESIGNED_URL_TTL);
    match status(&sent(client().delete(url).send().await)?) {
        Ok(()) | Err(ObjectStoreError::NotFound) => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) async fn create_multipart(
    config: &S3Config,
    key: &str,
) -> Result<String, ObjectStoreError> {
    let url = signed(presign_create_multipart_url(config, key))?;
    let response = sent(client().post(url).send().await)?;
    status(&response)?;
    let body = response
        .bytes()
        .await
        .map_err(|_| ObjectStoreError::Unavailable)?;
    CreateMultipartUpload::parse_response(&body)
        .map(|value| value.upload_id().to_string())
        .map_err(|_| ObjectStoreError::Unavailable)
}

pub(super) async fn upload_part(
    config: &S3Config,
    key: &str,
    upload_id: &str,
    part_number: u16,
    body: Bytes,
) -> Result<String, ObjectStoreError> {
    let url = signed(presign_upload_part_url(config, key, part_number, upload_id))?;
    let response = sent(client().put(url).body(body).send().await)?;
    status(&response)?;
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
        .ok_or(ObjectStoreError::Unavailable)
}

pub(super) async fn complete_multipart(
    config: &S3Config,
    key: &str,
    upload_id: &str,
    etags: &[String],
) -> Result<(), ObjectStoreError> {
    let (url, body) = signed(presign_complete_multipart(config, key, upload_id, etags))?;
    let response = client()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/xml")
        .body(body)
        .send()
        .await;
    status(&sent(response)?)
}

pub(super) async fn abort_multipart(
    config: &S3Config,
    key: &str,
    upload_id: &str,
) -> Result<(), ObjectStoreError> {
    let url = signed(presign_abort_multipart_url(config, key, upload_id))?;
    match status(&sent(client().delete(url).send().await)?) {
        Ok(()) | Err(ObjectStoreError::NotFound) => Ok(()),
        Err(error) => Err(error),
    }
}

fn config_bucket(config: &S3Config) -> Result<Bucket, rusty_s3::BucketError> {
    Bucket::new(
        config.endpoint.clone(),
        UrlStyle::Path,
        config.bucket.clone(),
        config.region.clone(),
    )
}

pub(super) async fn ready(config: &S3Config, timeout: Duration) -> bool {
    let Ok(bucket) = config_bucket(config) else {
        return false;
    };
    let credentials = Credentials::new(config.access_key.clone(), config.secret_key.clone());
    let url = HeadBucket::new(&bucket, Some(&credentials)).sign(Duration::from_secs(30));
    // Do not follow redirects with signed requests or log their URLs.
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
    else {
        return false;
    };
    client
        .head(url)
        .send()
        .await
        .is_ok_and(|reply| reply.status().is_success())
}
