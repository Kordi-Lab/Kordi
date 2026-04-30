use kordi_core::types::{
    AgentMessage, CompactionSummaryMessage, ContentBlock, CustomMessage, ModelInfo, SessionContext,
    SessionEntry, ThinkingLevel, UserMessage,
};

use super::formatting::{append_message, update_settings};

pub(super) fn build_context_from_entries(entries: &[SessionEntry]) -> SessionContext {
    let mut messages = Vec::new();
    let mut model: Option<ModelInfo> = None;
    let mut thinking_level = ThinkingLevel::Off;

    let compaction_idx = entries
        .iter()
        .enumerate()
        .rev()
        .find(|(_, entry)| matches!(entry, SessionEntry::Compaction { .. }))
        .map(|(idx, _)| idx);

    if let Some(comp_idx) = compaction_idx {
        let comp = &entries[comp_idx];

        if let SessionEntry::Compaction {
            summary,
            tokens_before,
            first_kept_entry_id,
            ..
        } = comp
        {
            messages.push(AgentMessage::CompactionSummary(CompactionSummaryMessage {
                summary: summary.clone(),
                tokens_before: *tokens_before,
                timestamp: comp.base().timestamp.timestamp_millis(),
            }));

            append_kept_messages_before_compaction(
                &mut messages,
                &entries[..comp_idx],
                first_kept_entry_id.as_str(),
                &mut model,
                &mut thinking_level,
            );
            append_messages_after_compaction(
                &mut messages,
                &entries[comp_idx + 1..],
                &mut model,
                &mut thinking_level,
            );
        }
    } else {
        append_messages_after_compaction(&mut messages, entries, &mut model, &mut thinking_level);
    }

    scope_runtime_attachments_to_current_submission(&mut messages);

    SessionContext {
        messages,
        thinking_level,
        model,
    }
}

const DESKTOP_ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";

fn scope_runtime_attachments_to_current_submission(messages: &mut [AgentMessage]) {
    let Some(latest_user_idx) = messages
        .iter()
        .rposition(|message| matches!(message, AgentMessage::User(_)))
    else {
        return;
    };

    let current_attachment_context_idx =
        messages
            .get(latest_user_idx + 1)
            .and_then(|message| match message {
                AgentMessage::Custom(custom)
                    if custom.custom_type == DESKTOP_ATTACHMENT_CONTEXT_CUSTOM_TYPE =>
                {
                    Some(latest_user_idx + 1)
                }
                _ => None,
            });

    for (idx, message) in messages.iter_mut().enumerate() {
        match message {
            AgentMessage::User(user) if idx != latest_user_idx => {
                replace_previous_user_images_with_references(user);
            }
            AgentMessage::Custom(custom)
                if custom.custom_type == DESKTOP_ATTACHMENT_CONTEXT_CUSTOM_TYPE
                    && Some(idx) != current_attachment_context_idx =>
            {
                replace_previous_attachment_context_with_references(custom);
            }
            _ => {}
        }
    }
}

fn replace_previous_user_images_with_references(user: &mut UserMessage) {
    let stripped_image_count = user
        .content
        .iter()
        .filter(|block| matches!(block, ContentBlock::Image { .. }))
        .count();
    if stripped_image_count == 0 {
        return;
    }

    user.content
        .retain(|block| !matches!(block, ContentBlock::Image { .. }));

    let has_text = user.content.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        ContentBlock::Image { .. } => false,
    });
    if !has_text {
        let label = if stripped_image_count == 1 {
            "[Previous image attachment]".to_string()
        } else {
            format!("[{stripped_image_count} previous image attachments]")
        };
        user.content.push(ContentBlock::Text { text: label });
    }
}

fn replace_previous_attachment_context_with_references(custom: &mut CustomMessage) {
    let reference_text = attachment_reference_text(&custom.details)
        .unwrap_or_else(|| "Previous attachment".to_string());
    custom.content = vec![ContentBlock::Text {
        text: reference_text,
    }];
}

fn attachment_reference_text(details: &Option<serde_json::Value>) -> Option<String> {
    let attachments = details.as_ref()?.get("attachments")?.as_array()?;
    if attachments.is_empty() {
        return None;
    }

    let lines = attachments
        .iter()
        .enumerate()
        .map(|(index, attachment)| {
            let name = attachment
                .get("name")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("attachment");
            let kind = attachment
                .get("kind")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty());
            let format = attachment
                .get("formatLabel")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty());
            let detail = match (kind, format) {
                (Some(kind), Some(format)) => format!(" ({kind}, {format})"),
                (Some(kind), None) => format!(" ({kind})"),
                (None, Some(format)) => format!(" ({format})"),
                (None, None) => String::new(),
            };
            format!("{}. {name}{detail}", index + 1)
        })
        .collect::<Vec<_>>();

    let title = if lines.len() == 1 {
        "Previous attachment"
    } else {
        "Previous attachments"
    };
    Some(format!("{title}:\n{}", lines.join("\n")))
}

fn append_kept_messages_before_compaction(
    messages: &mut Vec<AgentMessage>,
    entries: &[SessionEntry],
    first_kept_entry_id: &str,
    model: &mut Option<ModelInfo>,
    thinking_level: &mut ThinkingLevel,
) {
    let mut found = false;
    for entry in entries {
        if entry.base().id.as_str() == first_kept_entry_id {
            found = true;
        }
        if found {
            append_message(messages, entry);
        }
        update_settings(entry, model, thinking_level);
    }
}

fn append_messages_after_compaction(
    messages: &mut Vec<AgentMessage>,
    entries: &[SessionEntry],
    model: &mut Option<ModelInfo>,
    thinking_level: &mut ThinkingLevel,
) {
    for entry in entries {
        append_message(messages, entry);
        update_settings(entry, model, thinking_level);
    }
}
