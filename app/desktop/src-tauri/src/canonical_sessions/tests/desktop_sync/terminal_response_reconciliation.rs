use super::*;

fn seed_terminal(conn: &Connection, id: &str, parent: &str, status: &str, text: &str, cloud: bool) {
    append_message_in_db(
        conn,
        AppendCanonicalMessageRequest {
            id: Some(id.into()),
            session_id: "session:self-agent".into(),
            sender_identity_id: "agent:local".into(),
            sender_role: "owned-agent".into(),
            message_kind: "agent-turn".into(),
            content_text: text.into(),
            content: Some(serde_json::json!({
                "deliveryState": status, "replyToMessageId": parent,
                "error": if status == "failed" { "Synthetic provider failure" } else { "" },
            })),
            parent_message_id: Some(parent.into()),
            delegated_exchange_id: None,
            status: Some(status.into()),
            created_at_ms: Some(1_010),
            source_transport: Some(
                if cloud {
                    "cloud-self-agent"
                } else {
                    "desktop-chat"
                }
                .into(),
            ),
            source_event_id: Some(id.into()),
        },
    )
    .unwrap();
}

fn runtime(status: &str) -> kordi_cli::desktop_runtime::DesktopChatMessage {
    kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".into(),
        sender: Some("Kordi".into()),
        text: if status == "failed" {
            "Synthetic provider failure".into()
        } else {
            String::new()
        },
        detail: None,
        time_label: "12:00".into(),
        timestamp_ms: 2_000,
        thinking_text: None,
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: status == "failed",
        cancelled: status == "cancelled",
        entry_id: Some("native-terminal-entry".into()),
    }
}

fn sync(conn: &Connection, message: &kordi_cli::desktop_runtime::DesktopChatMessage) -> String {
    sync_desktop_chat_message(
        conn,
        "session:self-agent",
        "human:local",
        "agent:local",
        1,
        message,
        Some("request"),
    )
    .unwrap()
    .unwrap()
}

#[test]
fn terminal_cloud_mirrors_survive_followup_history_refresh_without_duplicates() {
    for (status, cloud_text) in [("failed", ""), ("cancelled", "Request canceled.")] {
        let conn = test_conn();
        let message = runtime(status);
        seed_terminal(&conn, "cloud-terminal", "request", status, cloud_text, true);
        seed_terminal(
            &conn,
            "old-native-mirror",
            "request",
            status,
            &message.text,
            false,
        );
        // A different request can legitimately fail with the same error.
        seed_terminal(
            &conn,
            "other-request-terminal",
            "other-request",
            status,
            cloud_text,
            true,
        );
        for _ in 0..3 {
            assert_eq!(sync(&conn, &message), "cloud-terminal");
            let (count, created, stored_status, entry): (i64, i64, String, String) = conn.query_row(
                "SELECT count(*),created_at_ms,status,json_extract(content_json,'$.desktopEntryId')
                 FROM session_messages WHERE parent_message_id='request'", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).unwrap();
            assert_eq!(
                (count, created, stored_status.as_str(), entry.as_str()),
                (1, 1_010, status, "native-terminal-entry")
            );
            // A later Cloud snapshot uses its wire representation again.
            conn.execute(
                "UPDATE session_messages SET content_text=?1,content_json=?2 WHERE id='cloud-terminal'",
                rusqlite::params![cloud_text, serde_json::json!({
                    "deliveryState": status, "replyToMessageId": "request",
                    "error": if status == "failed" { "Synthetic provider failure" } else { "" },
                }).to_string()],
            )
            .unwrap();
        }
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM session_messages WHERE parent_message_id='other-request'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}

#[test]
fn cancellation_reconciliation_retains_partial_text_and_the_cancelling_actor() {
    let conn = test_conn();
    seed_terminal(
        &conn,
        "cloud-cancelled",
        "request",
        "cancelled",
        "Request canceled by sender.",
        true,
    );
    let mut message = runtime("cancelled");
    message.text = "Useful native partial answer".into();
    assert_eq!(sync(&conn, &message), "cloud-cancelled");
    let (text, notice, actor): (String, String, String) = conn.query_row(
        "SELECT content_text,json_extract(content_json,'$.message'),json_extract(content_json,'$.cancelledByRole') FROM session_messages WHERE id='cloud-cancelled'",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(text, "Useful native partial answer");
    assert_eq!(notice, "Request canceled by sender.");
    assert_eq!(actor, "sender");
}

#[test]
fn failed_runtime_does_not_replace_a_successful_cloud_answer() {
    let conn = test_conn();
    seed_terminal(
        &conn,
        "cloud-answer",
        "request",
        "complete",
        "Synthetic provider failure",
        true,
    );
    assert_ne!(sync(&conn, &runtime("failed")), "cloud-answer");
    let status: String = conn
        .query_row(
            "SELECT status FROM session_messages WHERE id='cloud-answer'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "complete");
}

#[test]
fn empty_local_cancellation_does_not_discard_cloud_partial_answer() {
    let conn = test_conn();
    seed_terminal(
        &conn,
        "cloud-partial",
        "request",
        "cancelled",
        "Useful partial answer",
        true,
    );
    assert_ne!(sync(&conn, &runtime("cancelled")), "cloud-partial");
    let text: String = conn
        .query_row(
            "SELECT content_text FROM session_messages WHERE id='cloud-partial'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(text, "Useful partial answer");
}
