use super::*;
use crate::canonical_sessions::database::open_db_at_path;
use crate::test_support::ScopedKordiStorageRoot;
use std::sync::{Arc, Barrier};

#[test]
fn warm_database_opens_do_not_write_or_wait_for_an_existing_writer() {
    let storage = ScopedKordiStorageRoot::new("canonical-warm-open");
    let path = storage.root().join("test.sqlite3");
    let writer = open_db_at_path(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();

    // A warm open used to update schema metadata and fail with SQLITE_BUSY.
    // WAL readers must remain available while a sync transaction is writing.
    let reader = open_db_at_path(&path).unwrap();
    assert_eq!(reader.total_changes(), 0);
    assert_eq!(
        reader
            .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    reader.pragma_update(None, "query_only", true).unwrap();
    initialize_schema(&reader).unwrap();
    writer.execute_batch("ROLLBACK;").unwrap();
}

#[test]
fn version_two_databases_complete_projection_migrations_before_becoming_current() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE canonical_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO canonical_schema_meta VALUES ('version', '2');
         CREATE TABLE chat_sync_messages (
             account_id TEXT, message_id TEXT, conversation_id TEXT,
             conversation_sequence INTEGER, version INTEGER,
             snapshot_json TEXT, updated_at_ms INTEGER,
             PRIMARY KEY(account_id, message_id)
         );
         INSERT INTO chat_sync_messages VALUES
             ('account', 'message', 'conversation', 1, 1,
              '{\"client_message_id\":\"client-message\",\"kind\":\"text\"}', 1);",
    )
    .unwrap();
    initialize_schema(&conn).unwrap();
    assert!(schema_is_current(&conn).unwrap());
    let projection: (String, String) = conn.query_row(
        "SELECT client_message_id, message_kind FROM chat_sync_messages WHERE message_id = 'message'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(projection, ("client-message".into(), "text".into()));
    let before = conn.total_changes();
    initialize_schema(&conn).unwrap();
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn failed_initialization_is_not_marked_complete_and_can_be_retried() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE canonical_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO canonical_schema_meta VALUES ('version', '2');
         CREATE TABLE local_profile (id TEXT PRIMARY KEY);",
    )
    .unwrap();
    assert!(initialize_schema(&conn).is_err());
    assert!(!schema_is_current(&conn).unwrap());
    conn.execute_batch("DROP TABLE local_profile;").unwrap();
    initialize_schema(&conn).unwrap();
    assert!(schema_is_current(&conn).unwrap());
    ensure_local_profile(&conn).unwrap();
}

#[test]
fn newer_database_versions_are_not_downgraded() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    conn.execute(
        "UPDATE canonical_schema_meta SET value = ?1 WHERE key = 'version'",
        [format!("{}", SCHEMA_VERSION + 1)],
    )
    .unwrap();
    let before = conn.total_changes();
    assert!(initialize_schema(&conn)
        .unwrap_err()
        .contains("newer version"));
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn concurrent_reopens_migrate_once_and_preserve_account_isolation() {
    let storage = ScopedKordiStorageRoot::new("canonical-concurrent-open");
    let path = storage.root().join("first.sqlite3");
    let conn = open_db_at_path(&path).unwrap();
    conn.execute_batch(
        "UPDATE canonical_schema_meta SET value = '2' WHERE key = 'version';
         CREATE TABLE migration_audit (version TEXT);
         CREATE TRIGGER audit_migration AFTER UPDATE ON canonical_schema_meta
         BEGIN INSERT INTO migration_audit VALUES (NEW.value); END;",
    )
    .unwrap();
    let barrier = Arc::new(Barrier::new(8));
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let path = &path;
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..10 {
                    open_db_at_path(path).unwrap();
                }
            });
        }
    });
    let migrations: i64 = conn
        .query_row("SELECT COUNT(*) FROM migration_audit", [], |r| r.get(0))
        .unwrap();
    assert_eq!(migrations, 1);
    let other = open_db_at_path(&storage.root().join("other.sqlite3")).unwrap();
    assert!(schema_is_current(&other).unwrap());
    assert!(!table_exists(&other, "migration_audit").unwrap());
}

#[test]
#[ignore = "manual synthetic database-open benchmark; no production data"]
fn benchmark_repeated_sync_database_opens() {
    let storage = ScopedKordiStorageRoot::new("canonical-open-benchmark");
    let path = storage.root().join("benchmark.sqlite3");
    // Hold a connection open in both cases, as concurrent sync workers do.
    let keeper = open_db_at_path(&path).unwrap();
    keeper
        .execute_batch(
            "CREATE TABLE migration_audit (version TEXT);
         CREATE TRIGGER audit_migration AFTER UPDATE ON canonical_schema_meta
         BEGIN INSERT INTO migration_audit VALUES (NEW.value); END;",
        )
        .unwrap();
    for legacy in [true, false] {
        keeper.execute("DELETE FROM migration_audit", []).unwrap();
        let start = std::time::Instant::now();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let path = &path;
                scope.spawn(move || {
                    for _ in 0..100 {
                        let legacy_conn;
                        let optimized_conn;
                        let conn = if legacy {
                            let conn = Connection::open(path).unwrap();
                            conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                            conn.execute_batch(
                                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
                            ).unwrap();
                            migrate_schema(&conn).unwrap();
                            legacy_conn = conn;
                            &legacy_conn
                        } else {
                            optimized_conn = open_db_at_path(path).unwrap();
                            &*optimized_conn
                        };
                        conn.query_row("SELECT COUNT(*) FROM identities", [], |r| r.get::<_, i64>(0)).unwrap();
                    }
                });
            }
        });
        let elapsed = start.elapsed();
        let writes: i64 = keeper
            .query_row("SELECT COUNT(*) FROM migration_audit", [], |r| r.get(0))
            .unwrap();
        println!(
            "{}: 800 database opens, {elapsed:?}, {writes} schema writes",
            if legacy { "before" } else { "after" }
        );
        assert_eq!(writes, if legacy { 800 } else { 0 });
    }
}
