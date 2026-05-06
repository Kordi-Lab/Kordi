use anyhow::Result;
use chrono::Utc;
use kordi_core::types::*;
use kordi_monitor::ResolvedCacheUsage;
use kordi_provider::CollectedResponse;
use kordi_provider::registry::Model;
use kordi_session::store;
use std::sync::Arc;
use tokio::sync::Mutex;

fn next_entry_base(conn: &rusqlite::Connection, session_id: &str) -> EntryBase {
    EntryBase {
        id: EntryId::generate(),
        parent_id: get_leaf_raw(conn, session_id),
        timestamp: Utc::now(),
    }
}

fn assistant_content_from_response(collected: &CollectedResponse) -> Vec<AssistantContent> {
    let mut assistant_content = Vec::new();
    if !collected.thinking.is_empty() {
        assistant_content.push(AssistantContent::Thinking {
            thinking: collected.thinking.clone(),
        });
    }
    if !collected.text.is_empty() {
        assistant_content.push(AssistantContent::Text {
            text: collected.text.clone(),
        });
    }
    for tool_call in &collected.tool_calls {
        let arguments = serde_json::from_str(&tool_call.arguments).unwrap_or(serde_json::json!({}));
        assistant_content.push(AssistantContent::ToolCall {
            id: tool_call.id.clone(),
            name: tool_call.name.clone(),
            arguments,
        });
    }
    assistant_content
}

fn calculate_cost(model: &Model, usage: &ResolvedCacheUsage) -> Cost {
    let inp = usage.effective_input_tokens;
    let out = usage.effective_output_tokens;
    let cr = usage.effective_cache_read_tokens;
    let cw = usage.effective_cache_write_tokens;
    let model_cost = &model.cost;

    Cost {
        input: (model_cost.input / 1_000_000.0) * inp as f64,
        output: (model_cost.output / 1_000_000.0) * out as f64,
        cache_read: (model_cost.cache_read / 1_000_000.0) * cr as f64,
        cache_write: (model_cost.cache_write / 1_000_000.0) * cw as f64,
        total: (model_cost.input / 1_000_000.0) * inp as f64
            + (model_cost.output / 1_000_000.0) * out as f64
            + (model_cost.cache_read / 1_000_000.0) * cr as f64
            + (model_cost.cache_write / 1_000_000.0) * cw as f64,
    }
}

pub(crate) async fn append_user_message_with_images(
    conn: &Arc<Mutex<rusqlite::Connection>>,
    session_id: &str,
    prompt: &str,
    images: &[kordi_core::agent_session::ImageContent],
) -> Result<()> {
    let conn = conn.lock().await;
    let mut content = vec![ContentBlock::Text {
        text: prompt.to_string(),
    }];
    content.extend(images.iter().map(|image| {
        ContentBlock::Image {
            data: image.source.clone(),
            mime_type: image
                .mime_type
                .clone()
                .unwrap_or_else(|| "image/png".to_string()),
        }
    }));
    let user_entry = SessionEntry::Message {
        base: next_entry_base(&conn, session_id),
        message: AgentMessage::User(UserMessage {
            content,
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&conn, session_id, &user_entry)?;
    Ok(())
}

pub(super) async fn append_custom_message(
    conn: &Arc<Mutex<rusqlite::Connection>>,
    session_id: &str,
    message: serde_json::Value,
) -> Result<()> {
    let custom_message: CustomMessage = serde_json::from_value(message)?;
    let conn = conn.lock().await;
    let custom_entry = SessionEntry::CustomMessage {
        base: next_entry_base(&conn, session_id),
        custom_type: custom_message.custom_type,
        content: custom_message.content,
        display: custom_message.display,
        details: custom_message.details,
    };
    store::append_entry(&conn, session_id, &custom_entry)?;
    Ok(())
}

fn assistant_error_entry(parent_id: Option<EntryId>, model: &Model, message: &str) -> SessionEntry {
    SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id,
            timestamp: Utc::now(),
        },
        message: AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContent::Text {
                text: message.to_string(),
            }],
            provider: model.provider.clone(),
            model: model.id.clone(),
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            error_message: Some(message.to_string()),
            timestamp: Utc::now().timestamp_millis(),
        }),
    }
}

pub(super) async fn append_assistant_error_message(
    conn: &Arc<Mutex<rusqlite::Connection>>,
    session_id: &str,
    model: &Model,
    message: &str,
) -> Result<()> {
    let conn = conn.lock().await;
    let assistant_entry = assistant_error_entry(get_leaf_raw(&conn, session_id), model, message);
    store::append_entry(&conn, session_id, &assistant_entry)?;
    Ok(())
}

fn active_path_has_unanswered_user_request(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<bool> {
    let mut pending_user_request = false;
    for row in kordi_session::tree::active_path(conn, session_id)? {
        let entry = store::parse_entry(&row)?;
        let SessionEntry::Message { message, .. } = entry else {
            continue;
        };
        match message {
            AgentMessage::User(_) => pending_user_request = true,
            AgentMessage::Assistant(assistant) => {
                if assistant.stop_reason != StopReason::ToolUse {
                    pending_user_request = false;
                }
            }
            _ => {}
        }
    }
    Ok(pending_user_request)
}

pub(crate) async fn append_interrupted_unanswered_request_if_needed(
    conn: &Arc<Mutex<rusqlite::Connection>>,
    session_id: &str,
    model: &Model,
) -> Result<bool> {
    let conn = conn.lock().await;
    if !active_path_has_unanswered_user_request(&conn, session_id)? {
        return Ok(false);
    }

    let message = "Previous request was interrupted before an answer was produced because the desktop app was refreshed or restarted.";
    let assistant_entry = assistant_error_entry(get_leaf_raw(&conn, session_id), model, message);
    store::append_entry(&conn, session_id, &assistant_entry)?;
    Ok(true)
}

pub(super) fn append_assistant_message(
    conn: &rusqlite::Connection,
    session_id: &str,
    model: &Model,
    collected: &CollectedResponse,
    resolved_usage: &ResolvedCacheUsage,
    stop_reason: StopReason,
) -> Result<()> {
    let inp = resolved_usage.effective_input_tokens;
    let out = resolved_usage.effective_output_tokens;
    let cr = resolved_usage.effective_cache_read_tokens;
    let cw = resolved_usage.effective_cache_write_tokens;

    let assistant_entry = SessionEntry::Message {
        base: next_entry_base(conn, session_id),
        message: AgentMessage::Assistant(AssistantMessage {
            content: assistant_content_from_response(collected),
            provider: model.provider.clone(),
            model: model.id.clone(),
            usage: Usage {
                input: inp,
                output: out,
                cache_read: cr,
                cache_write: cw,
                total_tokens: inp + out + cr + cw,
                cost: calculate_cost(model, resolved_usage),
                cache_metrics_source: Some(resolved_usage.cache_metrics_source.clone()),
            },
            stop_reason,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(conn, session_id, &assistant_entry)?;
    Ok(())
}

pub(crate) fn get_leaf_raw(conn: &rusqlite::Connection, session_id: &str) -> Option<EntryId> {
    store::get_session(conn, session_id)
        .ok()
        .flatten()
        .and_then(|session| session.leaf_id.map(EntryId))
}

pub(crate) fn open_sibling_conn(
    conn: &rusqlite::Connection,
) -> Result<Arc<Mutex<rusqlite::Connection>>> {
    let path = conn.path().map(std::path::PathBuf::from);
    let new_conn = match path {
        Some(path) => store::open_db(&path)?,
        None => store::open_memory()?,
    };
    Ok(Arc::new(Mutex::new(new_conn)))
}

#[allow(dead_code)]
pub(crate) fn wrap_conn(conn: rusqlite::Connection) -> Arc<Mutex<rusqlite::Connection>> {
    Arc::new(Mutex::new(conn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_core::types::{AgentMessage, AssistantContent, SessionEntry, StopReason};
    use kordi_provider::registry::{ApiType, CostConfig, Model, ModelInput};

    fn test_model() -> Model {
        Model {
            id: "claude-opus-4-7".to_string(),
            name: "Claude Opus 4.7".to_string(),
            provider: "anthropic".to_string(),
            api: ApiType::AnthropicMessages,
            context_window: 1_000_000,
            max_tokens: 64_000,
            reasoning: true,
            input: vec![ModelInput::Text],
            base_url: Some("https://api.anthropic.com".to_string()),
            cost: CostConfig::default(),
        }
    }

    fn append_model_change(conn: &rusqlite::Connection, session_id: &str) -> Result<()> {
        let entry = SessionEntry::ModelChange {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: get_leaf_raw(conn, session_id),
                timestamp: Utc::now(),
            },
            provider: "anthropic".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        };
        store::append_entry(conn, session_id, &entry)?;
        Ok(())
    }

    #[tokio::test]
    async fn closes_stale_unanswered_user_before_appending_next_request() -> Result<()> {
        let session_id = "session-stale-user";
        let conn = kordi_session::store::open_memory()?;
        kordi_session::store::create_session_with_id(&conn, session_id, "/tmp")?;
        let conn = wrap_conn(conn);

        append_user_message_with_images(&conn, session_id, "show me the tools", &[]).await?;
        {
            let conn = conn.lock().await;
            append_model_change(&conn, session_id)?;
        }

        append_interrupted_unanswered_request_if_needed(&conn, session_id, &test_model()).await?;
        append_user_message_with_images(&conn, session_id, "which model are you using", &[])
            .await?;

        let conn = conn.lock().await;
        let path = kordi_session::tree::active_path(&conn, session_id)?;
        let entries = path
            .iter()
            .map(kordi_session::store::parse_entry)
            .collect::<Result<Vec<_>>>()?;

        assert!(matches!(
            entries[0],
            SessionEntry::Message {
                message: AgentMessage::User(_),
                ..
            }
        ));
        assert!(matches!(entries[1], SessionEntry::ModelChange { .. }));
        let SessionEntry::Message {
            base: interrupted_base,
            message: AgentMessage::Assistant(interrupted),
        } = &entries[2]
        else {
            panic!("expected interrupted assistant note before the next user request");
        };
        assert_eq!(interrupted.stop_reason, StopReason::Error);
        assert!(interrupted.error_message.as_deref().is_some_and(|message| {
            message.contains("interrupted") && message.contains("refreshed")
        }));
        assert!(interrupted.content.iter().any(|content| matches!(
            content,
            AssistantContent::Text { text } if text.contains("interrupted")
        )));
        let SessionEntry::Message {
            base: next_user_base,
            message: AgentMessage::User(next_user),
        } = &entries[3]
        else {
            panic!("expected next user request after interruption note");
        };
        assert_eq!(
            next_user_base.parent_id.as_ref().map(|id| id.as_str()),
            Some(interrupted_base.id.as_str())
        );
        assert_eq!(
            next_user
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
            "which model are you using"
        );
        Ok(())
    }
}
