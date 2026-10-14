use anyhow::Result;

use super::super::DesktopChatSessionSummary;
use super::{
    fallback_session_display_title, repair_session_title_from_history, session_activity_label,
    session_activity_timestamp_ms,
};

pub(super) fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: kordi_session::store::SessionRow,
) -> Result<DesktopChatSessionSummary> {
    let updated_at_ms = session_activity_timestamp_ms(conn, &row);
    let updated_at_label = session_activity_label(conn, &row);
    let title = repair_session_title_from_history(conn, &row)?
        .unwrap_or_else(fallback_session_display_title);
    let subtitle = match kordi_session::context::build_context(conn, &row.session_id) {
        Ok(context) => context
            .model
            .map(|model| format!("{}/{}", model.provider, model.model_id))
            .unwrap_or_else(|| format!("{} entries", row.entry_count)),
        Err(_) => format!("{} entries", row.entry_count),
    };
    let background_status = row.parent_session_id.as_ref().and_then(|_| {
        crate::task_operator::inspect_persisted_background_session(conn, &row.session_id)
            .ok()
            .map(|inspection| inspection.status)
    });

    Ok(DesktopChatSessionSummary {
        id: row.session_id,
        title,
        subtitle,
        updated_at_label,
        updated_at_ms,
        message_count: row.entry_count.max(0) as usize,
        draft: false,
        background_status,
        forked_from_session_id: row.parent_session_id,
        forked_from_message_id: row.parent_session_message_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kordi_core::types::{
        AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
        SessionEntry, StopReason, Usage, UserMessage,
    };

    fn base(conn: &rusqlite::Connection, session_id: &str) -> EntryBase {
        EntryBase {
            id: EntryId::generate(),
            parent_id: crate::turn_runner::get_leaf_raw(conn, session_id),
            timestamp: Utc::now(),
        }
    }

    fn append_turn(conn: &rusqlite::Connection, session_id: &str, prompt: &str, failed: bool) {
        let user = SessionEntry::Message {
            base: base(conn, session_id),
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: prompt.to_string(),
                }],
                timestamp: Utc::now().timestamp_millis(),
            }),
        };
        kordi_session::store::append_entry(conn, session_id, &user).expect("user entry");
        let (text, stop_reason) = if failed {
            ("Provider is unavailable.", StopReason::Error)
        } else {
            ("I am Kordi.", StopReason::Stop)
        };
        let reply = SessionEntry::Message {
            base: base(conn, session_id),
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: text.to_string(),
                }],
                provider: "openai".to_string(),
                model: "gpt-5".to_string(),
                usage: Usage::default(),
                stop_reason,
                error_message: failed.then(|| text.to_string()),
                timestamp: Utc::now().timestamp_millis(),
            }),
        };
        kordi_session::store::append_entry(conn, session_id, &reply).expect("reply entry");
    }

    fn summary_title(conn: &rusqlite::Connection, session_id: &str) -> String {
        let row = kordi_session::store::get_session(conn, session_id)
            .expect("row")
            .expect("session exists");
        session_summary_from_row(conn, row).expect("summary").title
    }

    #[test]
    fn failed_first_turns_still_name_the_session_from_the_first_meaningful_message() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let session_id = kordi_session::store::create_session(&conn, "/tmp/kordi").expect("id");
        append_turn(&conn, &session_id, "hi", true);
        append_turn(&conn, &session_id, "check this worktree", true);
        append_turn(&conn, &session_id, "which model are you using", false);

        assert_eq!(summary_title(&conn, &session_id), "Check this worktree");
        let row = kordi_session::store::get_session(&conn, &session_id)
            .expect("row")
            .expect("session exists");
        assert_eq!(
            row.title_source,
            kordi_session::store::SessionTitleSource::Auto
        );
    }

    #[test]
    fn sessions_without_a_title_seed_keep_the_placeholder_instead_of_a_dated_title() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let session_id = kordi_session::store::create_session(&conn, "/tmp/kordi").expect("id");
        let model_change = SessionEntry::ModelChange {
            base: base(&conn, &session_id),
            provider: "openai".to_string(),
            model_id: "gpt-5".to_string(),
        };
        kordi_session::store::append_entry(&conn, &session_id, &model_change).expect("entry");
        append_turn(&conn, &session_id, "hi", true);

        assert_eq!(summary_title(&conn, &session_id), "New chat");
    }

    #[test]
    fn stored_dated_fallback_is_replaced_but_a_manual_title_is_kept() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let session_id = kordi_session::store::create_session(&conn, "/tmp/kordi").expect("id");
        append_turn(&conn, &session_id, "check this worktree", true);
        conn.execute(
            "UPDATE sessions SET name = 'Chat with Kordi · Oct 13', title_source = 'legacy'
             WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .expect("seed dated fallback");
        assert_eq!(summary_title(&conn, &session_id), "Check this worktree");

        kordi_session::store::set_session_name(&conn, &session_id, Some("Trust review"))
            .expect("manual rename");
        append_turn(&conn, &session_id, "plan the security audit", false);
        assert_eq!(summary_title(&conn, &session_id), "Trust review");
    }
}
