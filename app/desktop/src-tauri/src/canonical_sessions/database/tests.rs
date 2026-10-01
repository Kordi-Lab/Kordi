use super::*;
use crate::test_support::ScopedKordiStorageRoot;

fn cache() -> ConnectionCache {
    Arc::new(Mutex::new(Vec::new()))
}

#[test]
#[cfg(unix)]
fn reuses_connections_and_restores_read_write_access() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-reuse");
    let path = storage.root().join("test.sqlite3");
    let cache = cache();
    {
        let conn = open_with_cache(&path, &cache).unwrap();
        conn.execute_batch("CREATE TEMP TABLE connection_marker (value INTEGER);")
            .unwrap();
        conn.pragma_update(None, "query_only", true).unwrap();
    }
    let conn = open_with_cache(&path, &cache).unwrap();
    // TEMP tables exist only on the same physical SQLite connection.
    conn.execute("INSERT INTO connection_marker VALUES (1)", [])
        .unwrap();
    assert_eq!(
        conn.query_row("SELECT value FROM connection_marker", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn abandoned_transactions_are_rolled_back_and_never_reused() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-rollback");
    let path = storage.root().join("test.sqlite3");
    let cache = cache();
    {
        let conn = open_with_cache(&path, &cache).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_rows (value INTEGER);
            BEGIN IMMEDIATE;
            INSERT INTO test_rows VALUES (1);",
        )
        .unwrap();
    }
    assert!(cache.lock().unwrap().is_empty());
    let conn = open_with_cache(&path, &cache).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM test_rows", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn panicking_jobs_discard_their_connection() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-panic");
    let path = storage.root().join("test.sqlite3");
    let cache = cache();
    let conn = open_with_cache(&path, &cache).unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _conn = conn;
            panic!("synthetic database job panic");
        }))
        .is_err()
    );
    assert!(cache.lock().unwrap().is_empty());
    open_with_cache(&path, &cache).unwrap();
}

#[test]
fn connection_cache_is_bounded_and_account_scoped() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-accounts");
    let cache = cache();
    for i in 0..12 {
        let conn =
            open_with_cache(&storage.root().join(format!("account-{i}.sqlite3")), &cache).unwrap();
        conn.execute_batch("CREATE TABLE account_marker (value INTEGER);")
            .unwrap();
        conn.execute("INSERT INTO account_marker VALUES (?1)", [i])
            .unwrap();
    }
    assert!(cache.lock().unwrap().len() <= MAX_IDLE_CONNECTIONS);
    for i in 0..12 {
        let conn =
            open_with_cache(&storage.root().join(format!("account-{i}.sqlite3")), &cache).unwrap();
        assert_eq!(
            conn.query_row("SELECT value FROM account_marker", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            i
        );
    }
}

#[test]
#[cfg(unix)]
fn replacing_a_database_does_not_reuse_the_previous_handle() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-replacement");
    let path = storage.root().join("test.sqlite3");
    let replacement = storage.root().join("replacement.sqlite3");
    let cache = cache();
    {
        let conn = open_with_cache(&path, &cache).unwrap();
        conn.execute_batch("CREATE TABLE previous_account (value INTEGER);")
            .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    {
        let conn = Connection::open(&replacement).unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute_batch("CREATE TABLE replacement_account (value INTEGER);")
            .unwrap();
    }
    std::fs::rename(replacement, &path).unwrap();
    let conn = open_with_cache(&path, &cache).unwrap();
    assert!(conn.prepare("SELECT * FROM previous_account").is_err());
    conn.prepare("SELECT * FROM replacement_account").unwrap();
}

#[test]
#[cfg(unix)]
fn an_open_connection_cannot_acquire_a_replacement_files_cache_identity() {
    let storage = ScopedKordiStorageRoot::new("canonical-connection-open-replacement");
    let path = storage.root().join("test.sqlite3");
    let replacement = storage.root().join("replacement.sqlite3");
    std::fs::create_dir_all(storage.root()).unwrap();
    let original = Connection::open(&path).unwrap();
    initialize_schema(&original).unwrap();
    assert!(connection_cache_key(&original, &path).unwrap().is_some());
    {
        let next = Connection::open(&replacement).unwrap();
        initialize_schema(&next).unwrap();
    }
    std::fs::rename(replacement, &path).unwrap();
    assert!(
        matches!(connection_cache_key(&original, &path), Err(error) if error.contains("changed"))
    );
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
#[cfg(unix)]
fn new_databases_are_owner_only() {
    let storage = ScopedKordiStorageRoot::new("canonical-owner-only-new");
    let path = storage
        .root()
        .join("nested")
        .join("canonical-sessions.sqlite3");

    let conn = open_db_at_path(&path).unwrap();

    assert_eq!(mode(path.parent().unwrap()), 0o700);
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&sqlite_sidecar(&path, "-wal")), 0o600);
    assert_eq!(mode(&sqlite_sidecar(&path, "-shm")), 0o600);
    drop(conn);
}

#[test]
#[cfg(unix)]
fn existing_readable_databases_become_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let storage = ScopedKordiStorageRoot::new("canonical-owner-only-existing");
    let parent = storage.root().join("accounts");
    let path = parent.join("canonical-sessions.sqlite3");
    std::fs::create_dir_all(&parent).unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE earlier_release (value INTEGER);")
            .unwrap();
    }
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let conn = open_with_cache(&path, &cache()).unwrap();

    assert_eq!(mode(&parent), 0o700);
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&sqlite_sidecar(&path, "-wal")), 0o600);
    conn.prepare("SELECT * FROM earlier_release").unwrap();
}

#[test]
#[cfg(unix)]
fn reused_connections_do_not_change_modes_again() {
    use std::os::unix::fs::PermissionsExt;
    let storage = ScopedKordiStorageRoot::new("canonical-owner-only-reused");
    let path = storage.root().join("canonical-sessions.sqlite3");
    let cache = cache();
    drop(open_with_cache(&path, &cache).unwrap());
    // A deliberate change after the first open is respected by cached reuse.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();

    drop(open_with_cache(&path, &cache).unwrap());

    assert_eq!(mode(&path), 0o640);
}
