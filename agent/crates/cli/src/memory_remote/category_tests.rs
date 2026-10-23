//! Memory categories on the Mac runtime (#1977): what the agent's save sends,
//! what the cache keeps, and the lesson file line format.

use super::*;

fn request(
    lesson: &str,
    category: Option<&str>,
    confidence: Option<&str>,
) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: "project".to_string(),
        scope_id: "/work/acme-app".to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
        category: category.map(str::to_string),
        confidence: confidence.map(str::to_string),
    }
}

#[tokio::test]
async fn agent_save_sends_category_confidence_and_agent_declaration() {
    let harness = Harness::new();
    harness.connect();
    (harness.runtime().save_lesson)(request(
        "Works on the acme billing service.",
        Some("work_context"),
        Some("high"),
    ))
    .await
    .expect("save");

    let sent = harness.remote.saves.lock().unwrap()[0].clone();
    assert_eq!(sent.category.as_deref(), Some("work_context"));
    assert_eq!(sent.confidence.as_deref(), Some("high"));
    assert_eq!(sent.declared_by.as_deref(), Some("agent"));
    let body = serde_json::to_value(&sent).unwrap();
    assert_eq!(body["declaredBy"], "agent");
    assert_eq!(body["category"], "work_context");

    let rows = harness.rows().await;
    assert_eq!(rows[0].category.as_deref(), Some("work_context"));
    assert_eq!(rows[0].declaration_type.as_deref(), Some("model-inferred"));
    assert_eq!(rows[0].confidence.as_deref(), Some("high"));
    let text = std::fs::read_to_string(harness.artifact()).unwrap();
    assert!(
        text.contains(
            "[user_correction|work_context|model-inferred] Works on the acme billing service."
        ),
        "{text}"
    );
}

#[tokio::test]
async fn save_without_category_leaves_it_to_the_server() {
    let harness = Harness::new();
    harness.connect();
    harness
        .save("Answer in British English.")
        .await
        .expect("save");
    let sent = harness.remote.saves.lock().unwrap()[0].clone();
    let body = serde_json::to_value(&sent).unwrap();
    assert!(body.get("category").is_none(), "{body}");
    assert!(body.get("confidence").is_none(), "{body}");
    let text = std::fs::read_to_string(harness.artifact()).unwrap();
    assert!(
        text.contains("[user_correction|general_preferences|model-inferred]"),
        "{text}"
    );
}

#[test]
fn parser_reads_old_and_new_lines() {
    let text = "## Lessons\n- 2026-10-01T09:00:00Z [manual] Use pnpm.\n- 2026-10-01T09:00:01Z [outcome|hcp-custom:task_lessons|model-inferred] Run tests serially.\n- 2026-10-01T09:00:02Z [manual|not_a_category|nonsense] Short answers.\n";
    let lines = crate::reflection_runtime::parse_lesson_artifact(text);
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].source, "manual");
    assert_eq!(lines[0].category, None);
    assert_eq!(lines[0].declaration_type, "user-declared");
    assert_eq!(lines[1].source, "outcome");
    assert_eq!(
        lines[1].category.as_deref(),
        Some("hcp-custom:task_lessons")
    );
    assert_eq!(lines[1].declaration_type, "model-inferred");
    assert_eq!(lines[1].text, "Run tests serially.");
    assert_eq!(lines[2].category, None);
    assert_eq!(lines[2].declaration_type, "user-declared");
}

#[tokio::test]
async fn sync_carries_category_and_defaults_missing_values() {
    let harness = Harness::new();
    let base = RemoteMemory {
        scope: "project".to_string(),
        scope_id: "/work/acme-app".to_string(),
        created_at: "2026-10-07T09:00:00+00:00".to_string(),
        updated_at: "2026-10-07T09:00:00+00:00".to_string(),
        ..RemoteMemory::default()
    };
    harness.remote.memories.lock().unwrap().extend([
        RemoteMemory {
            memory_id: "mem_health".to_string(),
            source: "user_correction".to_string(),
            text: "Runs 5k every Tuesday.".to_string(),
            category: Some("health_context".to_string()),
            declaration_type: Some("model-inferred".to_string()),
            confidence: Some("medium".to_string()),
            profile_kind: Some("health".to_string()),
            ..base.clone()
        },
        RemoteMemory {
            memory_id: "mem_old".to_string(),
            source: "manual".to_string(),
            text: "Use pnpm.".to_string(),
            ..base
        },
    ]);
    harness.sync().await;

    let rows = harness.rows().await;
    let health = rows
        .iter()
        .find(|row| row.lesson_id == "mem_health")
        .unwrap();
    assert_eq!(health.category.as_deref(), Some("health_context"));
    assert_eq!(health.declaration_type.as_deref(), Some("model-inferred"));
    assert_eq!(health.confidence.as_deref(), Some("medium"));
    let old = rows.iter().find(|row| row.lesson_id == "mem_old").unwrap();
    assert_eq!(old.category.as_deref(), Some("general_preferences"));
    assert_eq!(old.declaration_type.as_deref(), Some("user-declared"));
    assert_eq!(old.confidence, None);
}

#[tokio::test]
async fn pending_uploads_keep_category_and_declaration() {
    let harness = Harness::new();
    // An older build's line written by the person, then an agent save while
    // signed out.
    let path = harness.artifact();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        "# Scoped reflection lessons\n\nScope: `project`\nScope ID: `/work/acme-app`\n\n## Lessons\n- 2026-10-01T09:00:00Z [manual] Use pnpm.\n",
    )
    .unwrap();
    (harness.runtime().save_lesson)(request(
        "Free on Friday afternoons.",
        Some("coordination_context"),
        Some("low"),
    ))
    .await
    .expect("save");
    harness.connect();
    harness.sync().await;

    let saves = harness.remote.saves.lock().unwrap().clone();
    let manual = saves.iter().find(|save| save.text == "Use pnpm.").unwrap();
    assert_eq!(manual.declared_by.as_deref(), Some("user"));
    assert_eq!(manual.category, None);
    let agent = saves
        .iter()
        .find(|save| save.text == "Free on Friday afternoons.")
        .unwrap();
    assert_eq!(agent.declared_by.as_deref(), Some("agent"));
    assert_eq!(agent.category.as_deref(), Some("coordination_context"));
    assert_eq!(agent.confidence.as_deref(), Some("low"));
}

#[test]
fn remote_memory_reads_routing_fields() {
    let memory: RemoteMemory = serde_json::from_value(serde_json::json!({
        "memoryId": "mem_1",
        "scope": "global",
        "scopeId": "account",
        "source": "manual",
        "text": "Prefer short answers.",
        "createdAt": "2026-10-07T09:00:00+00:00",
        "updatedAt": "2026-10-07T09:00:00+00:00",
        "category": "work_context",
        "declarationType": "user-declared",
        "confidence": null,
        "profileId": "prof_work",
        "profileKind": "work"
    }))
    .unwrap();
    assert_eq!(memory.category.as_deref(), Some("work_context"));
    assert_eq!(memory.declaration_type.as_deref(), Some("user-declared"));
    assert_eq!(memory.profile_id.as_deref(), Some("prof_work"));
    assert_eq!(memory.profile_kind.as_deref(), Some("work"));
}
