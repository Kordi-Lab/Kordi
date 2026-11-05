//! Pool worker mode. A resource pool with `executor: pool_worker` keeps its
//! model credential in the sponsor's own cloud project. The runner binary
//! started with `KORDI_POOL_WORKER_POOL_ID` set leases only that pool's
//! System agent and Grounding runs, authenticates with a workload identity
//! token, calls its own model provider and posts the result back. The control
//! plane never sees the model credential.
//!
//! Settings:
//! - `KORDI_POOL_WORKER_POOL_ID`, `KORDI_POOL_WORKER_CONTROL_PLANE_URL`
//!   (https; http only for loopback), `KORDI_POOL_WORKER_AUDIENCE`.
//! - `KORDI_POOL_WORKER_PROVIDER` (`openai`, `openai-compatible`,
//!   `openrouter`, `vertex-ai`) and `KORDI_POOL_WORKER_MODEL`.
//! - API-key providers: `KORDI_POOL_WORKER_BASE_URL` (https) and one of
//!   `KORDI_POOL_WORKER_MODEL_SECRET` (a Secret Manager version) or
//!   `KORDI_POOL_WORKER_API_KEY_FILE`.
//! - `vertex-ai`: `KORDI_POOL_WORKER_VERTEX_PROJECT` and
//!   `KORDI_POOL_WORKER_VERTEX_LOCATION`; the token comes from the metadata
//!   server.
//! - Optional: `KORDI_POOL_WORKER_ID`, `KORDI_POOL_WORKER_IDENTITY_TOKEN_FILE`
//!   (a projected token re-read on every request instead of the metadata
//!   server), `KORDI_POOL_WORKER_CONCURRENCY` (1-4, default 2) and
//!   `KORDI_POOL_WORKER_POLL_MS` (at least 250, default 2000).
//!
//! Pool workers always use the Rust model engine. Prompts, replies, keys and
//! tokens are never logged.

use std::sync::Arc;
use std::time::Duration;

use crate::model_loop::{CloudModelProvider, OpenAiCompatibleProvider};

mod client;
pub mod config;
mod credentials;
mod identity;
mod run;

pub use config::{PoolWorkerConfig, PoolWorkerConfigError};

use client::{ControlPlane, PoolLease};
use credentials::ModelCredentials;
use identity::IdentityTokenSource;
use run::RunOutcome;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Wait after the pool is stopped, missing, or refuses this identity.
const BACKOFF: Duration = Duration::from_secs(30);

/// Error text never includes tokens, keys, prompts or response bodies.
#[derive(Debug, thiserror::Error)]
pub enum PoolWorkerError {
    #[error("credential error: {0}")]
    Credential(String),
    #[error("control plane error: {0}")]
    Transport(String),
    #[error("control plane returned {status} {code}")]
    Status { status: u16, code: String },
}

/// What one lease attempt found.
#[derive(Debug)]
pub(crate) enum LeaseOutcome {
    Run(PoolLease),
    Idle,
    /// Stopped pool or rejected identity; wait longer before asking again.
    Backoff,
}

pub(crate) struct PoolWorker<P> {
    plane: ControlPlane,
    credentials: ModelCredentials,
    provider: P,
    pool_id: String,
    model: String,
    concurrency: usize,
    poll_interval: Duration,
    heartbeat_interval: Duration,
}

impl<P: CloudModelProvider + Send + Sync + 'static> PoolWorker<P> {
    pub(crate) fn new(config: &PoolWorkerConfig, provider: P) -> Result<Self, PoolWorkerError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| PoolWorkerError::Transport("HTTP client setup failed".into()))?;
        let identity = match &config.identity_token_file {
            Some(path) => IdentityTokenSource::File(path.clone()),
            None => {
                IdentityTokenSource::metadata(http.clone(), &config.metadata_url, &config.audience)
            }
        };
        Ok(Self {
            plane: ControlPlane::new(
                http.clone(),
                &config.control_plane_url,
                &config.pool_id,
                &config.worker_id,
                identity,
            ),
            credentials: ModelCredentials::new(http, config),
            provider,
            pool_id: config.pool_id.clone(),
            model: config.model.clone(),
            concurrency: config.concurrency,
            poll_interval: config.poll_interval,
            heartbeat_interval: run::HEARTBEAT_INTERVAL,
        })
    }

    pub(crate) async fn lease(&self) -> LeaseOutcome {
        match self.plane.lease().await {
            Ok(Some(lease)) => LeaseOutcome::Run(lease),
            Ok(None) => LeaseOutcome::Idle,
            Err(error) => {
                let backoff = matches!(
                    error,
                    PoolWorkerError::Status {
                        status: 401 | 404 | 503,
                        ..
                    }
                );
                tracing::warn!(pool_id = %self.pool_id, error = %error, "pool worker lease failed");
                if backoff {
                    LeaseOutcome::Backoff
                } else {
                    LeaseOutcome::Idle
                }
            }
        }
    }

    pub(crate) async fn process(&self, lease: PoolLease) -> RunOutcome {
        if !is_path_segment(&lease.run_id) || lease.lease_token.is_empty() {
            tracing::warn!(pool_id = %self.pool_id, "pool worker skipped a malformed lease");
            return RunOutcome::Abandoned;
        }
        run::process(self, lease).await
    }

    /// Leases and runs up to `concurrency` runs at once, forever.
    pub(crate) async fn run(self: Arc<Self>) -> ! {
        let mut workers = tokio::task::JoinSet::new();
        let mut next_poll = tokio::time::Instant::now();
        loop {
            tokio::select! {
                Some(result) = workers.join_next(), if !workers.is_empty() => {
                    if result.is_err() {
                        tracing::warn!(pool_id = %self.pool_id, "pool worker task failed");
                    }
                },
                _ = tokio::time::sleep_until(next_poll), if workers.len() < self.concurrency => {
                    let now = tokio::time::Instant::now();
                    next_poll = match self.lease().await {
                        LeaseOutcome::Run(lease) => {
                            tracing::info!(pool_id = %self.pool_id, run_id = %lease.run_id, feature = %lease.feature, "pool run leased");
                            let worker = Arc::clone(&self);
                            workers.spawn(async move { worker.process(lease).await });
                            now
                        }
                        LeaseOutcome::Idle => now + self.poll_interval,
                        LeaseOutcome::Backoff => now + BACKOFF,
                    };
                },
            }
        }
    }
}

fn is_path_segment(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && value != "."
        && value != ".."
}

/// Reads `KORDI_POOL_WORKER_*` and runs the pool worker until the process exits.
pub async fn run_from_env() -> anyhow::Result<()> {
    let config = PoolWorkerConfig::from_lookup(|name| std::env::var(name).ok())?;
    tracing::info!(
        pool_id = %config.pool_id,
        worker_id = %config.worker_id,
        provider = config.provider.id(),
        concurrency = config.concurrency,
        "starting kordi pool worker"
    );
    let worker = PoolWorker::new(&config, OpenAiCompatibleProvider::default())?;
    Arc::new(worker).run().await
}

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod test_server;
#[cfg(test)]
mod worker_tests;
