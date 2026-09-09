use super::*;
use serde_json::json;

fn message(id: &str, sequence: i64) -> Value {
    json!({"id": id, "conversation_id": "conversation-1", "conversation_sequence": sequence,
        "client_message_id": format!("client-{id}"), "version": 1, "deleted_at": null})
}

fn batch(account: &str, messages: Vec<Value>, events: Vec<Value>) -> ChatSyncApplyRequest {
    ChatSyncApplyRequest {
        account_id: account.into(),
        bootstrap: false,
        cursor: None,
        last_stream_seq: None,
        conversations: vec![],
        messages,
        events,
    }
}

#[test]
fn deleted_and_hidden_messages_survive_late_pages_updates_and_bootstrap() {
    for event_type in ["message.deleted", "message.hidden"] {
        let mut conn = test_support::test_connection();
        let original = message("deleted", 1);
        apply_on_connection(
            &mut conn,
            batch("acct_test", vec![original.clone()], vec![]),
        )
        .unwrap();
        apply_on_connection(&mut conn, batch("acct_test", vec![], vec![json!({
            "protocol_version": 2, "type": event_type, "stream_seq": 1, "entity_id": "deleted", "payload": {}
        })])).unwrap();
        let mut later = original.clone();
        later["version"] = json!(99);
        apply_on_connection(&mut conn, batch("acct_test", vec![later], vec![])).unwrap();
        let mut bootstrap = batch("acct_test", vec![original, message("neighbor", 2)], vec![]);
        bootstrap.bootstrap = true;
        apply_on_connection(&mut conn, bootstrap).unwrap();
        let state = load_state(&conn, "acct_test").unwrap();
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0]["id"], "neighbor");
        assert_eq!(
            deletions::load_deleted_message_ids(&conn, "acct_test").unwrap(),
            ["deleted"]
        );
    }
}

#[test]
fn removal_before_download_survives_reopening_and_is_account_scoped() {
    let path = std::env::temp_dir().join(format!(
        "kordi-deletion-test-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    {
        let mut conn = super::super::open_db_at_path(&path).unwrap();
        let tx = conn.transaction().unwrap();
        mark_message_deleted(&tx, "acct_test", "not-downloaded").unwrap();
        tx.commit().unwrap();
    }
    {
        let mut conn = super::super::open_db_at_path(&path).unwrap();
        let stale = message("not-downloaded", 1);
        apply_on_connection(&mut conn, batch("acct_test", vec![stale.clone()], vec![])).unwrap();
        assert!(load_state(&conn, "acct_test").unwrap().messages.is_empty());
        apply_on_connection(&mut conn, batch("acct_other", vec![stale], vec![])).unwrap();
        assert_eq!(load_state(&conn, "acct_other").unwrap().messages.len(), 1);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn failed_batch_does_not_commit_a_removal() {
    let mut conn = test_support::test_connection();
    let events = vec![
        json!({"protocol_version": 2, "type": "message.hidden", "stream_seq": 1, "entity_id": "keep", "payload": {}}),
        json!({"protocol_version": 2, "type": "unknown.required", "stream_seq": 2, "critical": true, "payload": {}}),
    ];
    assert!(apply_on_connection(&mut conn, batch("acct_test", vec![], events)).is_err());
    apply_on_connection(
        &mut conn,
        batch("acct_test", vec![message("keep", 1)], vec![]),
    )
    .unwrap();
    assert_eq!(load_state(&conn, "acct_test").unwrap().messages.len(), 1);
    assert!(deletions::load_deleted_message_ids(&conn, "acct_test")
        .unwrap()
        .is_empty());
}

#[test]
fn stale_deleted_send_acknowledgement_clears_the_outbox_without_restoring_the_message() {
    let mut conn = test_support::test_connection();
    let tx = conn.transaction().unwrap();
    mark_message_deleted(&tx, "acct_test", "deleted").unwrap();
    tx.commit().unwrap();
    conn.execute("INSERT INTO chat_sync_pending_operations(account_id, operation_id) VALUES ('acct_test', 'client-deleted')", []).unwrap();
    apply_on_connection(
        &mut conn,
        batch("acct_test", vec![message("deleted", 1)], vec![]),
    )
    .unwrap();
    assert!(load_state(&conn, "acct_test").unwrap().messages.is_empty());
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_sync_pending_operations",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}
