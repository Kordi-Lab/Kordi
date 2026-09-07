use super::*;
use crate::store;
use chrono::Utc;
use kordi_core::types::*;

#[test]
fn shared_context_boundary_hides_old_context_without_deleting_history() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    let mut parent = None;
    for text in [
        "old private context",
        "boundary",
        "current request",
        "current tool result",
    ] {
        let base = EntryBase {
            id: EntryId::generate(),
            parent_id: parent,
            timestamp: Utc::now(),
        };
        parent = Some(base.id.clone());
        let entry = if text == "boundary" {
            SessionEntry::Custom {
                base,
                custom_type: SHARED_CONTEXT_BOUNDARY.to_string(),
                data: None,
            }
        } else {
            SessionEntry::CustomMessage {
                base,
                custom_type: "test_context".to_string(),
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                display: false,
                details: None,
            }
        };
        store::append_entry(&conn, &sid, &entry).unwrap();
    }
    let context = build_context(&conn, &sid).unwrap();
    let payload = serde_json::to_string(&context.messages).unwrap();
    assert!(!payload.contains("old private context"));
    assert!(payload.contains("current request"));
    assert!(payload.contains("current tool result"));
    let path = tree::active_path(&conn, &sid).unwrap();
    assert_eq!(disclosed_path(&path).len(), 3);
    assert_eq!(store::get_entries(&conn, &sid).unwrap().len(), 4);
    let checkpoint = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: parent,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "Keep this turn".to_string(),
            }],
            timestamp: 0,
        }),
    };
    store::append_entry(&conn, &sid, &checkpoint).unwrap();
    let path = tree::active_path(&conn, &sid).unwrap();
    let settings = CompactionSettings {
        keep_recent_tokens: 1,
        ..CompactionSettings::default()
    };
    let preparation = crate::compaction::prepare_compaction(&path, &settings).unwrap();
    assert!(
        preparation
            .messages_to_summarize
            .iter()
            .all(|entry| !entry.payload.contains("old private context"))
    );
}
