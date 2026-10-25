//! Scope labels, the allowed scopes of a turn, the owner of pending rows, and
//! forgetting the memories on this Mac (#1710).

use super::*;
use kordi_session::reflection_lessons::save_reflection_lesson;

fn request(scope: &str, scope_id: &str, lesson: &str) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: scope.to_string(),
        scope_id: scope_id.to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
        category: None,
        confidence: None,
    }
}

async fn tool_error_of(
    runtime: &kordi_tools::ReflectionRuntime,
    req: ReflectionLessonRequest,
) -> String {
    match (runtime.save_lesson)(req).await {
        Err(kordi_core::error::KordiError::Tool(message)) => message,
        Err(other) => panic!("unexpected error: {other:?}"),
        Ok(response) => panic!("save must be refused: {response:?}"),
    }
}

#[tokio::test]
async fn a_turn_saves_only_into_its_allowed_scopes() {
    let harness = Harness::new();
    let session = "scope-tests-turn";
    set_allowed_memory_scopes(
        session,
        AllowedMemoryScopes {
            conversation_ids: vec![session.to_string(), "conv-canonical".to_string()],
            group_id: Some("cloud-allowed".to_string()),
            project_root: Some("/work/acme-app".to_string()),
            allow_global: false,
        },
    );
    let runtime = harness.runtime_for(session);
    for (scope, scope_id) in [
        ("conversation", "conv-canonical"),
        ("group", "cloud-allowed"),
        ("project", "/work/acme-app"),
    ] {
        (runtime.save_lesson)(request(scope, scope_id, "Keep replies short."))
            .await
            .expect("allowed save");
    }
    let error = tool_error_of(
        &runtime,
        request("conversation", "someone-else", "Use tabs."),
    )
    .await;
    assert!(
        error.contains("`scope-tests-turn`, `conv-canonical`"),
        "{error}"
    );
    let error = tool_error_of(&runtime, request("group", "cloud-other", "Use tabs.")).await;
    assert!(error.contains("`cloud-allowed`"), "{error}");
    let error = tool_error_of(&runtime, request("project", "/work/other", "Use tabs.")).await;
    assert!(error.contains("`/work/acme-app`"), "{error}");
    let error = tool_error_of(&runtime, request("global", "account", "Use tabs.")).await;
    assert!(error.contains("global"), "{error}");
    assert_eq!(harness.rows().await.len(), 3);
}

#[tokio::test]
async fn a_cli_session_saves_only_into_its_own_conversation_and_project() {
    let harness = Harness::new();
    let runtime = harness.runtime_for("scope-tests-cli");
    (runtime.save_lesson)(request("conversation", "scope-tests-cli", "Use tabs."))
        .await
        .expect("own conversation");
    (runtime.save_lesson)(request("project", "/work/acme-app", "Use tabs."))
        .await
        .expect("cwd project");
    let error = tool_error_of(&runtime, request("conversation", "other", "Use tabs.")).await;
    assert!(error.contains("`scope-tests-cli`"), "{error}");
    let error = tool_error_of(&runtime, request("project", "/work/other", "Use tabs.")).await;
    assert!(error.contains("`/work/acme-app`"), "{error}");
}

#[tokio::test]
async fn pending_rows_upload_only_to_the_account_they_were_saved_for() {
    let harness = Harness::new();
    harness.connect();
    harness.remote.set_unavailable(true);
    harness.save("Saved while signed in.").await.expect("save");
    assert_eq!(
        harness.rows().await[0].owner_account_id.as_deref(),
        Some("acct_test")
    );
    {
        let conn = harness.conn.lock().await;
        for (owner, text) in [
            (Some("acct_other"), "Another account."),
            (None, "Signed out."),
        ] {
            save_reflection_lesson(
                &conn,
                NewReflectionLesson {
                    scope: ReflectionScope::Project,
                    scope_id: "/work/acme-app".to_string(),
                    artifact_path: harness.artifact().display().to_string(),
                    lesson_text: text.to_string(),
                    pending_upload: true,
                    owner_account_id: owner.map(str::to_string),
                    ..NewReflectionLesson::default()
                },
            )
            .expect("pending row");
        }
    }
    harness.remote.set_unavailable(false);

    let report = harness.sync().await;

    assert_eq!(report.uploaded, 2);
    let mut uploaded = harness.remote.texts();
    uploaded.sort();
    assert_eq!(uploaded, vec!["Saved while signed in.", "Signed out."]);
    let rows = harness.rows().await;
    let other = rows
        .iter()
        .find(|row| row.lesson_text.as_deref() == Some("Another account."));
    assert!(other.expect("kept").pending_upload);
}

#[tokio::test]
async fn an_unmapped_group_memory_stays_local_until_its_cloud_id_is_known() {
    let harness = Harness::new();
    let raw = "cloud-agent:acct_test:session:group:scope-tests-local:request:m1";
    let response = (harness.runtime().save_lesson)(request("group", raw, "Tag the owner."))
        .await
        .expect("save");
    assert_eq!(response.scope_id, "session:group:scope-tests-local");
    let local_file = reflection_lesson_artifact_path(
        harness.artifacts.path(),
        "group",
        "session:group:scope-tests-local",
    );
    assert_eq!(response.artifact_path, local_file.display().to_string());

    harness.connect();
    let report = harness.sync().await;
    assert_eq!((report.uploaded, report.rejected), (0, 0));
    assert_eq!(harness.remote.save_count(), 0);
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].pending_upload);
    assert!(
        std::fs::read_to_string(&local_file)
            .unwrap()
            .contains("Tag the owner.")
    );

    remember_group_scope_alias("scope-tests-local", "scope-tests-cloud");
    let report = harness.sync().await;
    assert_eq!(report.uploaded, 1);
    let saves = harness.remote.saves.lock().unwrap().clone();
    assert_eq!(saves[0].scope_id, "scope-tests-cloud");
}

#[tokio::test]
async fn forgetting_local_memories_archives_pending_rows_and_empties_the_files() {
    let harness = Harness::new();
    harness.save("Pending memory.").await.expect("save");
    assert!(harness.rows().await[0].pending_upload);

    let archived = {
        let conn = harness.conn.lock().await;
        forget_local_memories(&conn, harness.artifacts.path()).expect("forget")
    };

    assert_eq!(archived, 1);
    assert!(harness.rows().await.is_empty());
    let text = std::fs::read_to_string(harness.artifact()).expect("file");
    assert!(!text.contains("Pending memory."));
    harness.connect();
    assert_eq!(harness.sync().await.uploaded, 0);
}

#[tokio::test]
async fn saves_and_uploads_carry_the_recorded_scope_label() {
    let harness = Harness::new();
    let save = |scope_id: &'static str| {
        let runtime = harness.runtime_for(scope_id);
        async move {
            (runtime.save_lesson)(ReflectionLessonRequest {
                scope: "conversation".to_string(),
                scope_id: scope_id.to_string(),
                source: "user_correction".to_string(),
                lesson: format!("End replies with a summary for {scope_id}."),
                category: None,
                confidence: None,
            })
            .await
            .expect("save");
        }
    };
    remember_scope_label("conversation", "label-test-online", "Launch planning");
    remember_scope_label("conversation", "label-test-offline", "  ");
    harness.connect();
    save("label-test-online").await;
    assert_eq!(
        harness.remote.saves.lock().unwrap()[0]
            .scope_label
            .as_deref(),
        Some("Launch planning")
    );

    // Saved signed out before the title was known; the upload adds it.
    *harness.slot.write().unwrap() = None;
    save("label-test-offline").await;
    let rows = harness.rows().await;
    assert_eq!(
        rows.iter().filter(|row| row.scope_label.is_none()).count(),
        1
    );
    remember_scope_label("conversation", "label-test-offline", "Release notes");
    harness.connect();
    harness.sync().await;
    let saves = harness.remote.saves.lock().unwrap().clone();
    assert_eq!(saves[1].scope_label.as_deref(), Some("Release notes"));
    let rows = harness.rows().await;
    assert!(rows.iter().all(|row| row.scope_label.is_some()));
}
