//! Gives a fork's runtime session the source conversation so the Agent sees the
//! inherited history on its first turn.

use chrono::Utc;
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use rusqlite::Connection;

use super::super::models::CanonicalSessionMessage;

pub(super) const INHERITED_HISTORY_CUSTOM_TYPE: &str = "fork_inherited_history";
const INHERITED_HISTORY_HEADER: &str = "Inherited conversation from the source chat through the forked message (application context, not a new request):";
const INHERITED_HISTORY_BODY_LIMIT: usize = 24_000;

fn sender_label(sender_role: &str) -> &str {
    match sender_role {
        "user" => "You",
        "owned-agent" | "agent" => "Kordi",
        other => other,
    }
}

/// Renders the inherited path as plain text. Returns the text and the number of
/// rendered messages, or None when nothing renders.
pub(super) fn inherited_history_text(path: &[CanonicalSessionMessage]) -> Option<(String, usize)> {
    let blocks = path
        .iter()
        .filter(|message| message.message_kind != "status")
        .filter_map(|message| {
            let text = message.content_text.trim();
            (!text.is_empty()).then(|| format!("{}:\n{}", sender_label(&message.sender_role), text))
        })
        .collect::<Vec<_>>();
    if blocks.is_empty() {
        return None;
    }

    // Keep the newest messages that fit; drop the oldest first.
    let mut kept_from = blocks.len();
    let mut body_len = 0usize;
    while kept_from > 0 {
        let block_len = blocks[kept_from - 1].chars().count() + 2;
        if body_len + block_len > INHERITED_HISTORY_BODY_LIMIT && kept_from < blocks.len() {
            break;
        }
        body_len += block_len;
        kept_from -= 1;
    }
    let kept = &blocks[kept_from..];
    let mut text = INHERITED_HISTORY_HEADER.to_string();
    if kept_from > 0 {
        text.push_str(&format!("\n[{kept_from} earlier messages omitted]"));
    }
    for block in kept {
        text.push_str("\n\n");
        text.push_str(block);
    }
    Some((text, kept.len()))
}

/// Copies the source branch into the fork as one unit; a failed copy leaves the
/// fork session exactly as it was.
fn copy_branch_atomically(
    local_conn: &Connection,
    source_session_id: &str,
    new_session_id: &str,
    anchor_id: &str,
) -> anyhow::Result<()> {
    local_conn.execute_batch("SAVEPOINT fork_copy")?;
    match kordi_session::store::copy_branch_to_session(
        local_conn,
        source_session_id,
        new_session_id,
        anchor_id,
    ) {
        Ok(()) => {
            local_conn.execute_batch("RELEASE fork_copy")?;
            Ok(())
        }
        Err(error) => {
            local_conn.execute_batch("ROLLBACK TO fork_copy; RELEASE fork_copy")?;
            Err(error)
        }
    }
}

/// Populates an empty fork runtime session: copy the source runtime branch when
/// the anchor entry exists there, otherwise append one hidden context message.
pub(super) fn populate_fork_runtime_session(
    local_conn: &Connection,
    source_session_id: &str,
    new_session_id: &str,
    candidate_anchor_ids: &[String],
    path: &[CanonicalSessionMessage],
    canonical_message_id: &str,
) -> anyhow::Result<()> {
    if !kordi_session::store::get_entries(local_conn, new_session_id)?.is_empty() {
        return Ok(());
    }

    if kordi_session::store::get_session(local_conn, source_session_id)?.is_some() {
        for anchor_id in candidate_anchor_ids {
            if kordi_session::store::get_entry(local_conn, source_session_id, anchor_id)?.is_some()
            {
                if copy_branch_atomically(local_conn, source_session_id, new_session_id, anchor_id)
                    .is_ok()
                {
                    return Ok(());
                }
                break;
            }
        }
    }

    // Read the leaf only now so a rolled-back copy cannot leave a stale parent.
    let Some((text, message_count)) = inherited_history_text(path) else {
        return Ok(());
    };
    let parent_id = kordi_session::store::get_session(local_conn, new_session_id)?
        .and_then(|session| session.leaf_id)
        .map(EntryId);
    let entry_id = EntryId::generate();
    let entry = SessionEntry::CustomMessage {
        base: EntryBase {
            id: entry_id.clone(),
            parent_id,
            timestamp: Utc::now(),
        },
        custom_type: INHERITED_HISTORY_CUSTOM_TYPE.to_string(),
        content: vec![ContentBlock::Text { text }],
        display: false,
        details: Some(serde_json::json!({
            "forkedFromSessionId": source_session_id,
            "forkedFromMessageId": canonical_message_id,
            "messageCount": message_count,
        })),
    };
    kordi_session::store::append_entry(local_conn, new_session_id, &entry)?;
    kordi_session::store::set_leaf(local_conn, new_session_id, Some(entry_id.as_str()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use kordi_core::types::{
        AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
        SessionEntry, StopReason, Usage, UserMessage,
    };
    use rusqlite::Connection;

    use super::{
        inherited_history_text, populate_fork_runtime_session, CanonicalSessionMessage,
        INHERITED_HISTORY_CUSTOM_TYPE,
    };

    const CWD: &str = "/tmp/kordi";

    fn message(id: &str, role: &str, kind: &str, text: &str) -> CanonicalSessionMessage {
        CanonicalSessionMessage {
            id: id.to_string(),
            session_id: "session:source".to_string(),
            sender_identity_id: format!("identity:{role}"),
            sender_role: role.to_string(),
            message_kind: kind.to_string(),
            content_text: text.to_string(),
            content: None,
            parent_message_id: None,
            delegated_exchange_id: None,
            status: "sent".to_string(),
            sequence_num: 0,
            created_at_ms: 0,
            updated_at_ms: 0,
            content_hash: None,
            source_transport: None,
            source_event_id: None,
        }
    }

    fn user_entry(id: &str, parent_id: Option<&str>, text: &str) -> SessionEntry {
        let now = Utc::now();
        SessionEntry::Message {
            base: EntryBase {
                id: EntryId(id.to_string()),
                parent_id: parent_id.map(|value| EntryId(value.to_string())),
                timestamp: now,
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                timestamp: now.timestamp_millis(),
            }),
        }
    }

    fn assistant_entry(id: &str, parent_id: &str, text: &str) -> SessionEntry {
        let now = Utc::now();
        SessionEntry::Message {
            base: EntryBase {
                id: EntryId(id.to_string()),
                parent_id: Some(EntryId(parent_id.to_string())),
                timestamp: now,
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: text.to_string(),
                }],
                provider: "test".to_string(),
                model: "test".to_string(),
                usage: Usage::default(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: now.timestamp_millis(),
            }),
        }
    }

    fn sample_path() -> Vec<CanonicalSessionMessage> {
        vec![
            message("msg-1", "user", "text", "Plan the launch"),
            message("msg-2", "owned-agent", "text", "Here is the plan"),
        ]
    }

    fn source_with_entries(conn: &Connection) {
        kordi_session::store::create_session_with_id(conn, "session:source", CWD).unwrap();
        kordi_session::store::append_entry(
            conn,
            "session:source",
            &user_entry("entry-user", None, "Plan the launch"),
        )
        .unwrap();
        kordi_session::store::append_entry(
            conn,
            "session:source",
            &assistant_entry("entry-assistant", "entry-user", "Here is the plan"),
        )
        .unwrap();
        kordi_session::store::append_entry(
            conn,
            "session:source",
            &user_entry("entry-later", Some("entry-assistant"), "Later message"),
        )
        .unwrap();
    }

    fn fork_shell(conn: &Connection) {
        kordi_session::store::create_session_with_id_parent_and_message(
            conn,
            "session:fork",
            CWD,
            Some("session:source"),
            Some("msg-2"),
        )
        .unwrap();
    }

    fn entry_ids(conn: &Connection, session_id: &str) -> Vec<String> {
        kordi_session::store::get_entries(conn, session_id)
            .unwrap()
            .into_iter()
            .map(|row| row.entry_id)
            .collect()
    }

    fn leaf(conn: &Connection, session_id: &str) -> Option<String> {
        kordi_session::store::get_session(conn, session_id)
            .unwrap()
            .and_then(|session| session.leaf_id)
    }

    fn inherited_history_payloads(conn: &Connection, session_id: &str) -> Vec<serde_json::Value> {
        kordi_session::store::get_entries(conn, session_id)
            .unwrap()
            .into_iter()
            .map(|row| serde_json::from_str::<serde_json::Value>(&row.payload).unwrap())
            .filter(|payload| payload["custom_type"] == INHERITED_HISTORY_CUSTOM_TYPE)
            .collect()
    }

    #[test]
    fn rendering_labels_senders_and_skips_empty_and_status_rows() {
        let path = vec![
            message("msg-1", "user", "text", "  Plan the launch  "),
            message("msg-2", "owned-agent", "status", "Thinking"),
            message("msg-3", "agent", "text", "   "),
            message("msg-4", "agent", "text", "Here is the plan"),
            message("msg-5", "system", "text", "Settings changed"),
        ];
        let (text, count) = inherited_history_text(&path).unwrap();
        assert_eq!(count, 3);
        assert_eq!(
            text,
            "Inherited conversation from the source chat through the forked message (application context, not a new request):\n\nYou:\nPlan the launch\n\nKordi:\nHere is the plan\n\nsystem:\nSettings changed"
        );
        assert!(inherited_history_text(&[]).is_none());
        assert!(inherited_history_text(&path[1..3]).is_none());
    }

    #[test]
    fn rendering_drops_the_oldest_messages_beyond_the_cap() {
        let long = "x".repeat(9_000);
        let path = (0..4)
            .map(|index| {
                message(
                    &format!("msg-{index}"),
                    "user",
                    "text",
                    &format!("{index}{long}"),
                )
            })
            .collect::<Vec<_>>();
        let (text, count) = inherited_history_text(&path).unwrap();
        assert_eq!(count, 2);
        assert!(text.contains("\n[2 earlier messages omitted]\n"));
        assert!(!text.contains(&format!("0{long}")));
        assert!(!text.contains(&format!("1{long}")));
        assert!(text.contains(&format!("2{long}")));
        assert!(text.ends_with(&format!("3{long}")));
    }

    #[test]
    fn native_runtime_branch_is_copied_through_the_anchor() {
        let conn = kordi_session::store::open_memory().unwrap();
        source_with_entries(&conn);
        fork_shell(&conn);
        populate_fork_runtime_session(
            &conn,
            "session:source",
            "session:fork",
            &["missing-entry".to_string(), "entry-assistant".to_string()],
            &sample_path(),
            "msg-2",
        )
        .unwrap();
        assert_eq!(
            entry_ids(&conn, "session:fork"),
            vec!["entry-user", "entry-assistant"]
        );
        assert_eq!(
            leaf(&conn, "session:fork").as_deref(),
            Some("entry-assistant")
        );
        assert!(inherited_history_payloads(&conn, "session:fork").is_empty());
    }

    #[test]
    fn missing_runtime_anchor_falls_back_to_one_hidden_context_message() {
        for with_source in [true, false] {
            let conn = kordi_session::store::open_memory().unwrap();
            if with_source {
                source_with_entries(&conn);
            }
            fork_shell(&conn);
            populate_fork_runtime_session(
                &conn,
                "session:source",
                "session:fork",
                &["missing-entry".to_string()],
                &sample_path(),
                "msg-2",
            )
            .unwrap();
            let payloads = inherited_history_payloads(&conn, "session:fork");
            assert_eq!(payloads.len(), 1);
            assert_eq!(entry_ids(&conn, "session:fork").len(), 1);
            let payload = &payloads[0];
            assert_eq!(payload["display"], false);
            assert_eq!(payload["details"]["forkedFromSessionId"], "session:source");
            assert_eq!(payload["details"]["forkedFromMessageId"], "msg-2");
            assert_eq!(payload["details"]["messageCount"], 2);
            let text = payload["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("You:\nPlan the launch\n\nKordi:\nHere is the plan"));
            assert_eq!(
                leaf(&conn, "session:fork"),
                payload["id"].as_str().map(str::to_string)
            );
        }
    }

    #[test]
    fn failed_native_copy_is_discarded_and_falls_back() {
        let conn = kordi_session::store::open_memory().unwrap();
        source_with_entries(&conn);
        conn.execute(
            "INSERT INTO entries (session_id, seq, entry_id, parent_id, type, timestamp, payload)
             VALUES ('session:source', 100, 'entry-broken', 'entry-assistant', 'message',
                     '2026-01-01T00:00:00Z', 'not json')",
            [],
        )
        .unwrap();
        fork_shell(&conn);
        populate_fork_runtime_session(
            &conn,
            "session:source",
            "session:fork",
            &["entry-broken".to_string()],
            &sample_path(),
            "msg-2",
        )
        .unwrap();
        let ids = entry_ids(&conn, "session:fork");
        assert_eq!(ids.len(), 1);
        assert!(!ids.iter().any(|id| id.starts_with("entry-")));
        let payloads = inherited_history_payloads(&conn, "session:fork");
        assert_eq!(payloads.len(), 1);
        assert!(payloads[0]["parent_id"].is_null());
        assert_eq!(
            leaf(&conn, "session:fork"),
            payloads[0]["id"].as_str().map(str::to_string)
        );
    }

    #[test]
    fn fallback_is_skipped_when_nothing_renders() {
        let conn = kordi_session::store::open_memory().unwrap();
        fork_shell(&conn);
        populate_fork_runtime_session(
            &conn,
            "session:source",
            "session:fork",
            &[],
            &[message("msg-1", "agent", "status", "Thinking")],
            "msg-1",
        )
        .unwrap();
        assert!(entry_ids(&conn, "session:fork").is_empty());
    }

    #[test]
    fn populated_fork_runtime_sessions_are_left_alone() {
        let conn = kordi_session::store::open_memory().unwrap();
        source_with_entries(&conn);
        fork_shell(&conn);
        kordi_session::store::append_entry(
            &conn,
            "session:fork",
            &user_entry("entry-existing", None, "Already here"),
        )
        .unwrap();
        populate_fork_runtime_session(
            &conn,
            "session:source",
            "session:fork",
            &["entry-assistant".to_string()],
            &sample_path(),
            "msg-2",
        )
        .unwrap();
        assert_eq!(entry_ids(&conn, "session:fork"), vec!["entry-existing"]);
        assert_eq!(
            leaf(&conn, "session:fork").as_deref(),
            Some("entry-existing")
        );
    }
}
