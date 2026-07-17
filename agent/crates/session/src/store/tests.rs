use super::*;
use chrono::{TimeZone, Utc};
use kordi_core::types::*;

fn make_user_entry(parent: Option<&str>) -> SessionEntry {
    make_user_entry_at(parent, Utc::now())
}

fn make_user_entry_at(parent: Option<&str>, timestamp: chrono::DateTime<Utc>) -> SessionEntry {
    SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: parent.map(|s| EntryId(s.to_string())),
            timestamp,
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
            }],
            timestamp: timestamp.timestamp_millis(),
        }),
    }
}

fn make_assistant_entry(parent: Option<&str>) -> SessionEntry {
    SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: parent.map(|s| EntryId(s.to_string())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: "ok".to_string(),
            }],
            provider: "test".into(),
            model: "test".into(),
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }),
    }
}

#[test]
fn test_create_and_append() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let entry = make_user_entry(None);
    let seq = append_entry(&conn, &sid, &entry).unwrap();
    assert_eq!(seq, 1);

    let entries = get_entries(&conn, &sid).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].entry_type, "message");

    let session = get_session(&conn, &sid).unwrap().unwrap();
    assert_eq!(session.entry_count, 1);
    assert!(session.leaf_id.is_some());
}

#[test]
fn test_branching() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let e1 = make_user_entry(None);
    let e1_id = e1.base().id.clone();
    append_entry(&conn, &sid, &e1).unwrap();

    let e2 = make_user_entry(Some(e1_id.as_str()));
    append_entry(&conn, &sid, &e2).unwrap();

    set_leaf(&conn, &sid, Some(e1_id.as_str())).unwrap();
    let session = get_session(&conn, &sid).unwrap().unwrap();
    assert_eq!(session.leaf_id.as_deref(), Some(e1_id.as_str()));

    let e3 = make_user_entry(Some(e1_id.as_str()));
    append_entry(&conn, &sid, &e3).unwrap();

    let children = get_children(&conn, &sid, e1_id.as_str()).unwrap();
    assert_eq!(children.len(), 2);
}

#[test]
fn test_fork_from_assistant_entry_includes_assistant_response() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let root = make_user_entry(None);
    let root_id = root.base().id.clone();
    append_entry(&conn, &sid, &root).unwrap();

    let user_q = make_user_entry(Some(root_id.as_str()));
    let user_q_id = user_q.base().id.clone();
    append_entry(&conn, &sid, &user_q).unwrap();

    let assistant = make_assistant_entry(Some(user_q_id.as_str()));
    let assistant_id = assistant.base().id.clone();
    append_entry(&conn, &sid, &assistant).unwrap();

    // Fork-AT semantics: the new session's leaf is the clicked
    // assistant response itself, and the transcript contains every
    // ancestor including the assistant response.
    let forked = fork_session_from_entry(&conn, &sid, assistant_id.as_str(), "/tmp/test").unwrap();
    assert_eq!(
        forked.branch_leaf_id.as_deref(),
        Some(assistant_id.as_str())
    );
    assert_eq!(forked.source_entry_id, assistant_id.as_str());

    let forked_session = get_session(&conn, &forked.session_id).unwrap().unwrap();
    assert_eq!(
        forked_session.leaf_id.as_deref(),
        Some(assistant_id.as_str())
    );
    assert_eq!(
        forked_session.parent_session_message_id.as_deref(),
        Some(assistant_id.as_str())
    );

    let entries = get_entries(&conn, &forked.session_id).unwrap();
    let entry_ids: Vec<&str> = entries.iter().map(|row| row.entry_id.as_str()).collect();
    assert_eq!(
        entry_ids,
        vec![root_id.as_str(), user_q_id.as_str(), assistant_id.as_str()]
    );
}

#[test]
fn test_fork_from_user_message_includes_clicked_user_message() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let root = make_user_entry(None);
    let root_id = root.base().id.clone();
    append_entry(&conn, &sid, &root).unwrap();

    let leaf = make_user_entry(Some(root_id.as_str()));
    let leaf_id = leaf.base().id.clone();
    append_entry(&conn, &sid, &leaf).unwrap();

    // Even though the desktop UI only offers Fork on assistant turns,
    // the backend remains general-purpose: clicking any entry forks-AT
    // it (everything through the clicked entry, inclusive).
    let forked = fork_session_from_entry(&conn, &sid, leaf_id.as_str(), "/tmp/test").unwrap();
    assert_eq!(forked.branch_leaf_id.as_deref(), Some(leaf_id.as_str()));

    let forked_session = get_session(&conn, &forked.session_id).unwrap().unwrap();
    assert_eq!(forked_session.leaf_id.as_deref(), Some(leaf_id.as_str()));

    let entries = get_entries(&conn, &forked.session_id).unwrap();
    let entry_ids: Vec<&str> = entries.iter().map(|row| row.entry_id.as_str()).collect();
    assert_eq!(entry_ids, vec![root_id.as_str(), leaf_id.as_str()]);
}

#[test]
fn test_fork_from_root_entry_keeps_only_that_entry() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let root = make_user_entry(None);
    let root_id = root.base().id.clone();
    append_entry(&conn, &sid, &root).unwrap();

    let forked = fork_session_from_entry(&conn, &sid, root_id.as_str(), "/tmp/test").unwrap();
    assert_eq!(forked.branch_leaf_id.as_deref(), Some(root_id.as_str()));

    let forked_session = get_session(&conn, &forked.session_id).unwrap().unwrap();
    assert_eq!(forked_session.leaf_id.as_deref(), Some(root_id.as_str()));

    let entries = get_entries(&conn, &forked.session_id).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].entry_id, root_id.as_str());
}

#[test]
fn test_fork_session_from_unknown_entry_returns_error() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let err = fork_session_from_entry(&conn, &sid, "missing-entry", "/tmp/test").unwrap_err();
    assert!(err.to_string().to_lowercase().contains("not found"));
}

#[test]
fn test_fork_session_does_not_mutate_source_session() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let root = make_user_entry(None);
    let root_id = root.base().id.clone();
    append_entry(&conn, &sid, &root).unwrap();

    let middle = make_user_entry(Some(root_id.as_str()));
    let middle_id = middle.base().id.clone();
    append_entry(&conn, &sid, &middle).unwrap();

    let before_entries = get_entries(&conn, &sid).unwrap();
    let before_session = get_session(&conn, &sid).unwrap().unwrap();

    let _ = fork_session_from_entry(&conn, &sid, middle_id.as_str(), "/tmp/test").unwrap();

    let after_entries = get_entries(&conn, &sid).unwrap();
    let after_session = get_session(&conn, &sid).unwrap().unwrap();

    assert_eq!(after_entries, before_entries);
    assert_eq!(after_session.leaf_id, before_session.leaf_id);
    assert_eq!(after_session.entry_count, before_session.entry_count);
    assert!(after_session.parent_session_id.is_none());
    assert!(after_session.parent_session_message_id.is_none());
}

#[test]
fn test_set_leaf_does_not_update_session_timestamp() {
    let conn = open_memory().unwrap();
    let sid = create_session(&conn, "/tmp/test").unwrap();

    let entry = make_user_entry(None);
    let entry_id = entry.base().id.clone();
    append_entry(&conn, &sid, &entry).unwrap();

    let before = get_session(&conn, &sid)
        .unwrap()
        .expect("session before set_leaf")
        .updated_at;
    set_leaf(&conn, &sid, Some(entry_id.as_str())).unwrap();
    let after = get_session(&conn, &sid)
        .unwrap()
        .expect("session after set_leaf")
        .updated_at;

    assert_eq!(after, before);
}

#[test]
fn test_session_scope_filters_chat_list_and_delete_removes_rows() {
    let conn = open_memory().unwrap();
    let chat_session_id = create_session(&conn, "/tmp/test").unwrap();
    let hidden_session_id = create_session(&conn, "/tmp/test").unwrap();
    let project_session_id = create_session(&conn, "/tmp/test").unwrap();

    append_entry(&conn, &chat_session_id, &make_user_entry(None)).unwrap();
    append_entry(&conn, &hidden_session_id, &make_user_entry(None)).unwrap();
    append_entry(&conn, &project_session_id, &make_user_entry(None)).unwrap();

    update_session_scope(&conn, &hidden_session_id, "hidden", "/tmp/test", None).unwrap();
    update_session_scope(
        &conn,
        &project_session_id,
        "project",
        "/tmp/project",
        Some("/tmp/project"),
    )
    .unwrap();
    upsert_project(
        &conn,
        "project:/tmp/project",
        "/tmp/project",
        Some("Test Project"),
    )
    .unwrap();

    let projects = list_projects(&conn).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].root, "/tmp/project");
    assert_eq!(projects[0].name.as_deref(), Some("Test Project"));

    let sessions = list_sessions(&conn, "/tmp/test").unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, chat_session_id);

    delete_session(&conn, &chat_session_id).unwrap();
    assert!(get_session(&conn, &chat_session_id).unwrap().is_none());
    assert!(get_entries(&conn, &chat_session_id).unwrap().is_empty());
}

#[test]
fn test_list_sessions_orders_by_last_message_timestamp_not_metadata_updates() {
    let conn = open_memory().unwrap();
    let older_session_id = create_session(&conn, "/tmp/test").unwrap();
    let newer_session_id = create_session(&conn, "/tmp/test").unwrap();

    let older_timestamp = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
    let newer_timestamp = Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap();

    let older_entry = make_user_entry_at(None, older_timestamp);
    append_entry(&conn, &older_session_id, &older_entry).unwrap();

    let newer_entry = make_user_entry_at(None, newer_timestamp);
    append_entry(&conn, &newer_session_id, &newer_entry).unwrap();

    set_session_name(&conn, &older_session_id, Some("older renamed later")).unwrap();

    let sessions = list_sessions(&conn, "/tmp/test").unwrap();
    let ordered_ids = sessions
        .into_iter()
        .map(|session| session.session_id)
        .collect::<Vec<_>>();

    assert_eq!(ordered_ids, vec![newer_session_id, older_session_id]);
}

#[test]
fn session_title_precedence_keeps_manual_and_imported_names_stable() {
    let conn = open_memory().unwrap();
    let session_id = create_session(&conn, "/tmp/test").unwrap();

    assert!(set_auto_session_name(&conn, &session_id, "Release plan", Some("entry-1")).unwrap());
    let automatic = get_session(&conn, &session_id).unwrap().unwrap();
    assert_eq!(automatic.name.as_deref(), Some("Release plan"));
    assert_eq!(automatic.title_source, SessionTitleSource::Auto);
    assert_eq!(automatic.title_revision, 1);

    set_session_name(&conn, &session_id, Some("My release checklist")).unwrap();
    assert!(
        !set_auto_session_name(
            &conn,
            &session_id,
            "Different automatic name",
            Some("entry-2")
        )
        .unwrap()
    );
    let manual = get_session(&conn, &session_id).unwrap().unwrap();
    assert_eq!(manual.name.as_deref(), Some("My release checklist"));
    assert_eq!(manual.title_source, SessionTitleSource::Manual);

    let imported_id = create_session(&conn, "/tmp/test").unwrap();
    assert!(
        set_session_title(
            &conn,
            &imported_id,
            Some("Imported investigation"),
            SessionTitleSource::Imported,
            None,
        )
        .unwrap()
    );
    assert!(!set_auto_session_name(&conn, &imported_id, "Automatic replacement", None).unwrap());
    assert_eq!(
        get_session(&conn, &imported_id)
            .unwrap()
            .unwrap()
            .name
            .as_deref(),
        Some("Imported investigation")
    );
}

#[test]
fn automatic_title_allows_only_one_refinement() {
    let conn = open_memory().unwrap();
    let session_id = create_session(&conn, "/tmp/test").unwrap();

    assert!(set_auto_session_name(&conn, &session_id, "Node CPU", Some("entry-1")).unwrap());
    assert!(
        set_auto_session_name(
            &conn,
            &session_id,
            "Diagnose high Node CPU",
            Some("entry-2"),
        )
        .unwrap()
    );
    assert!(
        !set_auto_session_name(&conn, &session_id, "Third moving title", Some("entry-3"),).unwrap()
    );

    let row = get_session(&conn, &session_id).unwrap().unwrap();
    assert_eq!(row.name.as_deref(), Some("Diagnose high Node CPU"));
    assert_eq!(row.title_revision, 2);
}

#[test]
fn known_legacy_auto_title_can_be_backfilled_without_replacing_other_legacy_titles() {
    let conn = open_memory().unwrap();
    let generated_id = create_session(&conn, "/tmp/test").unwrap();
    conn.execute(
        "UPDATE sessions
         SET name = 'which model are you', title_source = 'legacy', title_revision = 1
         WHERE session_id = ?1",
        rusqlite::params![generated_id],
    )
    .unwrap();

    assert!(
        set_session_title(
            &conn,
            &generated_id,
            None,
            SessionTitleSource::Placeholder,
            None,
        )
        .unwrap()
    );
    assert!(
        set_auto_session_name(&conn, &generated_id, "Model and identity", Some("entry-1")).unwrap()
    );
    let generated = get_session(&conn, &generated_id).unwrap().unwrap();
    assert_eq!(generated.name.as_deref(), Some("Model and identity"));
    assert_eq!(generated.title_source, SessionTitleSource::Auto);

    let preserved_id = create_session(&conn, "/tmp/test").unwrap();
    conn.execute(
        "UPDATE sessions
         SET name = 'Release validation plan', title_source = 'legacy', title_revision = 1
         WHERE session_id = ?1",
        rusqlite::params![preserved_id],
    )
    .unwrap();
    assert!(!set_auto_session_name(&conn, &preserved_id, "Automatic replacement", None).unwrap());
    assert_eq!(
        get_session(&conn, &preserved_id)
            .unwrap()
            .unwrap()
            .name
            .as_deref(),
        Some("Release validation plan")
    );
}
