//! Group memories saved by other members of the group (#1710).

use super::*;

const GROUP_ID: &str = "4f1c2a9e-7d3b-4e8a-9c61-2b5d8e0f3a17";

fn foreign_group_memory(memory_id: &str, text: &str) -> RemoteMemory {
    RemoteMemory {
        memory_id: memory_id.to_string(),
        scope: "group".to_string(),
        scope_id: GROUP_ID.to_string(),
        scope_label: Some("Design review".to_string()),
        source: "manual".to_string(),
        text: text.to_string(),
        created_at: "2026-10-07T09:00:00+00:00".to_string(),
        updated_at: "2026-10-07T09:00:00+00:00".to_string(),
        owner_account_id: Some("acct_priya".to_string()),
        owner_name: Some("Priya".to_string()),
    }
}

fn group_request(lesson: &str) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: "group".to_string(),
        scope_id: GROUP_ID.to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
    }
}

#[test]
fn owner_fields_are_optional_on_the_wire() {
    let shared: RemoteMemory = serde_json::from_value(serde_json::json!({
        "memoryId": "mem_1",
        "scope": "group",
        "scopeId": GROUP_ID,
        "scopeLabel": null,
        "source": "manual",
        "text": "Share screenshots as attachments.",
        "createdAt": "2026-10-07T09:00:00+00:00",
        "updatedAt": "2026-10-07T09:00:00+00:00",
        "ownerAccountId": "acct_priya",
        "ownerName": null,
    }))
    .expect("memory with owner");
    assert_eq!(shared.owner_account_id.as_deref(), Some("acct_priya"));
    assert_eq!(shared.owner_name, None);

    let older: RemoteMemory = serde_json::from_value(serde_json::json!({
        "memoryId": "mem_2",
        "scope": "global",
        "scopeId": "account",
        "source": "manual",
        "text": "Use metric units.",
        "createdAt": "2026-10-07T09:00:00+00:00",
        "updatedAt": "2026-10-07T09:00:00+00:00",
    }))
    .expect("memory from an older server");
    assert_eq!(older.owner_account_id, None);
    assert_eq!(older.owner_name, None);
}

#[tokio::test]
async fn sync_caches_a_foreign_group_memory_without_uploading_it() {
    let harness = Harness::new();
    harness
        .remote
        .memories
        .lock()
        .unwrap()
        .push(foreign_group_memory(
            "mem_priya",
            "Share screenshots as attachments.",
        ));

    let report = harness.sync().await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(report.downloaded, 1);
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].lesson_id, "mem_priya");
    assert_eq!(rows[0].remote_memory_id.as_deref(), Some("mem_priya"));
    assert_eq!(rows[0].scope, ReflectionScope::Group);
    assert!(!rows[0].pending_upload);

    let artifact = reflection_lesson_artifact_path(harness.artifacts.path(), "group", GROUP_ID);
    let text = std::fs::read_to_string(&artifact).expect("group file");
    assert!(text.contains("Share screenshots as attachments."));

    // A second sync neither uploads nor archives the shared memory.
    let report = harness.sync().await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(harness.remote.save_count(), 0);
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].lesson_id, "mem_priya");
}

#[tokio::test]
async fn saving_text_a_member_already_shared_reports_already_saved() {
    let harness = Harness::new();
    harness
        .remote
        .memories
        .lock()
        .unwrap()
        .push(foreign_group_memory(
            "mem_priya",
            "Share screenshots as attachments.",
        ));
    harness.connect();
    harness.sync().await;

    let response =
        (harness.runtime().save_lesson)(group_request("  Share screenshots   as attachments. "))
            .await
            .expect("save");
    assert!(response.already_saved);
    assert_eq!(response.lesson_id, "mem_priya");
    assert_eq!(harness.remote.save_count(), 0);
    let rows = list_reflection_lessons(
        &*harness.conn.lock().await,
        ReflectionScope::Group,
        GROUP_ID,
    )
    .expect("group rows");
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].pending_upload);
}
