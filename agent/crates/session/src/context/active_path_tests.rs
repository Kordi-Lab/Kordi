use super::{ActivePathContextState, active_path_context_state};
use crate::store::EntryRow;
use chrono::Utc;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, EntryBase, EntryId, SessionEntry, StopReason,
    Usage,
};

fn entry_row(seq: i64, entry: SessionEntry) -> EntryRow {
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

fn assistant_entry(
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

fn compaction_entry(id: &str, parent_id: &str, first_kept_entry_id: &str) -> SessionEntry {
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
fn uses_latest_valid_assistant_usage() {
    let path = vec![entry_row(
        0,
        assistant_entry("assistant", None, 120_000, StopReason::Stop),
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
fn does_not_reuse_usage_before_latest_compaction() {
    let before = assistant_entry("before", None, 240_000, StopReason::Stop);
    let compaction = compaction_entry("compaction", "before", "before");
    let aborted = assistant_entry("aborted", Some("compaction"), 260_000, StopReason::Aborted);
    let path = vec![
        entry_row(0, before),
        entry_row(1, compaction),
        entry_row(2, aborted),
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
fn reports_empty_and_compaction_boundary_shapes() {
    assert_eq!(
        active_path_context_state(&[]),
        ActivePathContextState {
            estimated_tokens: Some(0),
            has_contextful_entries: false,
            latest_entry_is_compaction: false,
        }
    );

    let before = assistant_entry("before", None, 240_000, StopReason::Stop);
    let compaction = compaction_entry("compaction", "before", "before");
    let path = vec![entry_row(0, before), entry_row(1, compaction)];

    assert_eq!(
        active_path_context_state(&path),
        ActivePathContextState {
            estimated_tokens: None,
            has_contextful_entries: true,
            latest_entry_is_compaction: true,
        }
    );
}
