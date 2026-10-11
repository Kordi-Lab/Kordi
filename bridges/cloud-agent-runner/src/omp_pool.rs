//! Process-wide OMP runtime so pre-warmed workers outlive a single run.

use std::sync::{Mutex, OnceLock};

use kordi_omp_runtime::{OmpRuntime, WorkerCommand};

pub const WARM_WORKERS_ENV: &str = "KORDI_CLOUD_OMP_WARM_WORKERS";
const DEFAULT_WARM_WORKERS: usize = 1;
/// Matches the runner's concurrent run limit.
const MAX_WARM_WORKERS: usize = 4;

/// Unset, blank, or unparsable values keep the default; `0` disables warming.
pub fn warm_workers(value: Option<&str>) -> usize {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .map_or(DEFAULT_WARM_WORKERS, |count| count.min(MAX_WARM_WORKERS))
}

fn configured_warm_workers() -> usize {
    warm_workers(std::env::var(WARM_WORKERS_ENV).ok().as_deref())
}

/// Returns the runtime shared by every run for this worker command. A changed
/// command replaces it and kills the old idle workers.
pub(crate) fn shared_runtime(command: WorkerCommand) -> OmpRuntime {
    static SHARED: OnceLock<Mutex<Option<(WorkerCommand, OmpRuntime)>>> = OnceLock::new();
    let mut shared = SHARED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some((current, runtime)) = shared.as_ref() {
        if current.program == command.program && current.args == command.args {
            return runtime.clone();
        }
        runtime.shutdown();
    }
    let runtime = OmpRuntime::new(command.clone()).with_warm_workers(configured_warm_workers());
    *shared = Some((command, runtime.clone()));
    runtime
}

/// Starts the configured warm workers at runner startup so the first turn
/// does not pay the worker boot cost. A missing worker path is a no-op.
pub fn prewarm() {
    if let Ok(command) = crate::omp_job::worker_command() {
        shared_runtime(command).prewarm();
    }
}

#[cfg(test)]
mod tests {
    use super::warm_workers;

    #[test]
    fn warm_workers_default_to_one() {
        assert_eq!(warm_workers(None), 1);
        assert_eq!(warm_workers(Some("")), 1);
        assert_eq!(warm_workers(Some("  ")), 1);
        assert_eq!(warm_workers(Some("many")), 1);
        assert_eq!(warm_workers(Some("-1")), 1);
    }

    #[test]
    fn warm_workers_override_disables_or_raises_within_cap() {
        assert_eq!(warm_workers(Some("0")), 0);
        assert_eq!(warm_workers(Some(" 2 ")), 2);
        assert_eq!(warm_workers(Some("99")), 4);
    }
}
