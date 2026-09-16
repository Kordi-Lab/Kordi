use serde_json::json;
use uuid::Uuid;

use super::{
    require_cursor_codec, validate_message_request, ChatSyncRuntime, MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_MESSAGE_CONTENT_BYTES,
};
use crate::chat_sync::models::SendMessageRequest;

#[test]
fn signed_cursor_configuration_is_required() {
    let runtime = ChatSyncRuntime { cursor_codec: None };
    assert!(require_cursor_codec(&runtime).is_err());
}

#[test]
fn request_limits_are_bounded() {
    assert_eq!(MAX_MESSAGE_CONTENT_BYTES, 256 * 1024);
    assert_eq!(MAX_ATTACHMENTS_PER_MESSAGE, 32);
}

#[test]
fn durable_message_content_requires_schema_and_blocks() {
    let request = |content| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content,
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };

    assert!(validate_message_request(&request(json!({
        "schema": 1,
        "blocks": [{ "type": "text", "text": "hello" }]
    })))
    .is_ok());
    assert!(validate_message_request(&request(json!({ "blocks": [] }))).is_err());
    assert!(validate_message_request(&request(json!({ "schema": 1 }))).is_err());
    assert!(validate_message_request(&request(json!({
        "schema": 0,
        "blocks": []
    })))
    .is_err());
}

#[test]
fn meme_attachments_require_accessible_supported_image_metadata() {
    let attachment_id = "att_meme".to_string();
    let request = |attachment| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [],
            "legacy_attachments": [attachment]
        }),
        reply_to_message_id: None,
        attachment_ids: vec![attachment_id.clone()],
    };
    let valid = json!({
        "attachmentId": attachment_id,
        "name": "reaction.png",
        "kind": "image",
        "subtype": "meme",
        "altText": "Surprised cat says: when the tests pass on the first try.",
        "mimeType": "image/png"
    });

    assert!(validate_message_request(&request(valid.clone())).is_ok());

    let mut missing_alt = valid.clone();
    missing_alt["altText"] = json!("  ");
    assert!(validate_message_request(&request(missing_alt)).is_err());

    let mut unsupported_type = valid;
    unsupported_type["mimeType"] = json!("image/svg+xml");
    assert!(validate_message_request(&request(unsupported_type)).is_err());
}
