//! Requests that a turn never answered because its process ended.
//!
//! A turn lives in the memory of the process that runs it. When the desktop
//! app quits or is replaced mid-turn, the request stays the last message of
//! its session and every view of the session keeps waiting for an answer.
//! Closing it with the interruption note makes the transcript terminal, and
//! the note syncs like any failed reply.

use anyhow::Result;
use kordi_core::types::{AgentMessage, SessionEntry, StopReason};
use kordi_provider::registry::Model;
use kordi_session::store;

use super::persistence::{assistant_error_entry, get_leaf_raw};

const INTERRUPTED_REQUEST_NOTE: &str = "Previous request was interrupted before an answer was produced because the desktop app was refreshed or restarted.";

/// When the newest request on the active path that still waits for an answer
/// was stored, or `None` when every request was answered.
pub(super) fn unanswered_request_stored_at_ms(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<i64>> {
    let mut stored_at_ms = None;
    for row in kordi_session::tree::active_path(conn, session_id)? {
        let SessionEntry::Message { base, message } = store::parse_entry(&row)? else {
            continue;
        };
        match message {
            AgentMessage::User(_) => stored_at_ms = Some(base.timestamp.timestamp_millis()),
            AgentMessage::Assistant(assistant) if assistant.stop_reason != StopReason::ToolUse => {
                stored_at_ms = None;
            }
            _ => {}
        }
    }
    Ok(stored_at_ms)
}

pub(super) fn append_interrupted_request_note(
    conn: &rusqlite::Connection,
    session_id: &str,
    model: &Model,
) -> Result<()> {
    let entry = assistant_error_entry(
        get_leaf_raw(conn, session_id),
        model,
        INTERRUPTED_REQUEST_NOTE,
    );
    store::append_entry(conn, session_id, &entry)?;
    Ok(())
}

/// Closes the unanswered request of a session when an earlier process stored
/// it. A request stored at or after `process_started_at_ms` belongs to this
/// process, which owns its turn and closes it, so it is left alone. Returns
/// whether a request was closed.
// Only the desktop-runtime library calls this; the CLI binary shares the file.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn close_request_interrupted_before(
    conn: &rusqlite::Connection,
    session_id: &str,
    model: &Model,
    process_started_at_ms: i64,
) -> Result<bool> {
    let Some(stored_at_ms) = unanswered_request_stored_at_ms(conn, session_id)? else {
        return Ok(false);
    };
    if stored_at_ms >= process_started_at_ms {
        return Ok(false);
    }
    append_interrupted_request_note(conn, session_id, model)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use kordi_core::types::{
        AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId, Usage, UserMessage,
    };
    use kordi_provider::registry::{ApiType, CostConfig, ModelInput};

    fn model() -> Model {
        Model {
            id: "claude-opus-4-7".to_string(),
            name: "Claude Opus 4.7".to_string(),
            provider: "anthropic".to_string(),
            api: ApiType::AnthropicMessages,
            context_window: 1_000_000,
            max_tokens: 64_000,
            reasoning: true,
            input: vec![ModelInput::Text],
            base_url: None,
            cost: CostConfig::default(),
        }
    }

    fn session(session_id: &str) -> Result<rusqlite::Connection> {
        let conn = store::open_memory()?;
        store::create_session_with_id(&conn, session_id, "/tmp")?;
        Ok(conn)
    }

    fn append_user(conn: &rusqlite::Connection, session_id: &str, at_ms: i64) -> Result<()> {
        let timestamp = DateTime::from_timestamp_millis(at_ms).expect("a valid timestamp");
        let entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: get_leaf_raw(conn, session_id),
                timestamp,
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "check the worktree status".to_string(),
                }],
                timestamp: at_ms,
            }),
        };
        store::append_entry(conn, session_id, &entry)?;
        Ok(())
    }

    fn append_assistant(
        conn: &rusqlite::Connection,
        session_id: &str,
        stop_reason: StopReason,
    ) -> Result<()> {
        let entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: get_leaf_raw(conn, session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Thinking {
                    thinking: "Checking current git worktree status".to_string(),
                }],
                provider: "anthropic".to_string(),
                model: "claude-opus-4-7".to_string(),
                usage: Usage::default(),
                stop_reason,
                error_message: None,
                timestamp: Utc::now().timestamp_millis(),
            }),
        };
        store::append_entry(conn, session_id, &entry)?;
        Ok(())
    }

    fn last_assistant(conn: &rusqlite::Connection, session_id: &str) -> Result<AssistantMessage> {
        let path = kordi_session::tree::active_path(conn, session_id)?;
        let entry = store::parse_entry(path.last().expect("an entry"))?;
        let SessionEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = entry
        else {
            panic!("expected an assistant entry last");
        };
        Ok(assistant)
    }

    #[test]
    fn a_request_from_an_earlier_process_is_closed_once() -> Result<()> {
        let conn = session("restarted")?;
        let process_started_at_ms = Utc::now().timestamp_millis();
        append_user(&conn, "restarted", process_started_at_ms - 60_000)?;

        assert!(close_request_interrupted_before(
            &conn,
            "restarted",
            &model(),
            process_started_at_ms
        )?);
        let note = last_assistant(&conn, "restarted")?;
        assert_eq!(note.stop_reason, StopReason::Error);
        assert_eq!(
            note.error_message.as_deref(),
            Some(INTERRUPTED_REQUEST_NOTE)
        );
        assert!(!close_request_interrupted_before(
            &conn,
            "restarted",
            &model(),
            process_started_at_ms
        )?);
        Ok(())
    }

    #[test]
    fn a_turn_that_died_between_tool_calls_is_closed() -> Result<()> {
        let conn = session("mid-tools")?;
        let process_started_at_ms = Utc::now().timestamp_millis() + 60_000;
        append_user(&conn, "mid-tools", process_started_at_ms - 120_000)?;
        append_assistant(&conn, "mid-tools", StopReason::ToolUse)?;

        assert!(close_request_interrupted_before(
            &conn,
            "mid-tools",
            &model(),
            process_started_at_ms
        )?);
        assert_eq!(
            last_assistant(&conn, "mid-tools")?.stop_reason,
            StopReason::Error
        );
        Ok(())
    }

    #[test]
    fn a_request_of_this_process_is_left_to_its_turn() -> Result<()> {
        let conn = session("running")?;
        let process_started_at_ms = Utc::now().timestamp_millis() - 60_000;
        append_user(&conn, "running", process_started_at_ms + 1_000)?;

        assert!(!close_request_interrupted_before(
            &conn,
            "running",
            &model(),
            process_started_at_ms
        )?);
        assert_eq!(
            unanswered_request_stored_at_ms(&conn, "running")?,
            Some(process_started_at_ms + 1_000)
        );
        Ok(())
    }

    #[test]
    fn an_answered_request_is_left_alone() -> Result<()> {
        let conn = session("answered")?;
        let process_started_at_ms = Utc::now().timestamp_millis() + 60_000;
        append_user(&conn, "answered", process_started_at_ms - 120_000)?;
        append_assistant(&conn, "answered", StopReason::Stop)?;

        assert!(!close_request_interrupted_before(
            &conn,
            "answered",
            &model(),
            process_started_at_ms
        )?);
        Ok(())
    }
}
