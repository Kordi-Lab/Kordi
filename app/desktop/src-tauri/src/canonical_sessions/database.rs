use super::{canonical_sessions_db_path, initialize_schema};
use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

// Idle connections only; active jobs are bounded separately by database_jobs.
// A single global bound also prevents accumulating connections across accounts.
const MAX_IDLE_CONNECTIONS: usize = 4;
type ConnectionCache = Arc<Mutex<Vec<CachedConnection>>>;
static IDLE_CONNECTIONS: OnceLock<ConnectionCache> = OnceLock::new();

#[derive(Clone, PartialEq, Eq)]
struct CacheKey {
    path: PathBuf,
    identity: (u64, u64),
}

struct CachedConnection {
    key: CacheKey,
    conn: Connection,
}

pub(crate) struct DatabaseConnection {
    conn: Option<Connection>,
    key: Option<CacheKey>,
    cache: ConnectionCache,
}

impl Deref for DatabaseConnection {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("connection is owned until drop")
    }
}

impl DerefMut for DatabaseConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("connection is owned until drop")
    }
}

impl Drop for DatabaseConnection {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else { return };
        let Some(key) = self.key.take() else { return };
        // Never lend another command an unfinished transaction, a connection
        // from an unwinding job, or a handle to a replaced/deleted database.
        if !conn.is_autocommit()
            || std::thread::panicking()
            || connection_cache_key(&conn, &key.path)
                .ok()
                .flatten()
                .as_ref()
                != Some(&key)
        {
            return;
        }
        if let Ok(mut idle) = self.cache.lock() {
            let evicted = if idle.len() == MAX_IDLE_CONNECTIONS {
                Some(idle.remove(0))
            } else {
                None
            };
            idle.push(CachedConnection { key, conn });
            drop(idle);
            drop(evicted);
        }
    }
}

// File identity is available on the desktop's Unix platforms. On other
// platforms keep using fresh connections rather than caching by path alone.
fn cache_key(path: &Path) -> Option<CacheKey> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        Some(CacheKey {
            path: path.to_path_buf(),
            identity: (metadata.dev(), metadata.ino()),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn connection_cache_key(conn: &Connection, path: &Path) -> Result<Option<CacheKey>, String> {
    #[cfg(unix)]
    {
        // Stat alone can assign a replacement file's identity to an older open
        // handle. Ask SQLite to check the file backing this exact connection.
        let key = cache_key(path);
        let mut moved: std::ffi::c_int = 0;
        // SAFETY: the live connection owns this SQLite handle, and `moved` is a
        // writable C integer for the duration of the synchronous file-control call.
        let status = unsafe {
            rusqlite::ffi::sqlite3_file_control(
                conn.handle(),
                c"main".as_ptr(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut std::ffi::c_int).cast(),
            )
        };
        if status != rusqlite::ffi::SQLITE_OK {
            return Ok(None);
        }
        if moved != 0 {
            return Err("Canonical database changed while opening; retry the operation".into());
        }
        Ok(key)
    }
    #[cfg(not(unix))]
    {
        let _ = (conn, path);
        Ok(None)
    }
}

pub(crate) fn open_db() -> Result<DatabaseConnection, String> {
    let path = canonical_sessions_db_path();
    open_db_at_path(&path)
}

pub(super) fn open_db_at_path(path: &Path) -> Result<DatabaseConnection, String> {
    let cache = IDLE_CONNECTIONS.get_or_init(|| Arc::new(Mutex::new(Vec::new())));
    open_with_cache(path, cache)
}

fn open_with_cache(path: &Path, cache: &ConnectionCache) -> Result<DatabaseConnection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let normalized = std::fs::canonicalize(path)
        .or_else(|_| {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            std::fs::canonicalize(parent)
                .map(|parent| parent.join(path.file_name().unwrap_or_default()))
        })
        .map_err(|error| error.to_string())?;
    let key = cache_key(&normalized);
    let cached = cache.lock().ok().and_then(|mut idle| {
        // Close stale handles before opening a replacement at the same path.
        idle.retain(|entry| entry.key.path != normalized || Some(&entry.key) == key.as_ref());
        key.as_ref().and_then(|key| {
            idle.iter()
                .rposition(|entry| &entry.key == key)
                .map(|index| idle.remove(index).conn)
        })
    });
    let reused = cached.is_some();
    let conn = match cached {
        Some(conn) => conn,
        None => Connection::open(&normalized).map_err(|err| err.to_string())?,
    };
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "query_only", false)
        .map_err(|error| error.to_string())?;
    if !reused {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|err| err.to_string())?;
    }
    // Only a cold open needs migration and validation. Pooled handles were
    // validated before they were returned, and foreign_keys is a connection
    // setting that survives with the handle.
    if !reused {
        initialize_schema(&conn)?;
    }
    let key = connection_cache_key(&conn, &normalized)?;
    Ok(DatabaseConnection {
        conn: Some(conn),
        key,
        cache: cache.clone(),
    })
}

#[cfg(test)]
mod tests;
