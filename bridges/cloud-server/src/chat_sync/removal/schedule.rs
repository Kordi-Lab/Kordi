//! When the worker runs, and whether the server reports content removal.

use std::sync::Arc;

use super::*;
use crate::server::ServerState;

const TICK: Duration = Duration::from_secs(10);
const JOBS_PER_TICK: i64 = 20;
/// Every 10 minutes: repair deletes and hides written by an older replica.
const RECONCILE_EVERY_TICKS: u64 = 60;
const RECONCILE_WINDOW_DAYS: i64 = 2;
/// Every hour: re-check retained files and re-probe object storage.
const RECHECK_EVERY_TICKS: u64 = 360;
const RECHECK_LIMIT: i64 = 500;
pub const BUCKET_ATTESTATION_ENV: &str = "KORDI_ATTACHMENT_BUCKET_UNVERSIONED";

/// Whether the server may tell clients that it deletes stored copies and
/// files: object storage is configured, an operator has attested that the
/// bucket keeps no earlier versions, and a deletion probe succeeded.
pub fn readiness(object_store_configured: bool, attested: bool, probe_succeeded: bool) -> bool {
    object_store_configured && attested && probe_succeeded
}

/// Whether the bucket attestation is set to exactly `1`.
pub fn bucket_attested(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

/// Deletes a random key that does not exist. Success shows that the
/// credentials may delete objects in the bucket.
pub async fn probe_object_store(objects: &dyn ObjectStoreDeleter) -> Result<(), ObjectDeleteError> {
    objects
        .delete_object(&format!("content-removal-probe/{}", Uuid::new_v4()))
        .await
}

async fn refresh_readiness(objects: Option<&dyn ObjectStoreDeleter>) {
    let attested = bucket_attested(std::env::var(BUCKET_ATTESTATION_ENV).ok().as_deref());
    let probe = match objects {
        Some(objects) => Some(probe_object_store(objects).await),
        None => None,
    };
    let ready = readiness(objects.is_some(), attested, matches!(probe, Some(Ok(()))));
    crate::chat_sync::set_content_removal_ready(ready);
    let probe = match probe {
        None => "skipped".to_string(),
        Some(Ok(())) => "ok".to_string(),
        Some(Err(error)) => format!("error:{}", error.code()),
    };
    eprintln!(
        "[content-removal] readiness object_store={} attested={attested} probe={probe} ready={ready}",
        objects.is_some()
    );
}

/// Starts the removal worker. Without object storage it still redacts
/// records, digests, and previews; file steps wait with
/// `object_store_unavailable` until storage is configured.
pub fn spawn_removal_worker(state: Arc<ServerState>) {
    let deleter = state
        .s3()
        .cloned()
        .map(crate::attachments::S3ObjectDeleter::new);
    tokio::spawn(async move {
        let pool = state.db_pool();
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut tick: u64 = 0;
        loop {
            interval.tick().await;
            let objects = deleter
                .as_ref()
                .map(|deleter| deleter as &dyn ObjectStoreDeleter);
            if tick.is_multiple_of(RECHECK_EVERY_TICKS)
                && crate::chat_sync::content_removal_version() < 1
            {
                refresh_readiness(objects).await;
            }
            if run_due_jobs(pool, objects, JOBS_PER_TICK).await.is_err() {
                eprintln!("[content-removal] step=lease outcome=error:database_error");
            }
            if tick.is_multiple_of(RECONCILE_EVERY_TICKS) {
                let since = Utc::now() - chrono::Duration::days(RECONCILE_WINDOW_DAYS);
                if store::reconcile_deleted_messages(pool, since, 200)
                    .await
                    .is_err()
                    || store::reconcile_hidden_messages(pool, since, 500)
                        .await
                        .is_err()
                {
                    eprintln!("[content-removal] step=reconcile outcome=error:database_error");
                }
            }
            if tick.is_multiple_of(RECHECK_EVERY_TICKS)
                && recheck_purge_candidates(pool, objects, RECHECK_LIMIT)
                    .await
                    .is_err()
            {
                eprintln!("[content-removal] step=recheck outcome=error:database_error");
            }
            tick = tick.wrapping_add(1);
        }
    });
}
