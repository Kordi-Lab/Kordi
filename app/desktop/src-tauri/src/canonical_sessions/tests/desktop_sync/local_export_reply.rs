use super::*;

#[test]
fn mirrored_local_history_requests_keep_their_native_terminal_reply() {
    for kind in ["canonical-history-user", "text"] {
        let conn = test_conn();
        append_message_in_db(
            &conn,
            AppendCanonicalMessageRequest {
                id: Some("request".into()),
                session_id: "session:self-agent".into(),
                sender_identity_id: "human:local".into(),
                sender_role: "user".into(),
                message_kind: "text".into(),
                content_text: "Compare the uploaded pictures".into(),
                content: None,
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some("sent".into()),
                created_at_ms: Some(1000),
                source_transport: Some("cloud-self-agent".into()),
                source_event_id: Some("wire-request".into()),
            },
        )
        .unwrap();
        conn.execute("INSERT INTO chat_sync_conversations VALUES('owner','conversation','session:self-agent',1,'{}',1000)", []).unwrap();
        conn.execute("INSERT INTO chat_sync_messages VALUES('owner','wire-request','client-request',?1,'conversation',1,1,'{}',1000)", [kind]).unwrap();
        let assistant = kordi_cli::desktop_runtime::DesktopChatMessage {
            role: "assistant".into(),
            sender: Some("Kordi".into()),
            text: "The second picture has a green panel.".into(),
            detail: None,
            time_label: "Now".into(),
            timestamp_ms: 2000,
            thinking_text: None,
            tools: Vec::new(),
            attachments: Vec::new(),
            failed: false,
            cancelled: false,
            entry_id: Some("native-answer".into()),
        };
        let result = sync_desktop_chat_message(
            &conn,
            "session:self-agent",
            "human:local",
            "agent:local",
            1,
            &assistant,
            Some("request"),
        )
        .unwrap();
        assert_eq!(
            result.is_some(),
            kind == "canonical-history-user",
            "history exports need local publication; true cloud requests have a separate publisher"
        );
        if let Some(id) = result {
            let (source, parent): (String, String) = conn
                .query_row(
                    "SELECT source_transport,parent_message_id FROM session_messages WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(source, "desktop-chat");
            assert_eq!(parent, "request");
            sync_desktop_chat_message(
                &conn,
                "session:self-agent",
                "human:local",
                "agent:local",
                1,
                &assistant,
                Some("request"),
            )
            .unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM session_messages WHERE sender_role='owned-agent'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
    }
}
