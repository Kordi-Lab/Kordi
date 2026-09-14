//! Backpressure for synchronous canonical database work.

use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

// SQLite has one writer. Keep a small number of readers available without
// letting sync bursts occupy dozens of blocking threads waiting on its locks.
const MAX_DATABASE_JOBS: usize = 4;

pub(super) async fn run<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let slots = SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(MAX_DATABASE_JOBS)))
        .clone();
    run_with_slots(slots, task).await
}

async fn run_with_slots<T>(
    slots: Arc<Semaphore>,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let permit = slots
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        // A cancelled caller must not release capacity while its blocking
        // database operation is still running.
        let _permit = permit;
        task()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_keeps_capacity_until_the_database_job_finishes() {
        let slots = Arc::new(Semaphore::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let task_slots = slots.clone();
        let caller = tokio::spawn(run_with_slots(task_slots, move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        assert!(slots.try_acquire().is_err());
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(slots.try_acquire().is_err());
        finish_tx.send(()).unwrap();
        let permit = tokio::time::timeout(std::time::Duration::from_secs(5), slots.acquire())
            .await
            .expect("finished job releases its permit")
            .unwrap();
        drop(permit);
    }

    #[tokio::test]
    async fn failed_jobs_release_capacity_and_preserve_errors() {
        let slots = Arc::new(Semaphore::new(1));
        let result =
            run_with_slots(slots.clone(), || Err::<(), _>("database failure".into())).await;
        assert_eq!(result.unwrap_err(), "database failure");
        assert_eq!(slots.available_permits(), 1);
        assert_eq!(run_with_slots(slots, || Ok(42)).await.unwrap(), 42);
    }
}
