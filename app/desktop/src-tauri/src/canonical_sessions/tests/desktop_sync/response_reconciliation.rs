use super::*;

#[test]
fn desktop_sync_links_agent_turn_to_latest_user_request() {
    let conn = test_conn();
    let message = |role: &str, text: &str, timestamp_ms: i64| {
        kordi_cli::desktop_runtime::DesktopChatMessage {
            role: role.to_string(),
            sender: (role != "system")
                .then(|| if role == "user" { "You" } else { "Kordi" }.to_string()),
            text: text.to_string(),
            detail: (role != "user").then(|| "Model updated".to_string()),
            time_label: "17:09".to_string(),
            timestamp_ms,
            thinking_text: None,
            tools: Vec::new(),
            attachments: Vec::new(),
            failed: false,
            cancelled: false,
            entry_id: None,
        }
    };
    let user = message("user", "how about the new mac", 1_000);
    let model_notice = message(
        "system",
        "Switched model to anthropic/claude-opus-4-7",
        1_100,
    );
    let mut assistant = message("assistant", "Here’s the current Mac landscape.", 2_000);
    assistant.detail = Some("anthropic/claude-opus-4-7 • completed".to_string());
    let user_id = sync_desktop_chat_message(
        &conn,
        "session:local",
        "human:local",
        "agent:local",
        0,
        &user,
        None,
    )
    .expect("sync user")
    .expect("user message id");
    let model_notice_id = sync_desktop_chat_message(
        &conn,
        "session:local",
        "human:local",
        "agent:local",
        1,
        &model_notice,
        None,
    )
    .expect("sync model notice")
    .expect("model notice id");
    let (kind, role): (String, String) = conn
        .query_row(
            "SELECT message_kind, sender_role FROM session_messages WHERE id = ?1",
            [&model_notice_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read model notice");
    assert_eq!(
        (kind.as_str(), role.as_str()),
        ("agent-model-change", "system")
    );
    let assistant_id = sync_desktop_chat_message(
        &conn,
        "session:local",
        "human:local",
        "agent:local",
        2,
        &assistant,
        Some(user_id.as_str()),
    )
    .expect("sync assistant")
    .expect("assistant message id");
    let (parent, reply): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT parent_message_id, json_extract(content_json, '$.replyToMessageId')
         FROM session_messages WHERE id = ?1",
            [&assistant_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read synced assistant");
    assert_eq!(parent.as_deref(), Some(user_id.as_str()));
    assert_eq!(reply.as_deref(), Some(user_id.as_str()));
}

#[test]
fn desktop_sync_enriches_cloud_self_agent_response_without_appending_a_duplicate() {
    let conn = test_conn();
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:request".to_string()),
            session_id: "session:self-agent".to_string(),
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "check disk usage".to_string(),
            content: Some(serde_json::json!({ "sender": "You" })),
            parent_message_id: None,
            delegated_exchange_id: None,
            status: Some("sent".to_string()),
            created_at_ms: Some(1_000),
            source_transport: Some("cloud-self-agent".to_string()),
            source_event_id: Some("cloud-request".to_string()),
        },
    )
    .expect("seed request");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:cloud-response".to_string()),
            session_id: "session:self-agent".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "Disk usage is healthy.".to_string(),
            content: Some(serde_json::json!({
                "deliveryState": "complete",
                "requestId": "msg:request",
            })),
            parent_message_id: Some("msg:request".to_string()),
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            created_at_ms: Some(1_001),
            source_transport: Some("cloud-self-agent".to_string()),
            source_event_id: Some("cloud-response".to_string()),
        },
    )
    .expect("seed Cloud response");
    append_message_in_db(
        &conn,
        AppendCanonicalMessageRequest {
            id: Some("msg:desktop-duplicate".to_string()),
            session_id: "session:self-agent".to_string(),
            sender_identity_id: "agent:local".to_string(),
            sender_role: "owned-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: "Disk usage is healthy.".to_string(),
            content: Some(serde_json::json!({ "role": "assistant" })),
            parent_message_id: Some("msg:request".to_string()),
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            created_at_ms: Some(5_000),
            source_transport: Some("desktop-chat".to_string()),
            source_event_id: Some("desktop-response".to_string()),
        },
    )
    .expect("seed duplicate desktop response");

    let desktop_message = kordi_cli::desktop_runtime::DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("My Kordi".to_string()),
        text: "Disk usage is healthy.".to_string(),
        detail: Some("completed".to_string()),
        time_label: "20:26".to_string(),
        timestamp_ms: 5_000,
        thinking_text: Some("Read the real disk usage values.".to_string()),
        tools: Vec::new(),
        attachments: Vec::new(),
        failed: false,
        cancelled: false,
        entry_id: Some("desktop-entry".to_string()),
    };

    let synced_id = sync_desktop_chat_message(
        &conn,
        "session:self-agent",
        "human:local",
        "agent:local",
        2,
        &desktop_message,
        Some("msg:request"),
    )
    .expect("sync desktop response")
    .expect("retained response id");

    assert_eq!(synced_id, "msg:cloud-response");
    let rows: Vec<(String, String, i64, Option<String>)> = conn
        .prepare(
            "SELECT id, source_transport, created_at_ms,
                    json_extract(content_json, '$.thinkingText')
             FROM session_messages
             WHERE session_id = 'session:self-agent'
               AND sender_role = 'owned-agent'",
        )
        .expect("prepare response query")
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query responses")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect responses");
    assert_eq!(
        rows,
        vec![(
            "msg:cloud-response".to_string(),
            "cloud-self-agent".to_string(),
            1_001,
            Some("Read the real disk usage values.".to_string()),
        )]
    );
}
