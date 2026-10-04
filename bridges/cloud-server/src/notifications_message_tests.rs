use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};

use super::content::is_agent_authored_message;
use super::*;

fn message(content: Value, attachments: usize) -> MessageSnapshot {
    MessageSnapshot {
        id: Uuid::now_v7(),
        client_message_id: Uuid::now_v7(),
        conversation_id: Uuid::now_v7(),
        conversation_sequence: 4,
        sender_account_id: "sender".to_string(),
        kind: "text".to_string(),
        content,
        reply_to_message_id: None,
        attachment_ids: (0..attachments)
            .map(|index| format!("file-{index}"))
            .collect(),
        version: 1,
        generation_status: None,
        provider_response_id: None,
        created_at: Utc::now(),
        edited_at: None,
        deleted_at: None,
        reactions: Vec::new(),
        attachment_reactions: Vec::new(),
    }
}

fn encoded_envelope(prefix: &str, value: Value) -> String {
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(value.to_string()))
}

#[test]
fn message_preview_is_compact_and_never_empty() {
    let text = message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": "  Hello\n  there  " }] }),
        0,
    );
    assert_eq!(
        message_preview(&text, 0),
        ("text".to_string(), "Hello there".to_string())
    );
    assert_eq!(
        message_preview(&message(json!({ "schema": 1, "blocks": [] }), 3), 0),
        ("files".to_string(), "Sent 3 files".to_string())
    );
    assert_eq!(
        message_preview(&message(json!({ "schema": 1, "blocks": [] }), 1), 1),
        ("image".to_string(), "Sent a photo".to_string())
    );
    assert_eq!(
        message_preview(
            &message(
                json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Hi :blob:blobwave:" }] }),
                0,
            ),
            0,
        ),
        ("text".to_string(), "Hi Emoji".to_string())
    );
}

#[test]
fn protocol_envelopes_use_visible_text_and_hide_control_rows() {
    let direct = encoded_envelope(
        CLOUD_DIRECT_MESSAGE_PREFIX,
        json!({ "kind": "message", "text": "Visible direct text" }),
    );
    let direct = message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": direct }] }),
        0,
    );
    assert_eq!(
        message_preview(&direct, 0),
        ("text".to_string(), "Visible direct text".to_string())
    );

    let agent = encoded_envelope(
        CLOUD_AGENT_RESPONSE_PREFIX,
        json!({ "kind": "agent-response", "text": "Finished the task" }),
    );
    let agent = message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": agent }] }),
        0,
    );
    assert_eq!(
        message_preview(&agent, 0),
        ("text".to_string(), "Finished the task".to_string())
    );

    let group_update = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({ "kind": "group-update", "message": null }),
    );
    let group_update = message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": group_update }] }),
        0,
    );
    assert!(!is_notifiable_message(&group_update));

    let cancel = message(
        json!({
            "schema": 1,
            "blocks": [{
                "type": "text",
                "text": format!("{CLOUD_AGENT_CANCEL_PREFIX}opaque")
            }]
        }),
        0,
    );
    assert!(!is_notifiable_message(&cancel));
}

#[test]
fn only_frontend_visible_messages_can_notify_or_restore_deleted_sessions() {
    let empty = message(json!({ "schema": 1, "blocks": [] }), 0);
    assert!(!is_frontend_visible_message(&empty));
    assert!(!is_notifiable_message(&empty));

    let attachment = message(json!({ "schema": 1, "blocks": [] }), 1);
    assert!(is_frontend_visible_message(&attachment));

    let text = message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Visible" }] }),
        0,
    );
    assert!(is_frontend_visible_message(&text));

    let mut snapshot = message(json!({ "schema": 1, "blocks": [] }), 0);
    snapshot.kind = "agent_control".to_string();
    assert!(!is_frontend_visible_message(&snapshot));
    assert!(!is_notifiable_message(&snapshot));
}

#[test]
fn only_agent_envelopes_allow_notifying_the_sender_account() {
    let direct_agent = encoded_envelope(
        CLOUD_AGENT_RESPONSE_PREFIX,
        json!({ "kind": "agent-response", "text": "Finished the task" }),
    );
    assert!(is_agent_authored_message(&message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": direct_agent }] }),
        0,
    )));

    let group_agent = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({
            "kind": "group-message",
            "message": { "senderKind": "agent", "text": "Shared result" }
        }),
    );
    assert!(is_agent_authored_message(&message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": group_agent }] }),
        0,
    )));

    let group_human = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({
            "kind": "group-message",
            "message": { "senderKind": "human", "text": "My own message" }
        }),
    );
    assert!(!is_agent_authored_message(&message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": group_human }] }),
        0,
    )));
    assert!(!is_agent_authored_message(&message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Plain message" }] }),
        0,
    )));
}

fn text_message(text: &str) -> MessageSnapshot {
    message(
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": text }] }),
        0,
    )
}

#[test]
fn agent_notifications_use_the_agent_display_name_with_an_ai_label() {
    let direct_agent = encoded_envelope(
        CLOUD_AGENT_RESPONSE_PREFIX,
        json!({ "kind": "agent-response", "text": "Finished" }),
    );
    let direct_agent = text_message(&direct_agent);
    assert_eq!(
        notification_sender_display_name(&direct_agent, "Alex".to_string(), Some("Scout"), false),
        "Scout (AI)"
    );
    assert_eq!(
        notification_sender_display_name(&direct_agent, "Alex".to_string(), None, false),
        "Kordi (AI)"
    );
    assert_eq!(
        notification_sender_display_name(&direct_agent, "Alex".to_string(), Some("  "), false),
        "Kordi (AI)"
    );

    let group_agent = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({
            "kind": "group-message",
            "message": {
                "senderKind": "agent",
                "senderDisplayName": "Researcher · Maya's Agent",
                "text": "Finished"
            }
        }),
    );
    assert_eq!(
        notification_sender_display_name(
            &text_message(&group_agent),
            "Maya".to_string(),
            Some("Scout"),
            false,
        ),
        "Researcher · Maya's Agent (AI)"
    );
}

#[test]
fn human_and_pip_notification_titles() {
    let group_human = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({
            "kind": "group-message",
            "message": { "senderKind": "human", "senderDisplayName": "Maya", "text": "Hi" }
        }),
    );
    assert_eq!(
        notification_sender_display_name(
            &text_message(&group_human),
            "Fallback".to_string(),
            Some("Scout"),
            false,
        ),
        "Maya"
    );
    assert_eq!(
        notification_sender_display_name(&text_message("Plain"), "Maya".to_string(), None, false),
        "Maya"
    );
    // PiP posts as an ordinary member, so its account name gets the label.
    let pip_group = encoded_envelope(
        CLOUD_GROUP_PREFIX,
        json!({
            "kind": "group-message",
            "message": { "senderKind": "human", "senderDisplayName": "PiP", "text": "Plan" }
        }),
    );
    assert_eq!(
        notification_sender_display_name(&text_message(&pip_group), "PiP".to_string(), None, true,),
        "PiP (AI)"
    );
    assert_eq!(
        notification_sender_display_name(
            &message(json!({ "schema": 1, "blocks": [] }), 1),
            "PiP".to_string(),
            None,
            true
        ),
        "PiP (AI)"
    );
}

#[test]
fn previews_off_title_stays_kordi_for_agent_messages() {
    let event = MessageAttentionEvent {
        event_id: Uuid::now_v7(),
        account_id: "recipient".to_string(),
        session_id: Uuid::now_v7(),
        message_id: Uuid::now_v7(),
        message_sequence: 1,
        thread_root_id: None,
        conversation_kind: "group".to_string(),
        sender_display_name: "Scout (AI)".to_string(),
        preview_kind: "text".to_string(),
        preview_text: "Private text".to_string(),
        absolute_unread_count: 1,
    };
    let hidden = push_alert(false, &event);
    assert_eq!((hidden.title, hidden.body), ("Kordi", "New message"));
    let shown = push_alert(true, &event);
    assert_eq!((shown.title, shown.body), ("Scout (AI)", "Private text"));
}

#[test]
fn ai_access_notices_are_not_frontend_visible() {
    let mut notice = text_message("Maya turned off PiP in this group.");
    notice.kind = "ai-access-notice".to_string();
    assert!(!is_frontend_visible_message(&notice));
    assert!(!is_notifiable_message(&notice));
    notice.kind = "text".to_string();
    assert!(is_frontend_visible_message(&notice));
}

#[test]
fn message_payload_uses_absolute_badge_thread_and_opaque_routing_fields() {
    let event = MessageAttentionEvent {
        event_id: Uuid::now_v7(),
        account_id: "recipient".to_string(),
        session_id: Uuid::now_v7(),
        message_id: Uuid::now_v7(),
        message_sequence: 8,
        thread_root_id: Some(Uuid::now_v7()),
        conversation_kind: "direct".to_string(),
        sender_display_name: "Maya".to_string(),
        preview_kind: "text".to_string(),
        preview_text: "Hello".to_string(),
        absolute_unread_count: 5,
    };
    let event_id = event.event_id.to_string();
    let session_id = event.session_id.to_string();
    let message_id = event.message_id.to_string();
    let payload = MessagePushPayload {
        aps: MessagePushAps {
            alert: MessagePushAlert {
                title: "Maya",
                body: "Hello",
            },
            badge: Some(5),
            sound: Some("default"),
            category: MESSAGE_CATEGORY,
            thread_id: &session_id,
        },
        notification_type: "message",
        account_id: "recipient",
        session_id: &session_id,
        message_id: &message_id,
        message_sequence: event.message_sequence,
        thread_root_id: event.thread_root_id.map(|id| id.to_string()),
        options: NotificationOptions {
            apns_id: Some(&event_id),
            ..Default::default()
        },
        device_token: "token",
    };
    let value: Value = serde_json::from_str(&payload.to_json_string().unwrap()).unwrap();
    assert_eq!(value["aps"]["badge"], 5);
    assert_eq!(value["aps"]["category"], MESSAGE_CATEGORY);
    assert_eq!(value["aps"]["thread-id"], session_id);
    assert_eq!(
        value["thread_root_id"],
        event.thread_root_id.unwrap().to_string()
    );
    assert_eq!(value["notification_type"], "message");
    assert_eq!(value["message_id"], message_id);
    assert_eq!(value["message_sequence"], 8);
}
