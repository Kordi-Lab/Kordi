use serde_json::json;

use super::*;

fn content(sender_name: &str, sender_agent_id: Option<&str>) -> Value {
    let mut message = json!({
        "id": "response",
        "senderAccountId": "acct_owner",
        "senderKind": "agent",
        "senderDisplayName": sender_name,
        "text": "done",
        "createdAtMs": 1
    });
    if let Some(sender_agent_id) = sender_agent_id {
        message["senderAgentId"] = Value::String(sender_agent_id.to_string());
    }
    let envelope = json!({
        "kind": "group-message",
        "groupId": "session:group:test",
        "createdByAccountId": "acct_requester",
        "actor": { "accountId": "acct_owner", "displayName": "Owner" },
        "participants": [{ "accountId": "acct_owner", "displayName": "Owner" }],
        "message": message
    });
    json!({
        "blocks": [{
            "type": "text",
            "text": format!("{CLOUD_GROUP_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap()))
        }]
    })
}

#[test]
fn repairs_legacy_default_agent_names_without_relabeling_custom_agents() {
    let mut legacy = content("Kordi", None);
    normalize_stored_group_agent_identity(
        &mut legacy,
        "acct_owner",
        "Kordirename11",
        Some("Shu Yang"),
    );
    let (envelope, _) = decode_group_envelope(&mut legacy).expect("group envelope");
    assert_eq!(envelope["message"]["senderDisplayName"], "Kordirename11");
    assert_eq!(
        envelope["message"]["senderAgentId"],
        "cloud-agent:acct_owner"
    );
    assert_eq!(envelope["message"]["senderOwnerName"], "Shu Yang");

    let mut custom = content("Research Agent", Some("cloud_agent_research"));
    normalize_stored_group_agent_identity(
        &mut custom,
        "acct_owner",
        "Kordirename11",
        Some("Shu Yang"),
    );
    let (envelope, _) = decode_group_envelope(&mut custom).expect("group envelope");
    assert_eq!(envelope["message"]["senderDisplayName"], "Research Agent");
}

#[test]
fn stored_envelopes_naming_another_sender_present_as_the_stored_sender() {
    let mut stored = content("Owner's Agent", Some("cloud_agent_research"));
    normalize_stored_group_agent_identity(
        &mut stored,
        "acct_member",
        "Member Kordi",
        Some("Member"),
    );
    let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
    let message = &envelope["message"];
    assert_eq!(message["senderAccountId"], "acct_member");
    assert_eq!(message["senderKind"], "human");
    assert_eq!(message["senderDisplayName"], "Member");
    for key in AGENT_SENDER_FIELDS {
        assert!(message.get(key).is_none(), "{key} must be removed");
    }
    assert_eq!(message["text"], "done");
}

fn with_message(message: Value) -> Value {
    let envelope = json!({
        "kind": "group-message",
        "groupId": "session:group:test",
        "createdByAccountId": "acct_owner",
        "actor": { "accountId": "acct_member", "displayName": "Member" },
        "participants": [],
        "message": message
    });
    json!({ "blocks": [{
        "type": "text",
        "text": encode_group_envelope(&envelope).unwrap()
    }] })
}

#[test]
fn stored_agent_messages_name_the_stored_sender_as_owner() {
    let mut stored = with_message(json!({
        "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
        "senderAgentId": "cloud_agent_other", "senderDisplayName": "Owner's Research Agent",
        "senderOwnerName": "Owner", "senderOwnerAccountId": "acct_owner", "text": "approved"
    }));
    normalize_stored_group_agent_identity(
        &mut stored,
        "acct_member",
        "Member Kordi",
        Some("Member"),
    );
    let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
    let message = &envelope["message"];
    assert_eq!(message["senderOwnerAccountId"], "acct_member");
    assert_eq!(message["senderOwnerName"], "Member");
    assert_eq!(
        custom_agent_claim(&stored, "acct_member").as_deref(),
        Some("cloud_agent_other")
    );
    assert_eq!(custom_agent_claim(&stored, "acct_owner"), None);

    // An agent that the stored sender does not own becomes its human message.
    apply_custom_agent_record(&mut stored, None, Some("Member".to_string()));
    let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "human");
    assert_eq!(message["senderDisplayName"], "Member");
    for key in AGENT_SENDER_FIELDS {
        assert!(message.get(key).is_none(), "{key} must be removed");
    }
    assert_eq!(custom_agent_claim(&stored, "acct_member"), None);

    let mut owned = with_message(json!({
        "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
        "senderAgentId": "cloud_agent_mine", "senderDisplayName": "Anything", "text": "ok"
    }));
    apply_custom_agent_record(&mut owned, Some("Research".to_string()), None);
    let (envelope, _) = decode_group_envelope(&mut owned).expect("group envelope");
    assert_eq!(envelope["message"]["senderDisplayName"], "Research");
    assert_eq!(envelope["message"]["senderKind"], "agent");

    let mut default_alias = with_message(json!({
        "id": "agent", "senderAccountId": "acct_member", "senderKind": "agent",
        "senderAgentId": "cloud-local-agent", "senderDisplayName": "Owner Kordi", "text": "ok"
    }));
    normalize_stored_group_agent_identity(
        &mut default_alias,
        "acct_member",
        "Member Kordi",
        Some("Member"),
    );
    let (envelope, _) = decode_group_envelope(&mut default_alias).expect("group envelope");
    assert_eq!(envelope["message"]["senderDisplayName"], "Member Kordi");
    assert_eq!(custom_agent_claim(&default_alias, "acct_member"), None);
}

#[test]
fn stored_human_messages_show_the_account_display_name() {
    let mut stored = with_message(json!({
        "id": "human", "senderAccountId": "acct_member", "senderKind": "human",
        "senderDisplayName": "Totally The Owner", "senderOwnerAccountId": "acct_owner",
        "text": "hello"
    }));
    normalize_stored_group_agent_identity(
        &mut stored,
        "acct_member",
        "Member Kordi",
        Some("Member"),
    );
    let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
    assert_eq!(envelope["message"]["senderDisplayName"], "Member");
    assert!(envelope["message"].get("senderOwnerAccountId").is_none());

    let mut unnamed = with_message(json!({
        "id": "human", "senderAccountId": "acct_member",
        "senderDisplayName": "Totally The Owner", "text": "hello"
    }));
    normalize_stored_group_agent_identity(&mut unnamed, "acct_member", "Kordi", None);
    let (envelope, _) = decode_group_envelope(&mut unnamed).expect("group envelope");
    assert!(envelope["message"].get("senderDisplayName").is_none());
}

#[test]
fn stored_envelopes_split_across_blocks_are_repaired_as_clients_read_them() {
    let named_owner = with_message(json!({
        "id": "named-owner", "senderAccountId": "acct_owner", "senderKind": "human",
        "senderDisplayName": "Owner", "text": "hello"
    }));
    let text = named_owner["blocks"][0]["text"].as_str().unwrap();
    let (head, tail) = text.split_at("kordi-cloud-".len());
    let mut stored = json!({ "blocks": [
        { "type": "text", "text": head },
        { "type": "text", "text": tail }
    ] });
    normalize_stored_group_agent_identity(&mut stored, "acct_member", "Kordi", Some("Member"));
    let joined = stored["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<String>();
    assert_eq!(joined, stored["blocks"][0]["text"].as_str().unwrap());
    let (envelope, _) = decode_group_envelope(&mut stored).expect("group envelope");
    assert_eq!(envelope["message"]["senderAccountId"], "acct_member");
    assert_eq!(envelope["message"]["senderDisplayName"], "Member");
}

#[test]
fn legacy_default_agent_aliases_belong_to_the_sender() {
    for alias in [
        "cloud-agent:acct_owner",
        "cloud-local-agent",
        "cloud-self:acct_owner",
    ] {
        assert!(is_default_agent_alias(alias, "acct_owner"), "{alias}");
    }
    assert!(!is_default_agent_alias(
        "cloud-agent:acct_other",
        "acct_owner"
    ));
    assert!(!is_default_agent_alias(
        "cloud-self:acct_other",
        "acct_owner"
    ));
    assert!(!is_default_agent_alias(
        "cloud_agent_research",
        "acct_owner"
    ));
}
