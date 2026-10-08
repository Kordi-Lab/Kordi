use super::*;

#[test]
fn test_init_schema() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(get_version(&conn), CURRENT_VERSION);

    // Idempotent
    init_schema(&conn).unwrap();
    assert_eq!(get_version(&conn), CURRENT_VERSION);

    let mut stmt = conn.prepare("PRAGMA table_info(sessions)").unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.contains(&"parent_session_id".to_string()));
    assert!(columns.contains(&"parent_session_message_id".to_string()));
    assert!(columns.contains(&"session_scope".to_string()));
    assert!(columns.contains(&"project_root".to_string()));
    assert!(columns.contains(&"title_source".to_string()));
    assert!(columns.contains(&"title_revision".to_string()));
    assert!(columns.contains(&"title_policy_version".to_string()));
    assert!(columns.contains(&"title_generated_from_entry_id".to_string()));
    assert!(columns.contains(&"title_updated_at".to_string()));

    let project_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(project_count, 1);

    let reflection_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'reflection_lessons'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reflection_count, 1);

    let reflection_columns = table_columns(&conn, "reflection_lessons").unwrap();
    for column in [
        "lesson_text",
        "remote_memory_id",
        "pending_upload",
        "scope_label",
    ] {
        assert!(
            reflection_columns.contains(&column.to_string()),
            "missing {column}"
        );
    }
}

#[test]
fn v10_placeholder_greetings_use_code_points() {
    let conn = Connection::open_in_memory().unwrap();
    let expected = [
        "\u{4f60}\u{597d}",
        "\u{60a8}\u{597d}",
        "\u{55e8}",
        "\u{6d4b}\u{8bd5}",
        "\u{6536}\u{5230}",
        "\u{597d}\u{7684}",
        "\u{8c22}\u{8c22}",
    ];
    let line = MIGRATION_V10
        .lines()
        .find(|line| line.contains("char("))
        .unwrap();
    let list = line
        .trim()
        .trim_start_matches("OR TRIM(name) IN (")
        .trim_end_matches(')');
    let parts = list.split("), ").collect::<Vec<_>>();
    assert_eq!(parts.len(), expected.len());
    for (part, expected) in parts.iter().zip(expected) {
        let expr = if part.ends_with(')') {
            part.to_string()
        } else {
            format!("{part})")
        };
        let value: String = conn
            .query_row(&format!("SELECT {expr}"), [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, expected);
    }
}

#[test]
fn v11_migration_keeps_existing_reflection_rows() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    set_version(&conn, 1).unwrap();
    conn.execute_batch(MIGRATION_V2).unwrap();
    set_version(&conn, 2).unwrap();
    conn.execute_batch(MIGRATION_V3).unwrap();
    set_version(&conn, 3).unwrap();
    conn.execute_batch(MIGRATION_V4).unwrap();
    set_version(&conn, 4).unwrap();
    conn.execute_batch(MIGRATION_V5).unwrap();
    set_version(&conn, 5).unwrap();
    set_version(&conn, 6).unwrap();
    conn.execute_batch(MIGRATION_V7).unwrap();
    set_version(&conn, 7).unwrap();
    conn.execute_batch(MIGRATION_V8).unwrap();
    set_version(&conn, 8).unwrap();
    conn.execute_batch(MIGRATION_V9).unwrap();
    set_version(&conn, 9).unwrap();
    conn.execute_batch(MIGRATION_V10).unwrap();
    set_version(&conn, 10).unwrap();
    conn.execute(
        "INSERT INTO reflection_lessons (lesson_id, scope, scope_id, artifact_path, source, created_at, updated_at, archived_at) VALUES ('old', 'project', '/repo', '/tmp/a.md', 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)",
        [],
    )
    .unwrap();

    init_schema(&conn).unwrap();

    let row: (Option<String>, Option<String>, i64, Option<String>) = conn
        .query_row(
            "SELECT lesson_text, remote_memory_id, pending_upload, scope_label FROM reflection_lessons WHERE lesson_id = 'old'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, (None, None, 0, None));
}

#[test]
fn v10_migration_preserves_substantive_legacy_names_and_clears_weak_titles() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    set_version(&conn, 1).unwrap();
    conn.execute_batch(MIGRATION_V2).unwrap();
    set_version(&conn, 2).unwrap();
    conn.execute_batch(MIGRATION_V3).unwrap();
    set_version(&conn, 3).unwrap();
    conn.execute_batch(MIGRATION_V4).unwrap();
    set_version(&conn, 4).unwrap();
    conn.execute_batch(MIGRATION_V5).unwrap();
    set_version(&conn, 5).unwrap();
    set_version(&conn, 6).unwrap();
    conn.execute_batch(MIGRATION_V7).unwrap();
    set_version(&conn, 7).unwrap();
    conn.execute_batch(MIGRATION_V8).unwrap();
    set_version(&conn, 8).unwrap();
    conn.execute_batch(MIGRATION_V9).unwrap();
    set_version(&conn, 9).unwrap();
    conn.execute(
        "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
        rusqlite::params!["meaningful", "Release validation plan"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
        rusqlite::params!["weak", "hello"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
        rusqlite::params!["raw-id", "e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83"],
    )
    .unwrap();

    init_schema(&conn).unwrap();

    let meaningful: (Option<String>, String) = conn
        .query_row(
            "SELECT name, title_source FROM sessions WHERE session_id = 'meaningful'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let weak: (Option<String>, String) = conn
        .query_row(
            "SELECT name, title_source FROM sessions WHERE session_id = 'weak'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let raw_id: (Option<String>, String) = conn
        .query_row(
            "SELECT name, title_source FROM sessions WHERE session_id = 'raw-id'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        meaningful,
        (
            Some("Release validation plan".to_string()),
            "legacy".to_string()
        )
    );
    assert_eq!(weak, (None, "placeholder".to_string()));
    assert_eq!(raw_id, (None, "placeholder".to_string()));
}
