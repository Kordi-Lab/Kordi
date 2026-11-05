//! The live pool set, and reloading it without a restart.
//!
//! Every reader takes a snapshot ([`ResourcePoolRegistry::current`]) and
//! keeps it for one decision, so a reload never changes a pool halfway
//! through an admission. A reload reads the pool file and the organizations
//! file again, validates everything (keys, identities, bindings), resolves
//! configuration ids to organization ids, and only then swaps the snapshot.
//! An invalid file is logged and the previous configuration stays.
//!
//! Reloads happen on `SIGHUP`, within [`WATCH_INTERVAL`] of either file
//! changing, and, while a configured organization does not exist yet, about
//! once a minute so its binding applies once it is created. The emergency
//! stop therefore takes effect within seconds of the file being written.

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgPool;

use super::{config, organizations, ConfiguredBindings, ResourcePoolConfigError, ResourcePools};

/// How often the files are checked for changes.
pub const WATCH_INTERVAL: Duration = Duration::from_secs(5);
/// Checks between retries of configuration ids that did not resolve.
const RESOLVE_EVERY_TICKS: u32 = 12;

type Fingerprint = Vec<Option<(SystemTime, u64)>>;

/// Shared handle to the live pool set. Clones share one snapshot.
#[derive(Clone)]
pub struct ResourcePoolRegistry {
    inner: Arc<Inner>,
}

struct Inner {
    current: RwLock<Arc<ResourcePools>>,
    pool_file: Option<String>,
    organizations_file: Option<String>,
    /// The pools built from environment settings, used when there is no pool
    /// file.
    base: Option<ResourcePools>,
    state: Mutex<ReloadState>,
}

#[derive(Default)]
struct ReloadState {
    fingerprint: Fingerprint,
    unresolved: usize,
}

impl std::fmt::Debug for ResourcePoolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourcePoolRegistry")
            .field("current", &self.current())
            .finish_non_exhaustive()
    }
}

impl ResourcePoolRegistry {
    /// A fixed pool set that never reloads.
    pub fn new(pools: ResourcePools) -> Self {
        Self::build(pools, None, None)
    }

    /// A pool set read from `pool_file` (or built from environment settings
    /// when `None`), with bindings from `organizations_file` once
    /// [`Self::reload`] runs.
    pub fn with_sources(
        pools: ResourcePools,
        pool_file: Option<String>,
        organizations_file: Option<String>,
    ) -> Self {
        Self::build(pools, pool_file, organizations_file)
    }

    /// Sources from `KORDI_RESOURCE_POOLS_FILE` and `KORDI_ORGANIZATIONS_FILE`.
    pub fn from_env_sources(pools: ResourcePools) -> Self {
        Self::build(
            pools,
            config::path_from_env(),
            organizations::path_from_env(),
        )
    }

    fn build(
        pools: ResourcePools,
        pool_file: Option<String>,
        organizations_file: Option<String>,
    ) -> Self {
        let base = pool_file.is_none().then(|| pools.clone());
        let fingerprint = fingerprint(&[pool_file.as_deref(), organizations_file.as_deref()]);
        Self {
            inner: Arc::new(Inner {
                current: RwLock::new(Arc::new(pools)),
                pool_file,
                organizations_file,
                base,
                state: Mutex::new(ReloadState {
                    fingerprint,
                    unresolved: 0,
                }),
            }),
        }
    }

    /// The pool set now. Keep it for one decision; do not cache it.
    pub fn current(&self) -> Arc<ResourcePools> {
        self.inner
            .current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Swaps in `pools` directly, as a reload would.
    #[cfg(test)]
    pub(crate) fn replace(&self, pools: ResourcePools) {
        *self
            .inner
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(pools);
    }

    fn files(&self) -> [Option<&str>; 2] {
        [
            self.inner.pool_file.as_deref(),
            self.inner.organizations_file.as_deref(),
        ]
    }

    /// Whether either file changed since the last load.
    fn changed(&self) -> bool {
        let now = fingerprint(&self.files());
        self.lock_state().fingerprint != now
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ReloadState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads both files again and swaps in the result once it is valid.
    /// On error nothing changes. `get` reads environment variables.
    pub async fn reload_with(
        &self,
        db: &PgPool,
        get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Arc<ResourcePools>, ResourcePoolConfigError> {
        let fingerprint = fingerprint(&self.files());
        let pools = match (&self.inner.pool_file, &self.inner.base) {
            (Some(path), _) => config::load_file(path, get)?,
            (None, Some(base)) => base.clone(),
            (None, None) => (*self.current()).clone(),
        };
        let configured = match &self.inner.organizations_file {
            Some(path) => organizations::load_file(path)?,
            None => ConfiguredBindings::default(),
        };
        configured.validate(&pools)?;
        let (bindings, unresolved) =
            resolve_configuration_ids(db, &configured)
                .await
                .map_err(|_| {
                    ResourcePoolConfigError::new("configured organizations could not be looked up")
                })?;
        let pools = Arc::new(pools.with_bindings(bindings)?);
        *self
            .inner
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = pools.clone();
        let mut state = self.lock_state();
        state.fingerprint = fingerprint;
        state.unresolved = unresolved;
        Ok(pools)
    }

    pub async fn reload(&self, db: &PgPool) -> Result<Arc<ResourcePools>, ResourcePoolConfigError> {
        self.reload_with(db, |key| std::env::var(key).ok()).await
    }

    /// Reloads on `SIGHUP`, when a file changes, and while configured
    /// organizations are missing. Errors are logged; the old pools stay.
    pub fn spawn_watcher(self, db: PgPool) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            if self.files().iter().all(Option::is_none) {
                return;
            }
            let mut hangup = hangup_signal();
            let mut timer = tokio::time::interval(WATCH_INTERVAL);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut ticks: u32 = 0;
            loop {
                let signalled = tokio::select! {
                    _ = timer.tick() => false,
                    _ = next_signal(&mut hangup) => true,
                };
                ticks = ticks.wrapping_add(1);
                let retry =
                    ticks.is_multiple_of(RESOLVE_EVERY_TICKS) && self.lock_state().unresolved > 0;
                if !(signalled || retry || self.changed()) {
                    continue;
                }
                match self.reload(&db).await {
                    Ok(pools) => log_pools("Reloaded resource pools", &pools),
                    Err(error) => {
                        // Remember the files as seen so a broken file is
                        // reported once, not every few seconds.
                        self.lock_state().fingerprint = fingerprint(&self.files());
                        eprintln!(
                            "[resource-pools] Reload rejected; keeping the previous configuration: {error}"
                        );
                    }
                }
            }
        })
    }
}

/// Loads the pools at startup with their organization bindings (which need
/// the database), reports them, and starts watching for changes. An invalid
/// configuration stops startup.
pub async fn start(
    registry: &ResourcePoolRegistry,
    db: &PgPool,
) -> Result<(), ResourcePoolConfigError> {
    let pools = registry.reload(db).await?;
    log_pools("resource pools", &pools);
    if let Err(error) = warn_unknown_organizations(db, &pools).await {
        eprintln!("[resource-pools] Could not check bound organizations: {error}");
    }
    for pool in pools.pools() {
        if pool.executor() == super::Executor::PoolWorker && pool.worker_identity().is_none() {
            eprintln!(
                "[resource-pools] Pool {} accepts no worker: its worker identity is not set",
                pool.id()
            );
        }
    }
    registry.clone().spawn_watcher(db.clone());
    Ok(())
}

/// Prints pool ids and limits only; providers and keys are never printed.
pub fn log_pools(what: &str, pools: &ResourcePools) {
    println!(
        "Kordi {what}: {} (default {})",
        pools
            .pools()
            .iter()
            .map(|pool| pool.summary())
            .collect::<Vec<_>>()
            .join(", "),
        pools.default_pool().id()
    );
}

fn fingerprint(files: &[Option<&str>]) -> Fingerprint {
    files
        .iter()
        .map(|file| {
            let metadata = std::fs::metadata(Path::new((*file)?)).ok()?;
            Some((metadata.modified().ok()?, metadata.len()))
        })
        .collect()
}

/// Organization ids for the configured bindings that exist on this server,
/// and how many configuration ids do not exist yet. Before admission from
/// configuration is installed there is no `config_id` column, and nothing
/// resolves.
async fn resolve_configuration_ids(
    db: &PgPool,
    configured: &ConfiguredBindings,
) -> Result<(Vec<(String, String)>, usize), sqlx_core::Error> {
    if configured.organizations.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let has_column: bool = query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'cloud_organizations' AND column_name = 'config_id')",
    )
    .fetch_one(db)
    .await?;
    if !has_column {
        return Ok((Vec::new(), configured.organizations.len()));
    }
    let ids: Vec<String> = configured
        .organizations
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    let found: Vec<(String, String)> = query_as(
        "SELECT config_id, organization_id FROM cloud_organizations WHERE config_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let bindings: Vec<(String, String)> = configured
        .organizations
        .iter()
        .filter_map(|(config_id, pool)| {
            let (_, organization_id) = found.iter().find(|(id, _)| id == config_id)?;
            Some((organization_id.clone(), pool.clone()))
        })
        .collect();
    let unresolved = configured.organizations.len() - bindings.len();
    Ok((bindings, unresolved))
}

#[cfg(unix)]
type Hangup = Option<tokio::signal::unix::Signal>;
#[cfg(not(unix))]
type Hangup = Option<()>;

#[cfg(unix)]
fn hangup_signal() -> Hangup {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::hangup()) {
        Ok(signal) => Some(signal),
        Err(error) => {
            eprintln!("[resource-pools] SIGHUP reload is unavailable: {error}");
            None
        }
    }
}

#[cfg(not(unix))]
fn hangup_signal() -> Hangup {
    None
}

async fn next_signal(hangup: &mut Hangup) {
    #[cfg(unix)]
    if let Some(signal) = hangup {
        signal.recv().await;
        return;
    }
    let _ = hangup;
    std::future::pending::<()>().await
}

/// Warns at startup about bound organization ids that do not exist, such as
/// a typo or an organization from another deployment. They are kept: the
/// organization may be created later.
pub async fn warn_unknown_organizations(
    db: &PgPool,
    pools: &ResourcePools,
) -> Result<(), sqlx_core::Error> {
    let bound: Vec<String> = pools.bound_organizations().map(str::to_string).collect();
    if bound.is_empty() {
        return Ok(());
    }
    let unknown: Vec<String> = query_scalar(
        "SELECT id FROM unnest($1::text[]) AS bound(id)
         WHERE NOT EXISTS (SELECT 1 FROM cloud_organizations o WHERE o.organization_id = bound.id)
         ORDER BY id",
    )
    .bind(&bound)
    .fetch_all(db)
    .await?;
    for id in unknown {
        eprintln!("[resource-pools] Bound organization {id} does not exist on this server");
    }
    Ok(())
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
