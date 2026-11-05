//! The running admission configuration, and reloading it without a restart.
//!
//! Readers take a snapshot ([`LiveAdmission::current`]) for one decision. A
//! reload reads the organizations file again (checking its signature when a
//! signing key is set), and merges it with [`narrowing::merge`]: ordinary
//! keys and narrowed critical keys apply, widened critical keys keep their
//! running value and are logged with a diff until a restart. An unreadable,
//! unsigned or invalid file is logged and changes nothing.
//!
//! Reloads happen on `SIGHUP` and within [`WATCH_INTERVAL`] of the file or
//! its signature changing, like the resource pool reload that reads the same
//! file for pool bindings.

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use sqlx_postgres::PgPool;

use super::config::{OrganizationAdmission, FILE_ENV};
use super::narrowing::{merge, Merged};
use super::{signature, store};

pub const WATCH_INTERVAL: Duration = Duration::from_secs(5);

type Fingerprint = [Option<(SystemTime, u64)>; 2];

/// Shared handle to the running configuration. Clones share one snapshot.
#[derive(Clone, Default)]
pub struct LiveAdmission {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    current: RwLock<Arc<OrganizationAdmission>>,
    path: Option<String>,
    fingerprint: Mutex<Option<Fingerprint>>,
}

impl std::fmt::Debug for LiveAdmission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveAdmission")
            .field("organizations", &self.current().organizations.len())
            .finish_non_exhaustive()
    }
}

impl From<OrganizationAdmission> for LiveAdmission {
    /// A fixed configuration that never reloads.
    fn from(admission: OrganizationAdmission) -> Self {
        Self::with_path(admission, None)
    }
}

impl LiveAdmission {
    /// A configuration loaded from `path` (already synced), reloaded from it
    /// by [`Self::spawn_watcher`].
    pub fn with_path(admission: OrganizationAdmission, path: Option<String>) -> Self {
        let fingerprint = path.as_deref().map(fingerprint);
        Self {
            inner: Arc::new(Inner {
                current: RwLock::new(Arc::new(admission)),
                path,
                fingerprint: Mutex::new(fingerprint),
            }),
        }
    }

    /// The configuration now. Keep it for one decision; do not cache it.
    pub fn current(&self) -> Arc<OrganizationAdmission> {
        self.inner
            .current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn replace(&self, admission: OrganizationAdmission) {
        *self
            .inner
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(admission);
    }

    fn changed(&self) -> bool {
        let Some(path) = self.inner.path.as_deref() else {
            return false;
        };
        let now = fingerprint(path);
        let mut seen = self
            .inner
            .fingerprint
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen.as_ref() == Some(&now) {
            return false;
        }
        // Remember it now so a rejected file is reported once.
        *seen = Some(now);
        true
    }

    /// Reads the file again and applies what it may change. Returns the
    /// merge for logging and tests.
    pub async fn reload(&self, pool: &PgPool) -> Result<Merged, String> {
        let Some(path) = self.inner.path.as_deref() else {
            return Err(format!("{FILE_ENV} is not set"));
        };
        let key = signature::signing_key_from_env()?;
        let raw = signature::read_file(path, key.as_ref())?;
        let next = OrganizationAdmission::parse(&raw, |key| std::env::var(key).ok())?;
        self.apply(pool, next).await
    }

    /// Merges `next` into the running configuration and, when anything
    /// applies, syncs it to the database before swapping it in.
    pub async fn apply(
        &self,
        pool: &PgPool,
        next: OrganizationAdmission,
    ) -> Result<Merged, String> {
        let current = self.current();
        let mut merged = merge(&current, next);
        log_changes(&merged);
        if merged.admission.organizations == current.organizations
            && merged.admission.personal_pool == current.personal_pool
        {
            return Ok(merged);
        }
        let mut synced = merged
            .admission
            .clone()
            .sync_configured(pool)
            .await
            .map_err(|error| format!("sync configured organizations: {error}"))?;
        // Organizations the reload removed are retired now, like at startup.
        let removed: Vec<String> = current
            .organizations
            .iter()
            .filter(|org| synced.by_config_id(&org.id).is_none())
            .map(|org| org.organization_id.clone())
            .filter(|id| !id.is_empty())
            .collect();
        synced.orphaned.extend(removed);
        store::sweep(pool, &synced).await;
        merged.admission = synced.clone();
        self.replace(synced);
        println!(
            "Kordi configured organizations reloaded: {}",
            merged.admission.organizations.len()
        );
        Ok(merged)
    }

    /// Reloads on `SIGHUP` and when the file or its signature changes.
    /// Errors are logged; the running configuration stays.
    pub fn spawn_watcher(&self, pool: PgPool) {
        if self.inner.path.is_none() {
            return;
        }
        let live = self.clone();
        tokio::spawn(async move {
            let mut hangup = hangup_signal();
            let mut timer = tokio::time::interval(WATCH_INTERVAL);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let signalled = tokio::select! {
                    _ = timer.tick() => false,
                    _ = next_signal(&mut hangup) => true,
                };
                if !(live.changed() || signalled) {
                    continue;
                }
                if let Err(error) = live.reload(&pool).await {
                    eprintln!(
                        "[organization admission] reload rejected; keeping the running configuration: {error}"
                    );
                }
            }
        });
    }
}

fn log_changes(merged: &Merged) {
    for change in &merged.changes {
        if change.applied {
            println!(
                "[organization admission] reload narrowed {}: {}",
                change.key, change.detail
            );
        } else {
            eprintln!(
                "[organization admission] reload kept {}: widening needs a restart ({})",
                change.key, change.detail
            );
        }
    }
}

fn fingerprint(path: &str) -> Fingerprint {
    let stat = |file: &str| {
        let metadata = std::fs::metadata(Path::new(file)).ok()?;
        Some((metadata.modified().ok()?, metadata.len()))
    };
    [stat(path), stat(&signature::signature_path(path))]
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
            eprintln!("[organization admission] SIGHUP reload is unavailable: {error}");
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
