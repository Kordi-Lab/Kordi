use super::*;
use crate::store::{self, EntryRow};
use chrono::Utc;
use kordi_core::types::*;

#[test]
fn test_build_context_empty() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    let ctx = build_context(&conn, &sid).unwrap();
    assert!(ctx.messages.is_empty());
}

#[test]
fn test_explicit_thinking_level_from_path_is_none_when_unset() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();

    let e1 = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &sid, &e1).unwrap();

    assert_eq!(
        active_path_explicit_thinking_level(&conn, &sid).unwrap(),
        None
    );
}

#[test]
fn test_explicit_thinking_level_from_path_returns_latest_change() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();

    let root_id = EntryId::generate();
    let root = SessionEntry::Message {
        base: EntryBase {
            id: root_id.clone(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &sid, &root).unwrap();

    let low_id = EntryId::generate();
    let low = SessionEntry::ThinkingLevelChange {
        base: EntryBase {
            id: low_id.clone(),
            parent_id: Some(root_id),
            timestamp: Utc::now(),
        },
        thinking_level: ThinkingLevel::Low,
    };
    store::append_entry(&conn, &sid, &low).unwrap();

    let high = SessionEntry::ThinkingLevelChange {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: Some(low_id),
            timestamp: Utc::now(),
        },
        thinking_level: ThinkingLevel::High,
    };
    store::append_entry(&conn, &sid, &high).unwrap();

    assert_eq!(
        active_path_explicit_thinking_level(&conn, &sid).unwrap(),
        Some(ThinkingLevel::High)
    );
}

#[test]
fn test_build_context_simple() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();

    let e1 = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, &sid, &e1).unwrap();

    let ctx = build_context(&conn, &sid).unwrap();
    assert_eq!(ctx.messages.len(), 1);
    assert!(matches!(ctx.messages[0], AgentMessage::User(_)));
}

#[test]
fn test_build_context_with_compaction() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();

    let e1 = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("e1000001".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "old msg".into(),
            }],
            timestamp: 1000,
        }),
    };
    store::append_entry(&conn, &sid, &e1).unwrap();

    let e2 = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("e2000002".into()),
            parent_id: Some(EntryId("e1000001".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "kept msg".into(),
            }],
            timestamp: 2000,
        }),
    };
    store::append_entry(&conn, &sid, &e2).unwrap();

    let e3 = SessionEntry::Compaction {
        base: EntryBase {
            id: EntryId("e3000003".into()),
            parent_id: Some(EntryId("e2000002".into())),
            timestamp: Utc::now(),
        },
        summary: "Summary of old conversation".into(),
        first_kept_entry_id: EntryId("e2000002".into()),
        tokens_before: 5000,
        details: None,
        from_plugin: false,
    };
    store::append_entry(&conn, &sid, &e3).unwrap();

    let e4 = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("e4000004".into()),
            parent_id: Some(EntryId("e3000003".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "new msg".into(),
            }],
            timestamp: 4000,
        }),
    };
    store::append_entry(&conn, &sid, &e4).unwrap();

    let ctx = build_context(&conn, &sid).unwrap();

    assert_eq!(ctx.messages.len(), 3);
    assert!(matches!(
        ctx.messages[0],
        AgentMessage::CompactionSummary(_)
    ));
    assert!(matches!(ctx.messages[1], AgentMessage::User(_)));
    assert!(matches!(ctx.messages[2], AgentMessage::User(_)));

    if let AgentMessage::User(u) = &ctx.messages[1] {
        assert_eq!(
            u.content[0],
            ContentBlock::Text {
                text: "kept msg".into()
            }
        );
    }
}

#[test]
fn build_context_keeps_all_current_submission_images_in_runtime() {
    let older = AgentMessage::User(UserMessage {
        content: vec![
            ContentBlock::Text {
                text: "old screenshot".into(),
            },
            ContentBlock::Image {
                data: "old-image-data".into(),
                mime_type: "image/png".into(),
            },
        ],
        timestamp: 1000,
    });
    let latest = AgentMessage::User(UserMessage {
        content: vec![
            ContentBlock::Text {
                text: "new screenshot".into(),
            },
            ContentBlock::Image {
                data: "new-image-data".into(),
                mime_type: "image/png".into(),
            },
            ContentBlock::Image {
                data: "new-diagram-data".into(),
                mime_type: "image/jpeg".into(),
            },
        ],
        timestamp: 2000,
    });

    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    store::append_entry(
        &conn,
        &sid,
        &SessionEntry::Message {
            base: EntryBase {
                id: EntryId("old".into()),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: older,
        },
    )
    .unwrap();
    store::append_entry(
        &conn,
        &sid,
        &SessionEntry::Message {
            base: EntryBase {
                id: EntryId("new".into()),
                parent_id: Some(EntryId("old".into())),
                timestamp: Utc::now(),
            },
            message: latest,
        },
    )
    .unwrap();

    let ctx = build_context(&conn, &sid).unwrap();

    let AgentMessage::User(old_user) = &ctx.messages[0] else {
        panic!("old message should be user")
    };
    assert!(
        !old_user
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
    );
    assert!(
        old_user
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { text } if text == "old screenshot"))
    );

    let AgentMessage::User(new_user) = &ctx.messages[1] else {
        panic!("new message should be user")
    };
    let current_image_data = new_user
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Image { data, .. } => Some(data.as_str()),
            ContentBlock::Text { .. } => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        current_image_data,
        vec!["new-image-data", "new-diagram-data"]
    );
}

#[test]
fn build_context_replaces_previous_attachment_file_content_with_names() {
    let old_user = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("old-user".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "old file".into(),
            }],
            timestamp: 1000,
        }),
    };
    let old_attachment_context = SessionEntry::CustomMessage {
        base: EntryBase {
            id: EntryId("old-attachment".into()),
            parent_id: Some(EntryId("old-user".into())),
            timestamp: Utc::now(),
        },
        custom_type: "desktop_attachment_context".into(),
        content: vec![ContentBlock::Text {
            text: "SECRET OLD FILE CONTENT".into(),
        }],
        display: false,
        details: Some(
            serde_json::json!({ "attachments": [{ "kind": "file", "name": "old-report.txt", "formatLabel": "TXT" }] }),
        ),
    };
    let current_user = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("current-user".into()),
            parent_id: Some(EntryId("old-attachment".into())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "new file".into(),
            }],
            timestamp: 2000,
        }),
    };
    let current_attachment_context = SessionEntry::CustomMessage {
        base: EntryBase {
            id: EntryId("current-attachment".into()),
            parent_id: Some(EntryId("current-user".into())),
            timestamp: Utc::now(),
        },
        custom_type: "desktop_attachment_context".into(),
        content: vec![ContentBlock::Text {
            text: "CURRENT FILE CONTENT".into(),
        }],
        display: false,
        details: Some(
            serde_json::json!({ "attachments": [{ "kind": "file", "name": "current-report.txt", "formatLabel": "TXT" }] }),
        ),
    };

    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    for entry in [
        old_user,
        old_attachment_context,
        current_user,
        current_attachment_context,
    ] {
        store::append_entry(&conn, &sid, &entry).unwrap();
    }

    let ctx = build_context(&conn, &sid).unwrap();

    let AgentMessage::Custom(old_context) = &ctx.messages[1] else {
        panic!("old context should be custom")
    };
    let old_text = match &old_context.content[0] {
        ContentBlock::Text { text } => text,
        _ => panic!("old context should be text"),
    };
    assert!(!old_text.contains("SECRET OLD FILE CONTENT"));
    assert!(old_text.contains("old-report.txt"));

    let AgentMessage::Custom(current_context) = &ctx.messages[3] else {
        panic!("current context should be custom")
    };
    let current_text = match &current_context.content[0] {
        ContentBlock::Text { text } => text,
        _ => panic!("current context should be text"),
    };
    assert_eq!(current_text, "CURRENT FILE CONTENT");
}

#[test]
fn build_context_keeps_multiple_current_file_payloads_readable() {
    let current_user = SessionEntry::Message {
        base: EntryBase {
            id: EntryId("current-user".into()),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "compare these files".into(),
            }],
            timestamp: 2000,
        }),
    };
    let current_attachment_context = SessionEntry::CustomMessage {
        base: EntryBase {
            id: EntryId("current-attachment".into()),
            parent_id: Some(EntryId("current-user".into())),
            timestamp: Utc::now(),
        },
        custom_type: "desktop_attachment_context".into(),
        content: vec![ContentBlock::Text {
            text: "FIRST CURRENT FILE CONTENT\n\nSECOND CURRENT FILE CONTENT".into(),
        }],
        display: false,
        details: Some(serde_json::json!({
            "attachments": [
                { "kind": "file", "name": "first-current.txt", "formatLabel": "TXT" },
                { "kind": "file", "name": "second-current.md", "formatLabel": "MD" }
            ]
        })),
    };

    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    for entry in [current_user, current_attachment_context] {
        store::append_entry(&conn, &sid, &entry).unwrap();
    }

    let ctx = build_context(&conn, &sid).unwrap();

    let AgentMessage::Custom(current_context) = &ctx.messages[1] else {
        panic!("current context should be custom")
    };
    let current_text = match &current_context.content[0] {
        ContentBlock::Text { text } => text,
        _ => panic!("current context should be text"),
    };
    assert!(current_text.contains("FIRST CURRENT FILE CONTENT"));
    assert!(current_text.contains("SECOND CURRENT FILE CONTENT"));
}

fn context_state_entry_row(seq: i64, entry: SessionEntry) -> EntryRow {
    let entry_type = match &entry {
        SessionEntry::Compaction { .. } => "compaction",
        SessionEntry::Message { .. } => "message",
        _ => "other",
    };
    EntryRow {
        session_id: "context-state-test".to_string(),
        seq,
        entry_id: entry.base().id.to_string(),
        parent_id: entry.base().parent_id.as_ref().map(ToString::to_string),
        entry_type: entry_type.to_string(),
        timestamp: entry.base().timestamp.to_rfc3339(),
        payload: serde_json::to_string(&entry).expect("serialize entry"),
    }
}

fn context_state_assistant_entry(
    id: &str,
    parent_id: Option<&str>,
    total_tokens: u64,
    stop_reason: StopReason,
) -> SessionEntry {
    SessionEntry::Message {
        base: EntryBase {
            id: EntryId(id.to_string()),
            parent_id: parent_id.map(|value| EntryId(value.to_string())),
            timestamp: Utc::now(),
        },
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: "assistant response".to_string(),
            }],
            provider: "test".to_string(),
            model: "test".to_string(),
            usage: Usage {
                total_tokens,
                ..Default::default()
            },
            stop_reason,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }),
    }
}

fn context_state_compaction_entry(
    id: &str,
    parent_id: &str,
    first_kept_entry_id: &str,
) -> SessionEntry {
    SessionEntry::Compaction {
        base: EntryBase {
            id: EntryId(id.to_string()),
            parent_id: Some(EntryId(parent_id.to_string())),
            timestamp: Utc::now(),
        },
        summary: "summary".to_string(),
        first_kept_entry_id: EntryId(first_kept_entry_id.to_string()),
        tokens_before: 240_000,
        details: None,
        from_plugin: false,
    }
}

#[test]
fn active_path_context_state_uses_latest_valid_assistant_usage() {
    let path = vec![context_state_entry_row(
        0,
        context_state_assistant_entry("assistant", None, 120_000, StopReason::Stop),
    )];

    assert_eq!(
        active_path_context_state(&path),
        ActivePathContextState {
            estimated_tokens: Some(120_000),
            has_contextful_entries: true,
            latest_entry_is_compaction: false,
        }
    );
}

#[test]
fn active_path_context_state_does_not_reuse_usage_before_latest_compaction() {
    let before = context_state_assistant_entry("before", None, 240_000, StopReason::Stop);
    let compaction = context_state_compaction_entry("compaction", "before", "before");
    let aborted =
        context_state_assistant_entry("aborted", Some("compaction"), 260_000, StopReason::Aborted);
    let path = vec![
        context_state_entry_row(0, before),
        context_state_entry_row(1, compaction),
        context_state_entry_row(2, aborted),
    ];

    assert_eq!(
        active_path_context_state(&path),
        ActivePathContextState {
            estimated_tokens: None,
            has_contextful_entries: true,
            latest_entry_is_compaction: false,
        }
    );
}

#[test]
fn active_path_context_state_reports_empty_and_compaction_boundary_shapes() {
    assert_eq!(
        active_path_context_state(&[]),
        ActivePathContextState {
            estimated_tokens: Some(0),
            has_contextful_entries: false,
            latest_entry_is_compaction: false,
        }
    );

    let before = context_state_assistant_entry("before", None, 240_000, StopReason::Stop);
    let compaction = context_state_compaction_entry("compaction", "before", "before");
    let path = vec![
        context_state_entry_row(0, before),
        context_state_entry_row(1, compaction),
    ];

    assert_eq!(
        active_path_context_state(&path),
        ActivePathContextState {
            estimated_tokens: None,
            has_contextful_entries: true,
            latest_entry_is_compaction: true,
        }
    );
}
