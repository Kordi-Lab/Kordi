//! Resumable part uploads on GCS without S3 multipart support.
//!
//! Each part is stored as its own temporary object under
//! `multipart-uploads/<upload id>/`. Completion composes the parts, in order
//! and pinned to the generations recorded when they were stored, into the
//! final object, then removes the temporary objects. Parts may arrive in any
//! order and be retried, matching the S3 multipart contract.

use bytes::Bytes;

use super::gcs::{GcsBucket, MAX_COMPOSE_SOURCES};
use super::ObjectStoreError;

const UPLOAD_PREFIX: &str = "multipart-uploads";
const UPLOAD_ID_PREFIX: &str = "gcs";

pub(super) fn new_upload_id() -> String {
    format!("{UPLOAD_ID_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

fn upload_prefix(upload_id: &str) -> Result<String, ObjectStoreError> {
    let valid = upload_id.len() <= 64
        && upload_id.starts_with(UPLOAD_ID_PREFIX)
        && upload_id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    if !valid {
        return Err(ObjectStoreError::NotFound);
    }
    Ok(format!("{UPLOAD_PREFIX}/{upload_id}/"))
}

fn part_name(prefix: &str, part_number: usize) -> String {
    format!("{prefix}part-{part_number:05}")
}

pub(super) async fn upload_part(
    bucket: &GcsBucket,
    upload_id: &str,
    part_number: u16,
    body: Bytes,
) -> Result<String, ObjectStoreError> {
    if part_number == 0 {
        return Err(ObjectStoreError::Unavailable);
    }
    let prefix = upload_prefix(upload_id)?;
    bucket
        .put(
            &part_name(&prefix, usize::from(part_number)),
            Some("application/octet-stream"),
            body,
        )
        .await
}

pub(super) async fn complete(
    bucket: &GcsBucket,
    key: &str,
    upload_id: &str,
    generations: &[String],
    content_type: Option<&str>,
) -> Result<(), ObjectStoreError> {
    let prefix = upload_prefix(upload_id)?;
    if generations.is_empty() {
        return Err(ObjectStoreError::Unavailable);
    }
    let mut level: Vec<(String, Option<String>)> = generations
        .iter()
        .enumerate()
        .map(|(index, generation)| (part_name(&prefix, index + 1), Some(generation.clone())))
        .collect();
    let mut round = 0;
    while level.len() > MAX_COMPOSE_SOURCES {
        let mut next = Vec::with_capacity(level.len().div_ceil(MAX_COMPOSE_SOURCES));
        for (index, group) in level.chunks(MAX_COMPOSE_SOURCES).enumerate() {
            let name = format!("{prefix}compose-{round}-{index:04}");
            let generation = bucket
                .compose(&name, group, Some("application/octet-stream"))
                .await?;
            next.push((name, Some(generation)));
        }
        level = next;
        round += 1;
    }
    bucket.compose(key, &level, content_type).await?;
    if remove_prefix(bucket, &prefix).await.is_err() {
        eprintln!("[object-storage] could not remove temporary upload parts");
    }
    Ok(())
}

pub(super) async fn abort(bucket: &GcsBucket, upload_id: &str) -> Result<(), ObjectStoreError> {
    match upload_prefix(upload_id) {
        Ok(prefix) => remove_prefix(bucket, &prefix).await,
        // Uploads started on another backend leave nothing in this bucket.
        Err(_) => Ok(()),
    }
}

async fn remove_prefix(bucket: &GcsBucket, prefix: &str) -> Result<(), ObjectStoreError> {
    for name in bucket.list(prefix).await? {
        bucket.delete(&name).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{new_upload_id, part_name, upload_prefix};

    #[test]
    fn upload_ids_stay_inside_the_upload_prefix() {
        let id = new_upload_id();
        let prefix = upload_prefix(&id).unwrap();
        assert_eq!(prefix, format!("multipart-uploads/{id}/"));
        assert_eq!(
            part_name(&prefix, 3),
            format!("multipart-uploads/{id}/part-00003")
        );
        assert!(upload_prefix("gcs../escape").is_err());
        assert!(upload_prefix("s3-upload-id").is_err());
    }
}
