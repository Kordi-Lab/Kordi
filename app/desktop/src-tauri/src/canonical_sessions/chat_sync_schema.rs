use rusqlite::Connection;

fn table_has_column(conn: &Connection, column: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(chat_sync_messages)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|candidate| candidate == column))
}

fn ensure_projection_column(
    conn: &Connection,
    column: &str,
    json_path: &str,
) -> Result<(), String> {
    if table_has_column(conn, column)? {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        if table_has_column(conn, column)? {
            return Ok(());
        }
        conn.execute_batch(&format!(
            "ALTER TABLE chat_sync_messages ADD COLUMN {column} TEXT;
             UPDATE chat_sync_messages
             SET {column} = json_extract(snapshot_json, '{json_path}')
             WHERE {column} IS NULL;"
        ))
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

pub(super) fn ensure_chat_sync_message_projection_columns(conn: &Connection) -> Result<(), String> {
    ensure_projection_column(conn, "client_message_id", "$.client_message_id")?;
    ensure_projection_column(conn, "message_kind", "$.kind")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn projection_column_migration_rechecks_after_waiting_for_another_writer() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kordi-chat-sync-column-race-{}-{suffix}.sqlite3",
            std::process::id()
        ));
        let first = Connection::open(&path).unwrap();
        first
            .execute_batch(
                "CREATE TABLE chat_sync_messages (
                   snapshot_json TEXT NOT NULL
                 );
                 BEGIN IMMEDIATE;
                 ALTER TABLE chat_sync_messages ADD COLUMN message_kind TEXT;",
            )
            .unwrap();
        let other_path = path.clone();
        let migration = std::thread::spawn(move || {
            let second = Connection::open(other_path).unwrap();
            second.busy_timeout(Duration::from_secs(2)).unwrap();
            ensure_projection_column(&second, "message_kind", "$.kind")
        });
        std::thread::sleep(Duration::from_millis(50));
        first.execute_batch("COMMIT;").unwrap();
        assert_eq!(migration.join().unwrap(), Ok(()));
        drop(first);
        let _ = std::fs::remove_file(path);
    }
}
