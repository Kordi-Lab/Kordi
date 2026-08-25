use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

#[cfg(test)]
use super::http::validate_message_request;
use super::http::MessageValidationError;
use crate::chat_sync::models::SendMessageRequest;

const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
const MAX_LEGACY_GROUP_ENVELOPE_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn normalize_legacy_group_envelope(
    request: &mut SendMessageRequest,
) -> Result<(), MessageValidationError> {
    let Some(blocks) = request
        .content
        .as_object_mut()
        .and_then(|content| content.get_mut("blocks"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for block in blocks {
        let Some(text) = block
            .as_object_mut()
            .and_then(|value| value.get_mut("text"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
        else {
            continue;
        };
        let Some(encoded) = text.strip_prefix(CLOUD_GROUP_PREFIX) else {
            continue;
        };
        if encoded.len() > MAX_LEGACY_GROUP_ENVELOPE_BYTES {
            return Err(MessageValidationError {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                code: "MESSAGE_TOO_LARGE",
                message: "Message content exceeds the encoded size limit.",
            });
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| invalid_group_envelope())?;
        let mut envelope: Value =
            serde_json::from_slice(&decoded).map_err(|_| invalid_group_envelope())?;
        let object = envelope
            .as_object_mut()
            .ok_or_else(invalid_group_envelope)?;
        if let Some(actor) = object.get_mut("actor").and_then(Value::as_object_mut) {
            actor.remove("avatarUrl");
        }
        if let Some(participants) = object.get_mut("participants").and_then(Value::as_array_mut) {
            for participant in participants {
                if let Some(value) = participant.as_object_mut() {
                    value.remove("avatarUrl");
                }
            }
        }
        let normalized = format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&envelope).map_err(|_| invalid_group_envelope())?)
        );
        if let Some(value) = block
            .as_object_mut()
            .and_then(|value| value.get_mut("text"))
        {
            *value = Value::String(normalized);
        }
    }
    Ok(())
}

fn invalid_group_envelope() -> MessageValidationError {
    MessageValidationError {
        status: StatusCode::BAD_REQUEST,
        code: "INVALID_MESSAGE_CONTENT",
        message: "Group message content is invalid.",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::chat_sync::routes::MAX_MESSAGE_CONTENT_BYTES;

    #[test]
    fn drops_avatar_bytes_before_size_validation() {
        let envelope = json!({
            "kind": "group-message",
            "groupId": "session:group:test",
            "createdByAccountId": "acct_me",
            "actor": {
                "accountId": "acct_me",
                "displayName": "Me",
                "avatarUrl": format!("data:image/jpeg;base64,{}", "a".repeat(190_000))
            },
            "participants": [{
                "accountId": "acct_me",
                "displayName": "Me",
                "avatarUrl": format!("data:image/jpeg;base64,{}", "b".repeat(190_000))
            }],
            "message": {
                "id": "message",
                "senderAccountId": "acct_me",
                "text": "hello",
                "createdAtMs": 1
            }
        });
        let body = format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
        );
        let mut request = SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": body }]
            }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        };

        assert!(serde_json::to_vec(&request.content).unwrap().len() > MAX_MESSAGE_CONTENT_BYTES);
        normalize_legacy_group_envelope(&mut request).expect("normalize group envelope");
        validate_message_request(&request).expect("normalized message is valid");
        let normalized_body = request.content["blocks"][0]["text"].as_str().unwrap();
        let decoded = URL_SAFE_NO_PAD
            .decode(normalized_body.trim_start_matches(CLOUD_GROUP_PREFIX))
            .unwrap();
        let normalized: Value = serde_json::from_slice(&decoded).unwrap();
        assert!(normalized["actor"].get("avatarUrl").is_none());
        assert!(normalized["participants"][0].get("avatarUrl").is_none());
    }
}
