use super::*;

#[test]
fn saves_lists_and_archives_scoped_lesson_artifact_metadata() {
    let conn = crate::store::open_memory().expect("memory db");
    let artifact_path = "/tmp/kordi-lessons/project-repo.md";
    let lesson_id = save_reflection_lesson(
        &conn,
        NewReflectionLesson {
            scope: ReflectionScope::Project,
            scope_id: "/repo".to_string(),
            artifact_path: artifact_path.to_string(),
            source: ReflectionSource::RepeatedFailure,
            lesson_text: "Run the migration test first.".to_string(),
            ..NewReflectionLesson::default()
        },
    )
    .expect("save lesson");

    let lessons =
        list_reflection_lessons(&conn, ReflectionScope::Project, "/repo").expect("list lessons");
    assert_eq!(lessons.len(), 1);
    assert_eq!(lessons[0].lesson_id, lesson_id);
    assert_eq!(lessons[0].scope, ReflectionScope::Project);
    assert_eq!(lessons[0].source, ReflectionSource::RepeatedFailure);
    assert_eq!(lessons[0].artifact_path, artifact_path);
    assert!(lesson_id.starts_with("mem_"));
    assert_eq!(
        lessons[0].lesson_text.as_deref(),
        Some("Run the migration test first.")
    );

    let columns = conn
        .prepare("PRAGMA table_info(reflection_lessons)")
        .expect("prepare table info")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect columns");
    assert!(columns.contains(&"artifact_path".to_string()));
    assert!(!columns.contains(&"lesson".to_string()));

    archive_reflection_lesson(&conn, &lesson_id).expect("archive lesson");
    let lessons = list_reflection_lessons(&conn, ReflectionScope::Project, "/repo")
        .expect("list lessons after archive");
    assert!(lessons.is_empty());
}

fn lesson(scope_id: &str, text: &str, pending: bool) -> NewReflectionLesson {
    NewReflectionLesson {
        scope: ReflectionScope::Conversation,
        scope_id: scope_id.to_string(),
        artifact_path: format!("/tmp/{scope_id}.md"),
        source: ReflectionSource::Manual,
        lesson_text: text.to_string(),
        pending_upload: pending,
        ..NewReflectionLesson::default()
    }
}

#[test]
fn explicit_ids_and_times_are_kept() {
    let conn = crate::store::open_memory().expect("memory db");
    let id = save_reflection_lesson(
        &conn,
        NewReflectionLesson {
            lesson_id: Some("mem_fixed".to_string()),
            created_at: Some("2026-01-02T03:04:05+00:00".to_string()),
            scope_label: Some("repo".to_string()),
            remote_memory_id: Some("remote-1".to_string()),
            ..lesson("s1", "Keep ids.", false)
        },
    )
    .expect("save");
    assert_eq!(id, "mem_fixed");
    let rows = list_all_reflection_lessons(&conn).expect("list all");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].created_at, "2026-01-02T03:04:05+00:00");
    assert_eq!(rows[0].updated_at, "2026-01-02T03:04:05+00:00");
    assert_eq!(rows[0].scope_label.as_deref(), Some("repo"));
    assert_eq!(rows[0].remote_memory_id.as_deref(), Some("remote-1"));
    assert!(!rows[0].pending_upload);
}

#[test]
fn pending_rows_are_listed_and_marked_uploaded() {
    let conn = crate::store::open_memory().expect("memory db");
    let pending = save_reflection_lesson(&conn, lesson("s1", "Pending.", true)).unwrap();
    save_reflection_lesson(&conn, lesson("s1", "Uploaded.", false)).unwrap();

    let rows = list_pending_upload_reflection_lessons(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].lesson_id, pending);

    mark_reflection_lesson_uploaded(&conn, &pending, "remote-9").unwrap();
    assert!(
        list_pending_upload_reflection_lessons(&conn)
            .unwrap()
            .is_empty()
    );
    let row = list_all_reflection_lessons(&conn)
        .unwrap()
        .into_iter()
        .find(|row| row.lesson_id == pending)
        .unwrap();
    assert_eq!(row.remote_memory_id.as_deref(), Some("remote-9"));
    assert!(!row.pending_upload);
}

#[test]
fn updates_text_and_archives_everything() {
    let conn = crate::store::open_memory().expect("memory db");
    let id = save_reflection_lesson(&conn, lesson("s1", "Old.", false)).unwrap();
    save_reflection_lesson(&conn, lesson("s2", "Other.", true)).unwrap();

    update_reflection_lesson_text(&conn, &id, "New.").unwrap();
    let rows = list_reflection_lessons(&conn, ReflectionScope::Conversation, "s1").unwrap();
    assert_eq!(rows[0].lesson_text.as_deref(), Some("New."));

    assert_eq!(archive_all_reflection_lessons(&conn).unwrap(), 2);
    assert!(list_all_reflection_lessons(&conn).unwrap().is_empty());
}

#[test]
fn replace_from_remote_keeps_pending_rows_and_archives_stale_ones() {
    let conn = crate::store::open_memory().expect("memory db");
    let stale = save_reflection_lesson(&conn, lesson("s1", "Stale.", false)).unwrap();
    let pending = save_reflection_lesson(&conn, lesson("s1", "Not sent yet.", true)).unwrap();

    replace_reflection_lessons_from_remote(
        &conn,
        vec![NewReflectionLesson {
            remote_memory_id: Some("remote-a".to_string()),
            pending_upload: true,
            ..lesson("s1", "Fresh from the account.", false)
        }],
    )
    .unwrap();

    let rows = list_all_reflection_lessons(&conn).unwrap();
    let ids = rows
        .iter()
        .map(|row| row.lesson_id.as_str())
        .collect::<Vec<_>>();
    assert!(!ids.contains(&stale.as_str()));
    assert!(ids.contains(&pending.as_str()));
    let remote = rows.iter().find(|row| row.lesson_id == "remote-a").unwrap();
    assert_eq!(remote.remote_memory_id.as_deref(), Some("remote-a"));
    assert!(!remote.pending_upload);
    assert_eq!(
        remote.lesson_text.as_deref(),
        Some("Fresh from the account.")
    );

    // A second refresh with the same row replaces it in place.
    replace_reflection_lessons_from_remote(
        &conn,
        vec![NewReflectionLesson {
            remote_memory_id: Some("remote-a".to_string()),
            ..lesson("s1", "Edited on the phone.", false)
        }],
    )
    .unwrap();
    let rows = list_all_reflection_lessons(&conn).unwrap();
    assert_eq!(rows.len(), 2);
    let remote = rows.iter().find(|row| row.lesson_id == "remote-a").unwrap();
    assert_eq!(remote.lesson_text.as_deref(), Some("Edited on the phone."));
}

#[test]
fn finds_an_active_row_with_the_same_text_and_touches_it() {
    let conn = crate::store::open_memory().expect("memory db");
    let save = |scope_id: &str, text: &str| {
        save_reflection_lesson(
            &conn,
            NewReflectionLesson {
                scope: ReflectionScope::Conversation,
                scope_id: scope_id.to_string(),
                artifact_path: "/tmp/kordi-lessons/conversation.md".to_string(),
                lesson_text: text.to_string(),
                created_at: Some("2026-10-01T10:00:00+00:00".to_string()),
                ..NewReflectionLesson::default()
            },
        )
        .expect("save lesson")
    };
    let lesson_id = save("session-1", "Prefer short status updates");
    save("session-2", "Keep replies brief");

    let found = find_active_reflection_lesson_by_text(
        &conn,
        &ReflectionScope::Conversation,
        "session-1",
        "  Prefer  short\nstatus updates ",
    )
    .expect("find")
    .expect("same text matches");
    assert_eq!(found.lesson_id, lesson_id);
    for (scope_id, text) in [
        ("session-1", "prefer short status updates"),
        ("session-2", "Prefer short status updates"),
    ] {
        assert!(
            find_active_reflection_lesson_by_text(
                &conn,
                &ReflectionScope::Conversation,
                scope_id,
                text
            )
            .expect("find")
            .is_none(),
            "case and scope id distinguish memories"
        );
    }

    touch_reflection_lesson(&conn, &lesson_id, Some("Launch planning")).expect("touch");
    touch_reflection_lesson(&conn, &lesson_id, Some("Other title")).expect("touch again");
    let row = &list_reflection_lessons(&conn, ReflectionScope::Conversation, "session-1")
        .expect("list")[0];
    assert_eq!(row.scope_label.as_deref(), Some("Launch planning"));
    assert!(row.updated_at.as_str() > "2026-10-01T10:00:00+00:00");

    archive_reflection_lesson(&conn, &lesson_id).expect("archive");
    assert!(
        find_active_reflection_lesson_by_text(
            &conn,
            &ReflectionScope::Conversation,
            "session-1",
            "Prefer short status updates",
        )
        .expect("find")
        .is_none()
    );
}
