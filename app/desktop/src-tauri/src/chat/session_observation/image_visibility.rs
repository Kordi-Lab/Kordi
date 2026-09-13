use kordi_cli::desktop_runtime::DesktopRuntimeSession;
use kordi_tools::{ReadSessionRequest, SessionObservationRuntime};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Revalidate previously synchronized image inputs before another model turn.
/// Persist only source bindings and visibility, never credentials or image bytes.
pub(in crate::chat) async fn refresh(
    runtime: &mut DesktopRuntimeSession,
    reader: &SessionObservationRuntime,
) -> Result<(), String> {
    let session = crate::cloud_session::cloud_session_load()?;
    let mut bindings = runtime
        .history_image_visibility()
        .map_err(|e| e.to_string())?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let Some(session) = session else {
        for binding in &mut bindings {
            binding["blocked"] = json!(true);
        }
        return runtime
            .set_history_image_visibility(json!(bindings))
            .map_err(|e| e.to_string());
    };
    {
        let conn = crate::canonical_sessions::open_db()?;
        let detail = runtime.detail().map_err(|e| e.to_string())?;
        for message in detail
            .messages
            .iter()
            .filter(|m| m.role == "user" && m.attachments.iter().any(|a| a.kind == "image"))
        {
            let Some(entry) = message.entry_id.as_deref() else {
                continue;
            };
            if bindings.iter().any(|b| b["entryId"] == entry) {
                continue;
            }
            let source: Option<(String,String)> = conn.query_row(
                "SELECT wire.message_id,c.client_session_id FROM chat_sync_messages wire
                 JOIN chat_sync_conversations c ON c.account_id=wire.account_id AND c.conversation_id=wire.conversation_id
                 WHERE wire.account_id=?1 AND c.client_session_id=?3 AND (wire.message_id=?2
                   OR json_extract(wire.snapshot_json,'$.content.canonical_history.local_message_id')=?2
                   OR json_extract(wire.snapshot_json,'$.content.canonical_history.localMessageId')=?2
                   OR wire.message_id IN (SELECT source_event_id FROM session_messages WHERE session_id=?3 AND json_extract(content_json,'$.desktopEntryId')=?2)) LIMIT 1",
                rusqlite::params![session.account_id,entry,runtime.session_id()], |row|Ok((row.get(0)?,row.get(1)?)),
            ).optional().map_err(|e|e.to_string())?;
            if let Some((message, scope)) = source {
                bindings.push(json!({"entryId":entry,"messageId":message,"sessionId":scope,"owner":session.account_id,"blocked":false}));
            }
        }
    }
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, binding) in bindings.iter_mut().enumerate() {
        if binding["owner"] != session.account_id {
            binding["blocked"] = json!(true);
            continue;
        }
        if let Some(scope) = binding["sessionId"].as_str() {
            groups.entry(scope.into()).or_default().push(index);
        }
    }
    for (scope, indices) in groups {
        for batch in indices.chunks(80) {
            let ids = batch
                .iter()
                .filter_map(|&i| bindings[i]["messageId"].as_str().map(str::to_owned))
                .collect();
            let response = (reader.read_session)(ReadSessionRequest {
                session_id: scope.clone(),
                mode: Some("messages".into()),
                message_ids: Some(ids),
                limit: Some(80),
                before_sequence: None,
                attachment_id: None,
                expected_version: None,
                offset: None,
                around_message_id: None,
            })
            .await;
            for &index in batch {
                let binding = &mut bindings[index];
                match &response {
                    Ok(response) => {
                        if let Some(object) = binding.as_object_mut() {
                            object.remove("text");
                        }
                        let message = response
                            .messages
                            .iter()
                            .find(|m| Some(m.message_id.as_str()) == binding["messageId"].as_str());
                        binding["blocked"] = json!(message
                            .is_none_or(|m| m.attachments.is_empty()
                                || m.attachments.iter().any(|a| a.message_version > 1)));
                        if message.is_none() {
                            binding["text"] =
                                json!("[This earlier message is deleted or no longer accessible.]");
                        }
                        // Edited source text must not be replaced with a truncated excerpt.
                        else if let Some(message) = message.filter(|m| {
                            m.next_offset.is_none()
                                && m.attachments.iter().any(|a| a.message_version > 1)
                        }) {
                            if let Some(text) = &message.text {
                                binding["text"] = json!(text);
                            }
                        }
                    }
                    Err(_) => {
                        binding["blocked"] = json!(true);
                    }
                }
            }
        }
    }
    runtime
        .set_history_image_visibility(Value::Array(bindings))
        .map_err(|e| e.to_string())
}
