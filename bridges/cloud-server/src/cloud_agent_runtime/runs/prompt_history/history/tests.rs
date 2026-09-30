use super::*;

fn row(id: &str, value: serde_json::Value) -> (String, String, String, String) {
    let body = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
    );
    (
        id.to_string(),
        format!("client-{id}"),
        "acct_owner".to_string(),
        body,
    )
}

#[test]
fn fallback_context_isolated_by_thread_before_history_limit() {
    let action = serde_json::json!({"kind":"thread","source":{"sourceMessageId":"root"}});
    let rows = vec![
        row("root", serde_json::json!({"kind":"message","text":"Root"})),
        row(
            "child-request",
            serde_json::json!({"kind":"message","text":"Thread request","messageAction":action}),
        ),
        row(
            "child-result",
            serde_json::json!({"kind":"agent-response","requestId":"child-request","text":"THREAD_ONLY"}),
        ),
        row(
            "main",
            serde_json::json!({"kind":"message","text":"Main request"}),
        ),
        row(
            "followup",
            serde_json::json!({"kind":"message","text":"Continue","messageAction":action}),
        ),
    ];
    assert_eq!(
        context_history_indices(&rows, "main", None),
        (Some(3), vec![0])
    );
    assert_eq!(
        context_history_indices(&rows, "followup", None),
        (Some(4), vec![0, 1, 2])
    );
    assert_eq!(
        context_history_indices(&rows, "ios_client-main", None),
        (Some(3), vec![0])
    );
}

#[test]
fn orphan_responses_and_forwarded_context_fail_closed() {
    let rows = vec![
        row(
            "orphan",
            serde_json::json!({"kind":"agent-response","requestId":"older-thread-request","text":"PRIVATE_THREAD"}),
        ),
        row(
            "forward",
            serde_json::json!({"kind":"message","text":"FORWARD","messageAction":{"kind":"forward"}}),
        ),
        row(
            "main",
            serde_json::json!({"kind":"message","text":"Main request"}),
        ),
    ];
    assert_eq!(
        context_history_indices(&rows, "main", None),
        (Some(2), vec![])
    );
}

fn group_body(sender_account_id: &str, sender_kind: &str, text: &str) -> String {
    let envelope = serde_json::json!({
        "kind": "group-message",
        "groupId": "session:group:history-labels",
        "groupTitle": null,
        "createdByAccountId": "acct_owner",
        "actor": { "accountId": sender_account_id, "displayName": "Actor", "avatarUrl": null, "role": "person" },
        "participants": [],
        "message": {
            "id": format!("message-{text}"),
            "senderAccountId": sender_account_id,
            "senderKind": sender_kind,
            "senderDisplayName": "Owner",
            "text": text,
            "createdAtMs": 1
        }
    });
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn history_message(from_account_id: &str, body: String) -> CloudFallbackHistoryMessage {
    CloudFallbackHistoryMessage {
        from_account_id: from_account_id.to_string(),
        body,
    }
}

#[test]
fn history_labels_speakers_from_the_stored_sender_account() {
    let prompt = fallback_prompt_with_history(
        "acct_requester",
        "acct_owner",
        "current",
        &[
            // A participant's envelope that names the owner's agent as sender.
            history_message(
                "acct_participant",
                group_body("acct_owner", "agent", "named owner agent text"),
            ),
            // A participant's envelope that names the owner as a human sender.
            history_message(
                "acct_participant",
                group_body("acct_owner", "human", "named owner text"),
            ),
            history_message(
                "acct_owner",
                group_body("acct_owner", "agent", "stored owner agent text"),
            ),
            history_message(
                "acct_owner",
                group_body("acct_owner", "human", "stored owner text"),
            ),
            history_message(
                "acct_requester",
                group_body("acct_requester", "human", "requester text"),
            ),
        ],
    );
    assert!(prompt.contains("Participant: named owner agent text"));
    assert!(prompt.contains("Participant: named owner text"));
    assert!(prompt.contains("Owner agent: stored owner agent text"));
    assert!(prompt.contains("Owner: stored owner text"));
    assert!(prompt.contains("Requester: requester text"));
    assert!(!prompt.contains("Owner agent: named"));
    assert!(!prompt.contains("Owner: named"));
}

#[test]
fn agent_messages_are_attributed_to_the_agent_of_the_stored_sender() {
    let prompt = fallback_prompt_with_history(
        "acct_requester",
        "acct_owner",
        "current",
        &[
            history_message(
                "acct_requester",
                group_body("acct_requester", "agent", "requester agent text"),
            ),
            history_message(
                "acct_participant",
                group_body("acct_participant", "agent", "participant agent text"),
            ),
        ],
    );
    assert!(prompt.contains("Requester agent: requester agent text"));
    assert!(prompt.contains("Participant agent: participant agent text"));
    assert!(!prompt.contains("Requester: requester agent text"));
}

#[test]
fn agent_response_bodies_are_owner_agent_only_when_stored_by_the_owner() {
    let response = |text: &str| {
        format!(
            "kordi-cloud-agent-response:{}",
            URL_SAFE_NO_PAD.encode(
                serde_json::json!({"kind":"agent-response","requestId":"request","text":text})
                    .to_string()
            )
        )
    };
    let prompt = fallback_prompt_with_history(
        "acct_requester",
        "acct_owner",
        "current",
        &[
            history_message("acct_requester", response("requester formatted text")),
            history_message("acct_participant", response("participant formatted text")),
            history_message("acct_owner", response("owner agent reply")),
        ],
    );
    // Replies from another account's agent stay in context under that
    // account's agent, never under the owner's agent or the human requester.
    assert!(prompt.contains("Requester agent: requester formatted text"));
    assert!(prompt.contains("Participant agent: participant formatted text"));
    assert!(prompt.contains("Owner agent: owner agent reply"));
    assert!(!prompt.contains("Owner agent: requester formatted text"));
    assert!(!prompt.contains("Requester: requester formatted text"));
}
