use super::{
    cloud_agent_control_request_id, cloud_direct_person_session_id,
    cloud_message_effective_created_at, cloud_message_requires_accepted_contact,
    contact_acceptance_hello_sync_summaries, legacy_self_message_client_id,
    normalize_cloud_message_body, sanitized_cloud_group_control_body, CLOUD_AGENT_CANCEL_PREFIX,
    CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_GROUP_CONTROL_PREFIX,
};
use base64::Engine as _;
use chrono::{TimeZone, Utc};

#[test]
fn cloud_agent_response_has_no_app_level_character_limit() {
    let body = format!("{CLOUD_AGENT_RESPONSE_PREFIX}{}", "a".repeat(200_000));

    assert_eq!(normalize_cloud_message_body(&body).unwrap(), body);
}

#[test]
fn cloud_group_control_messages_do_not_require_direct_contacts() {
    assert!(!cloud_message_requires_accepted_contact(
        "kordi-cloud-group:abc"
    ));
    assert!(cloud_message_requires_accepted_contact("hello"));
}

#[test]
fn cloud_message_effective_created_at_preserves_valid_client_instant_with_offset() {
    let now = Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap();
    assert_eq!(
        cloud_message_effective_created_at(Some("2026-05-14T03:30:00-07:00"), now),
        "2026-05-14T10:30:00+00:00"
    );
}

#[test]
fn cloud_message_effective_created_at_rejects_invalid_or_too_future_client_time() {
    let now = Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap();
    assert_eq!(
        cloud_message_effective_created_at(Some("bad timestamp"), now),
        "2026-05-14T12:00:00+00:00"
    );
    assert_eq!(
        cloud_message_effective_created_at(Some("2026-05-14T12:10:01Z"), now),
        "2026-05-14T12:00:00+00:00"
    );
}

#[test]
fn legacy_self_message_client_id_is_stable_and_session_scoped() {
    let first = legacy_self_message_client_id(
        "acct_me",
        Some("session:a"),
        "same prompt",
        "2026-07-22T12:15:12.674+00:00",
    );
    assert_eq!(
        first,
        legacy_self_message_client_id(
            "acct_me",
            Some("session:a"),
            "same prompt",
            "2026-07-22T12:15:12.674+00:00",
        )
    );
    assert_ne!(
        first,
        legacy_self_message_client_id(
            "acct_me",
            Some("session:b"),
            "same prompt",
            "2026-07-22T12:15:12.674+00:00",
        )
    );
}

#[test]
fn cloud_agent_control_request_id_validates_the_envelope_kind() {
    let response = format!(
        "{CLOUD_AGENT_RESPONSE_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "kind": "agent-response",
                "requestId": "msg_request",
                "text": "answer",
            })
            .to_string()
        )
    );
    let wrong_kind = format!(
        "{CLOUD_AGENT_CANCEL_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "kind": "agent-response",
                "requestId": "msg_request",
            })
            .to_string()
        )
    );

    assert_eq!(
        cloud_agent_control_request_id(&response).as_deref(),
        Some("msg_request")
    );
    assert_eq!(cloud_agent_control_request_id(&wrong_kind), None);
}

#[test]
fn cloud_group_control_sanitizer_removes_local_ids_and_data_avatars() {
    let envelope = serde_json::json!({
        "kind": "group-message",
        "groupId": "session:group:1",
        "groupSpaceId": "session:group:1",
        "groupTitle": null,
        "createdByAccountId": "acct_a",
        "actor": { "accountId": "acct_a", "displayName": "Alice", "avatarUrl": "data:image/jpeg;base64,".to_string() + &"x".repeat(5000), "role": "person" },
        "participants": [
            { "accountId": "acct_a", "displayName": "Alice", "avatarUrl": "data:image/jpeg;base64,".to_string() + &"x".repeat(5000), "role": "admin" },
            { "accountId": "kh_local", "displayName": "Local", "avatarUrl": null, "role": "self" },
            { "accountId": "acct_b", "displayName": "Bob", "avatarUrl": "https://images.test/bob.png", "role": "person" }
        ],
        "message": { "id": "msg_1", "senderAccountId": "acct_a", "text": "@BobKordi hi", "createdAtMs": 1 }
    });
    let body = format!(
        "{CLOUD_GROUP_CONTROL_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&envelope).unwrap())
    );

    let sanitized = sanitized_cloud_group_control_body(&body).expect("sanitize group control");
    assert!(sanitized.len() < 4_000);
    let encoded = sanitized.strip_prefix(CLOUD_GROUP_CONTROL_PREFIX).unwrap();
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&decoded).unwrap();

    assert_eq!(parsed["actor"]["avatarUrl"], serde_json::Value::Null);
    assert_eq!(parsed["participants"].as_array().unwrap().len(), 2);
    assert_eq!(
        parsed["participants"][0]["avatarUrl"],
        serde_json::Value::Null
    );
    assert_eq!(parsed["participants"][1]["accountId"], "acct_b");
}

#[test]
fn cloud_direct_person_session_id_is_stable_for_account_order() {
    assert_eq!(
        cloud_direct_person_session_id("acct_me", "acct_peer"),
        "session:direct-person:acct_me:acct_peer"
    );
    assert_eq!(
        cloud_direct_person_session_id("acct_peer", "acct_me"),
        "session:direct-person:acct_me:acct_peer"
    );
}

#[test]
fn contact_acceptance_hello_sync_events_cover_both_participants() {
    let (acceptor, requester) = contact_acceptance_hello_sync_summaries(
        "msg_hello",
        "acct_requester",
        "acct_acceptor",
        "hello",
        "2026-05-15T08:54:12Z",
    );

    assert_eq!(acceptor.from_account_id, "acct_acceptor");
    assert_eq!(acceptor.to_account_id, "acct_requester");
    assert_eq!(
        acceptor.session_id.as_deref(),
        Some("session:direct-person:acct_acceptor:acct_requester")
    );
    assert_eq!(acceptor.direction, "outgoing");
    assert_eq!(requester.from_account_id, "acct_acceptor");
    assert_eq!(requester.to_account_id, "acct_requester");
    assert_eq!(
        requester.session_id.as_deref(),
        Some("session:direct-person:acct_acceptor:acct_requester")
    );
    assert_eq!(requester.direction, "incoming");
    assert_eq!(
        acceptor.delivered_at.as_deref(),
        Some("2026-05-15T08:54:12Z")
    );
    assert_eq!(
        requester.delivered_at.as_deref(),
        Some("2026-05-15T08:54:12Z")
    );
}
