use super::*;

#[test]
fn explicit_default_targets_and_group_progress_keep_their_identity() {
    let direct = format!("{}{}", CLOUD_DIRECT_MESSAGE_PREFIX, URL_SAFE_NO_PAD.encode(serde_json::json!({
        "schemaVersion":1,"kind":"message","text":"@Kordi reply once",
        "targetCloudAgentId":"cloud-agent:acct_owner","targetCloudAgentOwnerAccountId":"acct_owner"
    }).to_string()));
    let target = direct_cloud_agent_target(&direct).unwrap();
    assert_eq!(target.agent_id, "cloud-agent:acct_owner");
    assert_eq!(target.owner_account_id, "acct_owner");
    let mut envelope = serde_json::json!({
        "kind":"group-message","groupId":"session:group:test","createdByAccountId":"acct_owner",
        "actor":{"accountId":"acct_owner","displayName":"Owner"},"participants":[],
        "message":{"id":"progress","senderAccountId":"acct_owner","senderKind":"agent",
            "text":"processing...","createdAtMs":1,"deliveryState":"processing","requestId":"ios-request"}
    });
    let encode = |value: &serde_json::Value| {
        format!(
            "{}{}",
            CLOUD_GROUP_PREFIX,
            URL_SAFE_NO_PAD.encode(value.to_string())
        )
    };
    assert!(cloud_agent_response_is_processing_for_request(
        &encode(&envelope),
        "ios-request"
    ));
    assert!(!cloud_agent_response_is_processing_for_request(
        &encode(&envelope),
        "another-request"
    ));
    envelope["message"]["deliveryState"] = serde_json::json!("complete");
    assert!(!cloud_agent_response_is_processing_for_request(
        &encode(&envelope),
        "ios-request"
    ));
}

fn direct_body(value: serde_json::Value) -> String {
    format!(
        "{CLOUD_DIRECT_MESSAGE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

fn agent_response_body(value: serde_json::Value) -> String {
    format!(
        "{CLOUD_AGENT_RESPONSE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

#[test]
fn processing_claim_matches_only_the_exact_request() {
    let body = agent_response_body(serde_json::json!({
        "kind": "agent-response",
        "requestId": "request-1",
        "deliveryState": "processing",
    }));

    assert!(cloud_agent_response_is_processing_for_request(
        &body,
        "request-1"
    ));
    assert!(!cloud_agent_response_is_processing_for_request(
        &body,
        "request-2"
    ));

    let complete = agent_response_body(serde_json::json!({
        "kind": "agent-response",
        "requestId": "request-1",
        "deliveryState": "complete",
    }));
    assert!(!cloud_agent_response_is_processing_for_request(
        &complete,
        "request-1"
    ));
}

#[test]
fn direct_agent_target_requires_the_canonical_message_envelope() {
    let valid = direct_body(serde_json::json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": "Help",
        "targetCloudAgentId": "cloud_agent_kordi_support",
        "targetCloudAgentOwnerAccountId": "acct_support",
        "targetCloudAgentOwnerName": "Kordi",
    }));
    let target = direct_cloud_agent_target(&valid).expect("valid direct target");
    assert_eq!(target.agent_id, "cloud_agent_kordi_support");
    assert_eq!(target.owner_account_id, "acct_support");
    assert_eq!(target.owner_name.as_deref(), Some("Kordi"));

    let wrong_kind = direct_body(serde_json::json!({
        "schemaVersion": 1,
        "kind": "agent-response",
        "targetCloudAgentId": "cloud_agent_kordi_support",
        "targetCloudAgentOwnerAccountId": "acct_support",
    }));
    assert!(direct_cloud_agent_target(&wrong_kind).is_none());
}
