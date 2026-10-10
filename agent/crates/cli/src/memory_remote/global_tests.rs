//! Global memories and "already saved" results on the Mac (#1710).

use super::*;
use kordi_tools::Tool;

fn global_request(lesson: &str) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: "global".to_string(),
        scope_id: "account".to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
    }
}

#[tokio::test]
async fn global_memory_is_written_to_the_account_file_without_a_label() {
    let harness = Harness::new();
    remember_scope_label("global", "account", "Should be ignored");
    harness.connect();
    let response = (harness.runtime().save_lesson)(global_request("Always use metric units."))
        .await
        .expect("save");
    assert!(!response.already_saved);
    let expected = harness
        .artifacts
        .path()
        .join("reflection-lessons")
        .join("global")
        .join("account.md");
    assert_eq!(response.artifact_path, expected.display().to_string());
    let text = std::fs::read_to_string(&expected).expect("global file");
    assert!(text.contains("Scope: `global`"));
    assert!(text.contains("Always use metric units."));

    let sent = harness.remote.saves.lock().unwrap()[0].clone();
    assert_eq!(sent.scope, "global");
    assert_eq!(sent.scope_id, "account");
    assert_eq!(sent.scope_label, None);

    // A refresh from the account keeps the global file in place.
    std::fs::remove_file(&expected).unwrap();
    harness.sync().await;
    let text = std::fs::read_to_string(&expected).expect("rewritten global file");
    assert!(text.contains("Always use metric units."));
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].scope, ReflectionScope::Global);
}

#[tokio::test]
async fn saving_text_the_scope_already_holds_reports_already_saved() {
    let harness = Harness::new();
    harness.connect();
    let runtime = harness.runtime();
    let first = (runtime.save_lesson)(global_request("Always use metric units."))
        .await
        .expect("first save");
    assert!(!first.already_saved);

    // The local cache already holds it.
    let again = (runtime.save_lesson)(global_request("  Always use   metric units. "))
        .await
        .expect("second save");
    assert!(again.already_saved);
    assert_eq!(again.lesson_id, first.lesson_id);
    assert_eq!(harness.remote.save_count(), 1);

    // Another device saved it to the account; this Mac has not synced yet.
    harness.remote.memories.lock().unwrap().push(RemoteMemory {
        memory_id: "mem_other_device".to_string(),
        scope: "global".to_string(),
        scope_id: "account".to_string(),
        scope_label: None,
        source: "manual".to_string(),
        text: "Prefer short answers.".to_string(),
        created_at: "2026-10-07T09:00:00+00:00".to_string(),
        updated_at: "2026-10-07T09:00:00+00:00".to_string(),
    });
    let from_account = (runtime.save_lesson)(global_request("Prefer short answers."))
        .await
        .expect("save of account memory");
    assert!(from_account.already_saved);
    assert_eq!(from_account.lesson_id, "mem_other_device");
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.lesson_id == "mem_other_device"
        && row.remote_memory_id.as_deref() == Some("mem_other_device")));

    // The tool turns the flag into an "already saved" result.
    let tool_result = kordi_tools::reflection_tool::ReflectionTool
        .execute(
            serde_json::json!({
                "scope": "global",
                "scopeId": "account",
                "source": "user_correction",
                "lesson": "Prefer short answers.",
            }),
            &tool_context(runtime),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("tool result");
    match &tool_result.content[0] {
        kordi_core::types::ContentBlock::Text { text } => {
            assert_eq!(text, "Memory already saved: Prefer short answers.");
        }
        other => panic!("unexpected content {other:?}"),
    }
}

fn tool_context(runtime: kordi_tools::ReflectionRuntime) -> kordi_tools::ToolContext {
    kordi_tools::ToolContext {
        cwd: "/tmp".into(),
        artifacts_dir: "/tmp".into(),
        model: None,
        execution_policy: kordi_tools::ExecutionPolicy::Safety,
        invocation_id: None,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: Some(runtime),
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        mac_local: None,
        execution_mode: kordi_tools::ToolExecutionMode::Interactive,
        connector_tools: None,
        request_approval: None,
    }
}
