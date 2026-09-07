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
