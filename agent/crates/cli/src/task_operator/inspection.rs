use anyhow::Result;
use kordi_core::types::{AgentMessage, AssistantContent, SessionEntry, StopReason};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundSessionInspection {
    pub status: String,
    pub summary: Option<String>,
}

fn assistant_text(message: &kordi_core::types::AssistantMessage) -> Option<String> {
    let text = message
        .content
        .iter()
        .filter_map(|content| match content {
            AssistantContent::Text { text } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

pub(crate) fn inspect_persisted_background_session(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<BackgroundSessionInspection> {
    let path = kordi_session::tree::active_path(conn, session_id)?;
    let messages = path
        .into_iter()
        .filter_map(|row| match kordi_session::store::parse_entry(&row) {
            Ok(SessionEntry::Message { message, .. }) => Some(Ok(message)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(inspect_background_messages(messages))
}

pub(super) fn inspect_background_messages(
    messages: impl IntoIterator<Item = AgentMessage>,
) -> BackgroundSessionInspection {
    let mut pending_request = false;
    let mut status = None;
    let mut summary = None;

    for message in messages {
        match message {
            AgentMessage::User(_) => {
                pending_request = true;
                status = None;
                summary = None;
            }
            AgentMessage::Assistant(message) => {
                if let Some(text) = assistant_text(&message) {
                    summary = Some(text);
                }
                match message.stop_reason {
                    StopReason::Stop => {
                        pending_request = false;
                        status = Some("completed");
                    }
                    StopReason::Length => {
                        pending_request = false;
                        status = Some("failed");
                        summary = Some(match summary {
                            Some(partial) => format!(
                                "The background session reached its output limit before finishing.\n\nPartial output:\n{partial}"
                            ),
                            None => {
                                "The background session reached its output limit before finishing."
                                    .to_string()
                            }
                        });
                    }
                    StopReason::ToolUse => {
                        pending_request = true;
                        status = None;
                    }
                    StopReason::Error => {
                        pending_request = false;
                        status = Some("failed");
                        if let Some(error) = message
                            .error_message
                            .filter(|value| !value.trim().is_empty())
                        {
                            summary = Some(error);
                        }
                    }
                    StopReason::Aborted => {
                        pending_request = false;
                        status = Some("stopped");
                    }
                }
            }
            _ => {}
        }
    }

    if pending_request || status.is_none() {
        let interrupted = "The background session was interrupted before producing a final result.";
        return BackgroundSessionInspection {
            status: "failed".to_string(),
            summary: Some(match summary {
                Some(partial) => format!("{interrupted}\n\nPartial output:\n{partial}"),
                None => interrupted.to_string(),
            }),
        };
    }

    BackgroundSessionInspection {
        status: status.unwrap_or("failed").to_string(),
        summary,
    }
}

pub(super) fn truncate_summary(value: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let compact = value.trim();
    if compact.chars().count() <= MAX_CHARS {
        return compact.to_string();
    }
    let truncated = compact.chars().take(MAX_CHARS).collect::<String>();
    format!("{}…", truncated.trim_end())
}
