use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::super::message::CLOUD_GROUP_PREFIX;
use super::identifiers::{identifier_key, MAX_IDENTIFIER_CHARS};
use super::*;

fn snapshot(content: Value) -> MessageSnapshot {
    MessageSnapshot {
        id: Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap(),
        client_message_id: Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap(),
        conversation_id: Uuid::parse_str("01900000-0000-7000-8000-000000000003").unwrap(),
        conversation_sequence: 1,
        sender_account_id: "acct-sender".to_string(),
        kind: "text".to_string(),
        content,
        reply_to_message_id: None,
        attachment_ids: vec!["att-1".to_string()],
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

fn encoded(prefix: &str, value: Value) -> String {
    format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
    )
}

fn text_content(text: String) -> Value {
    json!({ "schema": 1, "blocks": [{ "type": "text", "text": text }] })
}

#[test]
fn content_free_payload_keeps_only_the_message_id_and_conversation() {
    let id = Uuid::now_v7();
    let conversation = json!({ "id": "conversation", "members": [] });
    let payload = content_free_payload(id, Some(&conversation));
    let object = payload.as_object().unwrap();
    assert_eq!(object.len(), 2);
    assert_eq!(object["message_id"], id.to_string());
    assert_eq!(object["conversation"], conversation);
    assert_eq!(
        content_free_payload(id, None),
        json!({ "message_id": id.to_string() })
    );
}

#[test]
fn content_free_sql_reads_only_the_entity_id_and_conversation() {
    let sql = content_free_payload_sql!();
    assert!(sql.contains("event.entity_id::text"));
    assert!(sql.contains("event.payload -> 'conversation'"));
    assert!(!sql.contains("'message'"));
}

#[test]
fn identifiers_cover_canonical_client_ios_and_group_envelope_ids() {
    let group = encoded(
        CLOUD_GROUP_PREFIX,
        json!({ "kind": "group-message", "message": { "id": "group-logical-id", "text": "hi" } }),
    );
    let message = snapshot(text_content(group));
    assert_eq!(
        message_identifiers(&message),
        vec![
            message.id.to_string(),
            message.client_message_id.to_string(),
            format!("ios_{}", message.client_message_id),
            "group-logical-id".to_string(),
        ]
    );
}

#[test]
fn direct_envelopes_and_malformed_content_add_no_identifiers() {
    let direct = encoded(
        super::super::message::CLOUD_DIRECT_PREFIX,
        json!({ "schemaVersion": 1, "kind": "message", "id": "not-a-routing-id", "text": "hi" }),
    );
    for content in [
        text_content(direct),
        text_content(format!("{CLOUD_GROUP_PREFIX}not base64!")),
        text_content(encoded(
            CLOUD_GROUP_PREFIX,
            json!({ "message": { "id": 7 } }),
        )),
        text_content(encoded(
            CLOUD_GROUP_PREFIX,
            json!({ "message": { "id": "x".repeat(MAX_IDENTIFIER_CHARS + 1) } }),
        )),
        json!({ "blocks": "not a list" }),
        json!(null),
    ] {
        let message = snapshot(content);
        assert_eq!(
            message_identifiers(&message).len(),
            3,
            "{}",
            message.content
        );
    }
}

#[test]
fn identifiers_are_trimmed_and_deduplicated() {
    let group = encoded(
        CLOUD_GROUP_PREFIX,
        json!({ "message": { "id": " 01900000-0000-7000-8000-000000000001 " } }),
    );
    let message = snapshot(text_content(group));
    assert_eq!(message_identifiers(&message).len(), 3);
    assert_eq!(
        normalize_identifiers(["a".to_string(), " a ".to_string(), String::new()]),
        vec!["a".to_string()]
    );
}

#[test]
fn stored_snapshots_yield_the_same_identifiers() {
    let group = encoded(
        CLOUD_GROUP_PREFIX,
        json!({ "message": { "id": "group-logical-id" } }),
    );
    let message = snapshot(text_content(group));
    let stored = serde_json::to_value(&message).unwrap();
    assert_eq!(snapshot_identifiers(&stored), message_identifiers(&message));
    assert!(snapshot_identifiers(&json!({ "content": 5 })).is_empty());
}

#[test]
fn removal_reasons_mark_only_their_own_steps_pending() {
    let steps = |reason: RemovalReason| {
        let steps = reason.steps();
        (
            steps.digests,
            steps.records,
            steps.attachments,
            steps.quotes,
        )
    };
    assert_eq!(
        steps(RemovalReason::MessageDeleted),
        (true, true, true, true)
    );
    assert_eq!(
        steps(RemovalReason::MessageEdited),
        (true, false, false, false)
    );
    assert_eq!(
        steps(RemovalReason::MessageHidden),
        (true, false, false, false)
    );
    assert_eq!(
        steps(RemovalReason::AttachmentRemoved),
        (false, false, true, false)
    );
    assert_eq!(
        steps(RemovalReason::AttachmentReleased),
        (false, false, true, false)
    );
    assert_eq!(steps(RemovalReason::Backfill), (true, true, false, false));
    let reasons = [
        RemovalReason::MessageDeleted,
        RemovalReason::MessageEdited,
        RemovalReason::MessageHidden,
        RemovalReason::AttachmentRemoved,
        RemovalReason::AttachmentReleased,
        RemovalReason::Backfill,
    ];
    let migration = include_str!("../../../../migrations/0116_content_removal.sql");
    for reason in reasons {
        assert!(
            migration.contains(&format!("'{}'", reason.as_str())),
            "{} must be allowed by the job table",
            reason.as_str()
        );
    }
}

#[test]
fn identifiers_compare_without_prefixes_case_or_uuid_format() {
    let id = Uuid::parse_str("01900000-0000-7000-8000-00000000000a").unwrap();
    for form in [
        id.to_string(),
        format!("ios_{id}"),
        format!("collaboration-message:{id}"),
        id.to_string().to_uppercase(),
        id.simple().to_string(),
        format!(" {id} "),
    ] {
        assert_eq!(identifier_key(&form), id.to_string(), "{form}");
    }
    assert_eq!(identifier_key("Logical-ID"), "logical-id");
    assert_ne!(identifier_key("logical-a"), identifier_key("logical-b"));
}
