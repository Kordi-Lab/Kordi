use kordi_core::types::{AgentMessage, ContentBlock, SessionEntry};
use std::borrow::Cow;

pub(super) fn apply(entries: &[SessionEntry]) -> Cow<'_, [SessionEntry]> {
    let latest = entries.iter().rev().find_map(|entry| match entry {
        SessionEntry::Custom {
            custom_type, data, ..
        } if custom_type == "history_image_visibility" => data.as_ref()?.as_array(),
        _ => None,
    });
    if !latest.is_some_and(|values| {
        values
            .iter()
            .any(|value| value["blocked"] == true || value["text"].is_string())
    }) {
        return Cow::Borrowed(entries);
    }
    let mut result = entries.to_vec();
    for entry in &mut result {
        let SessionEntry::Message {
            base,
            message: AgentMessage::User(user),
        } = entry
        else {
            continue;
        };
        let Some(binding) = latest.and_then(|values| {
            values
                .iter()
                .find(|value| value["entryId"].as_str() == Some(base.id.as_str()))
        }) else {
            continue;
        };
        if binding["blocked"] == true {
            user.content
                .retain(|block| !matches!(block, ContentBlock::Image { .. }));
        }
        if let Some(text) = binding["text"].as_str() {
            user.content
                .retain(|block| !matches!(block, ContentBlock::Text { .. }));
            user.content
                .insert(0, ContentBlock::Text { text: text.into() });
        }
        if user.content.is_empty() {
            user.content.push(ContentBlock::Text{text:"[The earlier image is unavailable. Retrieve current chat history before answering.]".into()});
        }
    }
    Cow::Owned(result)
}
