use super::*;

#[test]
fn task_activity_sync_payload_keeps_session_and_task_identity() {
    let task = CloudTaskActivitySummary {
        task_activity_id: "taskact_1".to_string(),
        session_id: "session:group:one".to_string(),
        task_id: "task_1".to_string(),
        title: "Review launch plan".to_string(),
        summary: Some("Check risks".to_string()),
        status: "active".to_string(),
        created_by_account_id: "acct_a".to_string(),
        target_account_id: Some("acct_b".to_string()),
        participants: vec![serde_json::json!({"accountId":"acct_a","displayName":"Alice"})],
        artifact_ids: vec!["docs/plan.md".to_string()],
        response_message_id: Some("msg_response".to_string()),
        created_at: "2026-05-15T10:00:00Z".to_string(),
        updated_at: "2026-05-15T10:01:00Z".to_string(),
        archived_at: None,
    };

    let payload = task_activity_sync_payload(&task);

    assert_eq!(payload["task"]["sessionId"], "session:group:one");
    assert_eq!(payload["task"]["taskId"], "task_1");
    assert_eq!(payload["task"]["artifactIds"][0], "docs/plan.md");
}

#[test]
fn artifact_activity_sync_payload_keeps_attachment_reference() {
    let artifact = CloudArtifactActivitySummary {
        artifact_activity_id: "artifactact_1".to_string(),
        session_id: "session:group:one".to_string(),
        artifact_id: "docs/plan.md".to_string(),
        name: "plan.md".to_string(),
        path: "docs/plan.md".to_string(),
        kind: "document".to_string(),
        category: "artifact".to_string(),
        summary: Some("Generated plan".to_string()),
        created_by_account_id: "acct_a".to_string(),
        source_message_id: Some("msg_response".to_string()),
        attachment_id: Some("att_1".to_string()),
        content_type: Some("text/markdown".to_string()),
        size_bytes: Some(42),
        created_at: "2026-05-15T10:00:00Z".to_string(),
        updated_at: "2026-05-15T10:01:00Z".to_string(),
        archived_at: None,
    };

    let payload = artifact_activity_sync_payload(&artifact);

    assert_eq!(payload["artifact"]["sessionId"], "session:group:one");
    assert_eq!(payload["artifact"]["artifactId"], "docs/plan.md");
    assert_eq!(payload["artifact"]["attachmentId"], "att_1");
}

#[test]
fn cloud_activity_recipient_ids_exclude_duplicates_and_empty_values() {
    let recipients = cloud_activity_recipient_ids(
        "acct_owner",
        &[
            "acct_b".to_string(),
            "acct_owner".to_string(),
            " ".to_string(),
            "acct_b".to_string(),
        ],
    );

    assert_eq!(
        recipients,
        vec!["acct_b".to_string(), "acct_owner".to_string()]
    );
}
