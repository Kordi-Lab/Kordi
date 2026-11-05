//! The disposable database each run replays into.
//!
//! The URL in `KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL` only names a PostgreSQL
//! server on this machine and a database to connect to for administration.
//! The harness never writes to that database: every run creates its own
//! `kordi_eval_<pid>_<time>_<random>` database on the same server, applies the
//! migrations there, replays into it, and drops it afterwards, including when
//! the run fails. A loopback port can still be a tunnel to a shared server, so
//! nothing a run writes (migrations, the System agent account, queued runs)
//! may land in a database the harness did not create.

use std::net::IpAddr;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use sqlx_core::query::query;
use sqlx_core::Url;
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};

pub const DATABASE_URL_VAR: &str = "KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL";
const NAME_PREFIX: &str = "kordi_eval_";
/// PostgreSQL truncates identifiers longer than this.
const MAX_NAME_LEN: usize = 63;

/// Where a connection goes, as sqlx resolves it from the URL host, the
/// `host`/`hostaddr` parameters, and `PGHOST`/`PGHOSTADDR`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// A Unix-domain socket directory, which is always on this machine.
    Socket(String),
    Tcp(String),
}

impl Endpoint {
    pub fn of(options: &PgConnectOptions) -> Self {
        if let Some(socket) = options.get_socket() {
            return Self::Socket(socket.display().to_string());
        }
        let host = options.get_host();
        // sqlx connects through a socket when the host is a directory.
        if host.starts_with('/') {
            Self::Socket(host.to_string())
        } else {
            Self::Tcp(host.to_string())
        }
    }

    /// Unix sockets and loopback TCP hosts are accepted; everything else is
    /// refused before any connection is made.
    pub fn is_local(&self) -> bool {
        match self {
            Self::Socket(_) => true,
            Self::Tcp(host) => {
                let bare = host.trim_start_matches('[').trim_end_matches(']');
                bare.eq_ignore_ascii_case("localhost")
                    || IpAddr::from_str(bare).is_ok_and(|ip| ip.is_loopback())
            }
        }
    }
}

/// Parses the server URL and refuses anything that is not on this machine.
pub fn local_server(url: &str) -> Result<PgConnectOptions> {
    let options = PgConnectOptions::from_str(url)
        .map_err(|_| anyhow::anyhow!("{DATABASE_URL_VAR} is not a PostgreSQL URL"))?;
    if !Endpoint::of(&options).is_local() {
        bail!(
            "{DATABASE_URL_VAR} must name a PostgreSQL server on this machine \
             (a Unix socket, localhost, or a loopback address)"
        );
    }
    Ok(options)
}

/// A fresh database name: `kordi_eval_<pid>_<unix seconds>_<random>`.
pub fn new_name() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{NAME_PREFIX}{}_{seconds}_{}",
        std::process::id(),
        &random[..8]
    )
}

/// Only names the harness generates may be created or dropped.
pub fn is_disposable_name(name: &str) -> bool {
    name.len() <= MAX_NAME_LEN
        && name
            .strip_prefix(NAME_PREFIX)
            .is_some_and(|rest| !rest.is_empty())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// The server URL with its database replaced by `name`. The host, port, user
/// and connection parameters stay as given; a `dbname` parameter is removed.
pub fn url_for(server_url: &str, name: &str) -> Result<String> {
    if !is_disposable_name(name) {
        bail!("{name} is not a quality test database name");
    }
    let mut url = Url::parse(server_url)
        .map_err(|_| anyhow::anyhow!("{DATABASE_URL_VAR} is not a PostgreSQL URL"))?;
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "dbname")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_path(&format!("/{name}"));
    url.set_query(None);
    if !kept.is_empty() {
        url.query_pairs_mut().extend_pairs(kept);
    }
    Ok(url.to_string())
}

fn quoted(name: &str) -> Result<String> {
    if !is_disposable_name(name) {
        bail!("{name} is not a quality test database name");
    }
    Ok(format!("\"{name}\""))
}

/// The database one run replays into. [`DisposableDatabase::prepare`] only
/// connects to the server; [`DisposableDatabase::create`] creates the
/// database; [`DisposableDatabase::drop_database`] removes it if it exists,
/// so it is safe to call whether or not creation finished.
#[derive(Clone)]
pub struct DisposableDatabase {
    admin: PgPool,
    name: String,
    url: String,
    pool: Arc<Mutex<Option<PgPool>>>,
}

impl DisposableDatabase {
    /// Checks that `server_url` is on this machine, picks a fresh name, and
    /// opens the administration connection. Nothing is created yet.
    pub async fn prepare(server_url: &str) -> Result<Self> {
        let options = local_server(server_url)?;
        let name = new_name();
        let url = url_for(server_url, &name)?;
        let target =
            PgConnectOptions::from_str(&url).context("building the quality test database URL")?;
        if Endpoint::of(&target) != Endpoint::of(&options)
            || target.get_port() != options.get_port()
            || target.get_database() != Some(name.as_str())
        {
            bail!("the quality test database URL does not point to the same server");
        }
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .context("connecting to the PostgreSQL server for the quality test")?;
        Ok(Self {
            admin,
            name,
            url,
            pool: Arc::default(),
        })
    }

    /// Creates the database and brings its schema up to date with the
    /// server's own migrations.
    pub async fn create(&self) -> Result<PgPool> {
        query(&format!("CREATE DATABASE {}", quoted(&self.name)?))
            .execute(&self.admin)
            .await
            .context("creating the quality test database (the role needs CREATEDB)")?;
        // The server's own pool setup, which applies every migration.
        let pool = kordi_cloud_server::pg::init_pool(&self.url)
            .await
            .map_err(|error| anyhow::anyhow!("opening the quality test database: {error}"))?;
        *self.pool.lock().expect("database pool slot") = Some(pool.clone());
        Ok(pool)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Closes the run's connections and drops the database if it exists. A
    /// failure is printed, not raised, so it never hides the run's own
    /// result; returns whether the database is gone.
    pub async fn drop_database(self) -> bool {
        let pool = self.pool.lock().expect("database pool slot").take();
        if let Some(pool) = pool {
            pool.close().await;
        }
        let dropped = drop_named(&self.admin, &self.name).await;
        self.admin.close().await;
        dropped
    }
}

/// `DROP DATABASE ... WITH (FORCE)` (PostgreSQL 13 and later) also ends any
/// session a stray pool clone still holds; older servers get a plain drop.
async fn drop_named(admin: &PgPool, name: &str) -> bool {
    let Ok(quoted) = quoted(name) else {
        return false;
    };
    let forced = query(&format!("DROP DATABASE IF EXISTS {quoted} WITH (FORCE)"))
        .execute(admin)
        .await;
    let result = match forced {
        Ok(_) => Ok(()),
        Err(_) => query(&format!("DROP DATABASE IF EXISTS {quoted}"))
            .execute(admin)
            .await
            .map(|_| ()),
    };
    match result {
        Ok(()) => true,
        Err(error) => {
            eprintln!("warning: could not drop the quality test database {name}: {error}");
            false
        }
    }
}

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;
