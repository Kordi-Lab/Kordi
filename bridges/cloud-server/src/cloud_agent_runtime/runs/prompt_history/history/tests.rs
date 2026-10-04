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
    // Only the server id of the request selects it; transport aliases were
    // resolved for the request's sender before this point.
    assert_eq!(
        context_history_indices(&rows, "ios_client-main", None),
        (None, vec![0, 3])
    );
}

fn envelope_row(
    wire: &str,
    sender: &str,
    message: serde_json::Value,
) -> (String, String, String, String) {
    let envelope = serde_json::json!({
        "kind": "group-message", "groupId": "session:group:history", "groupTitle": null,
        "createdByAccountId": "acct_owner", "actor": {"accountId": sender, "displayName": "Actor"},
        "participants": [], "message": message
    });
    (
        wire.to_string(),
        format!("client-{wire}"),
        sender.to_string(),
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
        ),
    )
}

#[test]
fn the_oldest_row_keeps_a_duplicated_logical_id() {
    let rows = vec![
        envelope_row(
            "w-root",
            "acct_requester",
            serde_json::json!({"id": "root", "senderAccountId": "acct_requester", "text": "Root"}),
        ),
        envelope_row(
            "w-request",
            "acct_requester",
            serde_json::json!({"id": "logical-request", "senderAccountId": "acct_requester",
                "text": "@Owner continue", "messageAction": {"kind": "thread", "source": {"sourceMessageId": "root"}}}),
        ),
        // Another member later reuses both the request id and the thread root id.
        envelope_row(
            "w-reuse-request",
            "acct_member",
            serde_json::json!({"id": "logical-request", "senderAccountId": "acct_member", "text": "Not the request"}),
        ),
        envelope_row(
            "w-reuse-root",
            "acct_member",
            serde_json::json!({"id": "root", "senderAccountId": "acct_member", "text": "Not the root"}),
        ),
    ];
    let (request, history) = context_history_indices(&rows, "w-request", None);
    assert_eq!(request, Some(1), "the request is the sender-bound wire row");
    assert_eq!(
        history,
        vec![0],
        "the thread root resolves to the oldest row"
    );
}

#[test]
fn quote_previews_are_left_out_when_the_source_is_not_allowed() {
    let quote = |source: &str| {
        envelope_row(
            "w-quote",
            "acct_requester",
            serde_json::json!({"id": "q", "senderAccountId": "acct_requester", "senderKind": "human",
                "text": "see this", "createdAtMs": 1,
                "messageAction": {"kind": "quote", "source": {"sourceMessageId": source,
                    "senderLabel": "Member", "textPreview": "PRIVATE_PREVIEW"}}}),
        )
    };
    let history = |source: &str| {
        let (_, _, sender, body) = quote(source);
        vec![history_message(&sender, body)]
    };
    let allowed = fallback_prompt_with_history(
        "acct_requester",
        "acct_owner",
        "current",
        &history("visible"),
        &|id| id == "visible",
    );
    assert!(allowed.contains("[quotes message visible from Member: PRIVATE_PREVIEW]"));
    let redacted = fallback_prompt_with_history(
        "acct_requester",
        "acct_owner",
        "current",
        &history("hidden"),
        &|id| id == "visible",
    );
    assert!(redacted.contains("[quotes message hidden from Member]"));
    assert!(!redacted.contains("PRIVATE_PREVIEW"));
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
        &|_| true,
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
        &|_| true,
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
        &|_| true,
    );
    // Replies from another account's agent stay in context under that
    // account's agent, never under the owner's agent or the human requester.
    assert!(prompt.contains("Requester agent: requester formatted text"));
    assert!(prompt.contains("Participant agent: participant formatted text"));
    assert!(prompt.contains("Owner agent: owner agent reply"));
    assert!(!prompt.contains("Owner agent: requester formatted text"));
    assert!(!prompt.contains("Requester: requester formatted text"));
}
