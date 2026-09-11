use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use std::collections::HashSet;

const PREFIXES: [&str; 2] = ["kordi-cloud-message:", "kordi-cloud-group:"];

fn envelope(text: &str) -> Option<(&str, Value)> {
    let prefix = PREFIXES
        .into_iter()
        .find(|prefix| text.starts_with(prefix))?;
    let decoded = URL_SAFE_NO_PAD.decode(text.strip_prefix(prefix)?).ok()?;
    Some((prefix, serde_json::from_slice(&decoded).ok()?))
}

fn attachment_id(value: &Value) -> Option<&str> {
    value
        .get("attachmentId")
        .or_else(|| value.get("attachment_id"))
        .and_then(Value::as_str)
}

fn resource_ids(item: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Some(id) = attachment_id(item) {
        ids.insert(id.to_owned());
    }
    if let Some(live) = item.get("livePhoto") {
        for key in ["video", "playback"] {
            if let Some(id) = live.get(key).and_then(attachment_id) {
                ids.insert(id.to_owned());
            }
        }
    }
    ids
}

fn remove_from_metadata(
    value: &mut Value,
    targets: &HashSet<String>,
    removed: &mut HashSet<String>,
    retained: &mut HashSet<String>,
) {
    for key in ["legacy_attachments", "attachments"] {
        if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
            items.retain(|item| {
                if attachment_id(item).is_some_and(|id| targets.contains(id)) {
                    removed.extend(resource_ids(item));
                    false
                } else {
                    retained.extend(resource_ids(item));
                    true
                }
            });
        }
    }
    if let Some(message) = value.get_mut("message") {
        remove_from_metadata(message, targets, removed, retained);
    }
}

/// Remove references and unshared Live Photo companions without modifying
/// captions, other images, or metadata belonging to the remaining attachments.
pub(super) fn remove_references(content: &mut Value, removed: &mut HashSet<String>) {
    let targets = removed.clone();
    let mut retained = HashSet::new();
    remove_from_metadata(content, &targets, removed, &mut retained);
    if let Some(blocks) = content.get_mut("blocks").and_then(Value::as_array_mut) {
        for block in blocks.iter_mut() {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if let Some((prefix, mut payload)) = envelope(text) {
                    let prefix = prefix.to_owned();
                    remove_from_metadata(&mut payload, &targets, removed, &mut retained);
                    if let Ok(bytes) = serde_json::to_vec(&payload) {
                        block["text"] =
                            Value::String(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes)));
                    }
                }
            }
        }
        blocks.retain(|block| !attachment_id(block).is_some_and(|id| targets.contains(id)));
    }
    removed.retain(|id| targets.contains(id) || !retained.contains(id));
}

pub(super) fn is_live_component(content: &Value, id: &str) -> bool {
    for key in ["legacy_attachments", "attachments"] {
        if let Some(items) = content.get(key).and_then(Value::as_array) {
            if items.iter().any(|item| {
                item.get("livePhoto").is_some_and(|live| {
                    ["video", "playback"]
                        .into_iter()
                        .any(|key| live.get(key).and_then(attachment_id) == Some(id))
                })
            }) {
                return true;
            }
        }
    }
    if content
        .get("message")
        .is_some_and(|message| is_live_component(message, id))
    {
        return true;
    }
    content
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(envelope)
                    .is_some_and(|(_, payload)| is_live_component(&payload, id))
            })
        })
}

pub(super) fn has_content(content: &Value) -> bool {
    content
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return true;
                }
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some((_, payload)) = envelope(text) {
                    let payload = payload.get("message").unwrap_or(&payload);
                    return payload
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
                        || payload
                            .get("messageAction")
                            .is_some_and(|value| !value.is_null())
                        || payload
                            .get("structuredContent")
                            .is_some_and(|value| !value.is_null());
                }
                !text.trim().is_empty()
            })
        })
}

pub(super) fn metadata_is_photo(value: &Value, target: &str) -> bool {
    for key in ["legacy_attachments", "attachments"] {
        if value
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    attachment_id(item) == Some(target)
                        && (item.get("kind").and_then(Value::as_str) == Some("image")
                            || item
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .is_some_and(|mime| mime.starts_with("image/")))
                })
            })
        {
            return true;
        }
    }
    if value
        .get("message")
        .is_some_and(|message| metadata_is_photo(message, target))
    {
        return true;
    }
    value
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(envelope)
                    .is_some_and(|(_, payload)| metadata_is_photo(&payload, target))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn removing_a_live_photo_retains_shared_resources_and_other_captions() {
        let mut content = json!({"schema":1,"blocks":[{"type":"text","text":"Caption"}],"legacy_attachments":[
            {"attachmentId":"photo","kind":"image","livePhoto":{"video":{"attachmentId":"shared-video"},"playback":{"attachmentId":"playback"}}},
            {"attachmentId":"shared-video","kind":"file"}
        ]});
        assert!(is_live_component(&content, "shared-video"));
        let mut removed = HashSet::from(["photo".to_string()]);
        remove_references(&mut content, &mut removed);
        assert!(removed.contains("photo"));
        assert!(removed.contains("playback"));
        assert!(!removed.contains("shared-video"));
        assert_eq!(content["legacy_attachments"].as_array().unwrap().len(), 1);
        assert_eq!(content["blocks"][0]["text"], "Caption");
    }

    #[test]
    fn group_envelope_removal_keeps_identity_and_non_target_images() {
        let payload = json!({"kind":"group-message","message":{"id":"stable","senderAccountId":"owner","text":"Caption",
            "attachments":[{"attachmentId":"a","kind":"image"},{"attachmentId":"b","kind":"image"}]}});
        let encoded = format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        let mut content = json!({"schema":1,"blocks":[{"type":"text","text":encoded}]});
        let mut removed = HashSet::from(["a".to_string()]);
        remove_references(&mut content, &mut removed);
        let (_, updated) = envelope(content["blocks"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(updated["message"]["id"], "stable");
        assert_eq!(updated["message"]["senderAccountId"], "owner");
        assert_eq!(updated["message"]["text"], "Caption");
        assert_eq!(
            updated["message"]["attachments"].as_array().unwrap().len(),
            1
        );
        assert_eq!(updated["message"]["attachments"][0]["attachmentId"], "b");
    }
}
