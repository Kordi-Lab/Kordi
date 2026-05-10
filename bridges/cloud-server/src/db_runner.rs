//! Single-writer SQLite runner.
//!
//! Funnels every database write through one shared [`Connection`] guarded by
//! a `std::sync::Mutex`, and lets reads run concurrently on their own
//! connections. All work executes inside `tokio::task::spawn_blocking` so
//! the async executor is never parked on a synchronous SQLite call.
//!
//! This is the production pattern for any SQLite-backed Tokio server: it
//! prevents `database is locked` busy-wait stalls under write contention,
//! and it stops one slow query from starving the executor of other tasks.
//!
//! Cloud-edition handlers route every DB call through this runner. Local
//! coordinator code paths can adopt it incrementally.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tokio::task::JoinError;

use crate::schema::configure_server_connection;

#[derive(Debug)]
pub enum DbRunnerError {
    Open(rusqlite::Error),
    Configure(rusqlite::Error),
    Join(JoinError),
    Poisoned,
}

impl std::fmt::Display for DbRunnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(err) => write!(f, "open db connection: {err}"),
            Self::Configure(err) => write!(f, "configure db connection: {err}"),
            Self::Join(err) => write!(f, "blocking task did not complete: {err}"),
            Self::Poisoned => write!(f, "db write mutex was poisoned"),
        }
    }
}

impl std::error::Error for DbRunnerError {}

#[derive(Debug)]
struct DbRunnerInner {
    db_path: PathBuf,
    write: Mutex<Connection>,
}

#[derive(Clone, Debug)]
pub struct DbRunner {
    inner: Arc<DbRunnerInner>,
}

impl DbRunner {
    /// Construct a runner that owns one shared write connection. Read
    /// connections are opened on demand — SQLite WAL allows multiple readers
    /// to run in parallel as long as each has its own connection.
    pub fn new(db_path: PathBuf) -> Result<Self, DbRunnerError> {
        let connection = Connection::open(&db_path).map_err(DbRunnerError::Open)?;
        configure_server_connection(&connection).map_err(DbRunnerError::Configure)?;
        Ok(Self {
            inner: Arc::new(DbRunnerInner {
                db_path,
                write: Mutex::new(connection),
            }),
        })
    }

    /// Path used to open additional read-only connections.
    pub fn db_path(&self) -> &Path {
        &self.inner.db_path
    }

    /// Run a write transaction. The closure runs on a tokio blocking thread
    /// while holding the single write lock — at most one write executes
    /// against the database at a time.
    pub async fn write<F, T, E>(&self, f: F) -> Result<T, E>
    where
        F: FnOnce(&mut Connection) -> Result<T, E> + Send + 'static,
        T: Send + 'static,
        E: From<DbRunnerError> + Send + 'static,
    {
        let inner = Arc::clone(&self.inner);
        match tokio::task::spawn_blocking(move || -> Result<T, E> {
            let mut guard = match inner.write.lock() {
                Ok(g) => g,
                Err(_) => return Err(E::from(DbRunnerError::Poisoned)),
            };
            f(&mut guard)
        })
        .await
        {
            Ok(result) => result,
            Err(join_err) => Err(E::from(DbRunnerError::Join(join_err))),
        }
    }

    /// Run a read on its own short-lived connection. Multiple `read` calls
    /// can execute concurrently, limited only by the tokio blocking pool.
    pub async fn read<F, T, E>(&self, f: F) -> Result<T, E>
    where
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
        T: Send + 'static,
        E: From<DbRunnerError> + Send + 'static,
    {
        let inner = Arc::clone(&self.inner);
        match tokio::task::spawn_blocking(move || -> Result<T, E> {
            let conn = match Connection::open(&inner.db_path) {
                Ok(c) => c,
                Err(err) => return Err(E::from(DbRunnerError::Open(err))),
            };
            if let Err(err) = configure_server_connection(&conn) {
                return Err(E::from(DbRunnerError::Configure(err)));
            }
            f(&conn)
        })
        .await
        {
            Ok(result) => result,
            Err(join_err) => Err(E::from(DbRunnerError::Join(join_err))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("bridges-db-runner-{}.db", uuid::Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    #[derive(Debug)]
    enum TestError {
        Db(DbRunnerError),
        Sqlite(rusqlite::Error),
    }

    impl From<DbRunnerError> for TestError {
        fn from(value: DbRunnerError) -> Self {
            Self::Db(value)
        }
    }

    impl From<rusqlite::Error> for TestError {
        fn from(value: rusqlite::Error) -> Self {
            Self::Sqlite(value)
        }
    }

    #[tokio::test]
    async fn write_round_trips_to_read() {
        let path = fresh_db_path();
        let runner = DbRunner::new(path.clone()).expect("runner");
        runner
            .write::<_, _, TestError>(|conn| {
                conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)")?;
                conn.execute("INSERT INTO t (label) VALUES (?1)", rusqlite::params!["alpha"])?;
                Ok(())
            })
            .await
            .expect("write ok");

        let label: String = runner
            .read::<_, _, TestError>(|conn| {
                Ok(conn.query_row(
                    "SELECT label FROM t WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .await
            .expect("read ok");
        assert_eq!(label, "alpha");
        cleanup(&path);
    }

    #[tokio::test]
    async fn concurrent_writes_serialize_without_busy_errors() {
        let path = fresh_db_path();
        let runner = DbRunner::new(path.clone()).expect("runner");
        runner
            .write::<_, _, TestError>(|conn| {
                conn.execute_batch("CREATE TABLE counts (n INTEGER NOT NULL)")?;
                Ok(())
            })
            .await
            .expect("setup ok");

        // Fire 64 concurrent writes — without the single-writer lock these
        // would race against SQLite's busy timeout.
        let mut tasks = Vec::new();
        for value in 0..64i64 {
            let runner = runner.clone();
            tasks.push(tokio::spawn(async move {
                runner
                    .write::<_, _, TestError>(move |conn| {
                        conn.execute("INSERT INTO counts (n) VALUES (?1)", rusqlite::params![value])?;
                        Ok(())
                    })
                    .await
            }));
        }
        for task in tasks {
            task.await.expect("join").expect("write ok");
        }

        let total: i64 = runner
            .read::<_, _, TestError>(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM counts", [], |row| row.get(0))?)
            })
            .await
            .expect("count ok");
        assert_eq!(total, 64);
        cleanup(&path);
    }

    #[tokio::test]
    async fn write_errors_propagate_unchanged() {
        let path = fresh_db_path();
        let runner = DbRunner::new(path.clone()).expect("runner");
        runner
            .write::<_, _, TestError>(|conn| {
                conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY)")?;
                Ok(())
            })
            .await
            .expect("setup");
        let err = runner
            .write::<_, (), TestError>(|conn| {
                conn.execute("INSERT INTO nonexistent VALUES (1)", [])?;
                Ok(())
            })
            .await
            .expect_err("expected sqlite error");
        assert!(matches!(err, TestError::Sqlite(_)));
        cleanup(&path);
    }
}
