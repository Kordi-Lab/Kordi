use super::*;
use kordi_tools::ReflectionLessonRequest;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::test]
async fn reflection_runtime_writes_lesson_text_to_artifact_and_metadata_to_db() {
    let artifacts_dir = tempfile::tempdir().expect("artifacts dir");
    let conn = Arc::new(Mutex::new(
        kordi_session::store::open_memory().expect("memory db"),
    ));
    let runtime = build_reflection_runtime(
        conn.clone(),
        artifacts_dir.path().to_path_buf(),
        ReflectionGuards {
            exclude_sensitive: true,
            protected_texts: Vec::new(),
        },
        crate::memory_remote::empty_memory_remote_slot(),
    );

    let response = (runtime.save_lesson)(ReflectionLessonRequest {
        scope: "conversation".to_string(),
        scope_id: "session-123".to_string(),
        source: "user_correction".to_string(),
        lesson: "Do not inject lessons into the system prompt.".to_string(),
    })
    .await
    .expect("save lesson");

    let artifact_path = std::path::PathBuf::from(&response.artifact_path);
    assert!(artifact_path.starts_with(artifacts_dir.path()));
    assert_eq!(
        artifact_path.extension().and_then(|value| value.to_str()),
        Some("md")
    );
    let artifact_text = std::fs::read_to_string(&artifact_path).expect("lesson artifact");
    assert!(artifact_text.contains("Do not inject lessons into the system prompt."));
    assert!(artifact_text.contains("user_correction"));

    let conn = conn.lock().await;
    let lessons = kordi_session::reflection_lessons::list_reflection_lessons(
        &conn,
        ReflectionScope::Conversation,
        "session-123",
    )
    .expect("list lessons");
    assert_eq!(lessons.len(), 1);
    assert_eq!(lessons[0].artifact_path, response.artifact_path);
}

const PROTECTED: &str = "I think we should move the launch to next Thursday because the vendor contract is still unsigned and legal wants more time.";

fn request(lesson: &str) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: "conversation".to_string(),
        scope_id: "session-guard".to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
    }
}

async fn saved_lesson_count(conn: &Arc<Mutex<rusqlite::Connection>>) -> usize {
    let conn = conn.lock().await;
    kordi_session::reflection_lessons::list_reflection_lessons(
        &conn,
        ReflectionScope::Conversation,
        "session-guard",
    )
    .expect("list lessons")
    .len()
}

fn guarded_runtime(
    protected_texts: Vec<String>,
) -> (
    tempfile::TempDir,
    Arc<Mutex<rusqlite::Connection>>,
    ReflectionRuntime,
) {
    let artifacts_dir = tempfile::tempdir().expect("artifacts dir");
    let conn = Arc::new(Mutex::new(
        kordi_session::store::open_memory().expect("memory db"),
    ));
    let runtime = build_reflection_runtime(
        conn.clone(),
        artifacts_dir.path().to_path_buf(),
        ReflectionGuards {
            exclude_sensitive: true,
            protected_texts,
        },
        crate::memory_remote::empty_memory_remote_slot(),
    );
    (artifacts_dir, conn, runtime)
}

#[tokio::test]
async fn reflection_runtime_rejects_sensitive_memory_without_writing() {
    let (artifacts_dir, conn, runtime) = guarded_runtime(Vec::new());

    let err = match (runtime.save_lesson)(request("Priya was diagnosed with asthma")).await {
        Ok(_) => panic!("sensitive memory must be rejected"),
        Err(err) => err,
    };
    match err {
        kordi_core::error::KordiError::Tool(message) => {
            assert!(message.contains("health details"), "{message}");
        }
        other => panic!("unexpected error: {other:?}"),
    }

    let artifact_path =
        reflection_lesson_artifact_path(artifacts_dir.path(), "conversation", "session-guard");
    assert!(!artifact_path.exists());
    assert!(!artifacts_dir.path().join("reflection-lessons").exists());
    assert_eq!(saved_lesson_count(&conn).await, 0);
}

#[tokio::test]
async fn reflection_runtime_rejects_quote_of_protected_text() {
    let (artifacts_dir, conn, runtime) = guarded_runtime(vec![PROTECTED.to_string()]);

    let result = (runtime.save_lesson)(request(
        "Move the launch to next Thursday because the vendor contract is still unsigned",
    ))
    .await;
    match result {
        Err(kordi_core::error::KordiError::Tool(message)) => {
            assert!(message.contains("turned off AI use"), "{message}");
        }
        Err(other) => panic!("unexpected error: {other:?}"),
        Ok(_) => panic!("quoted memory must be rejected"),
    }
    assert!(!artifacts_dir.path().join("reflection-lessons").exists());
    assert_eq!(saved_lesson_count(&conn).await, 0);
}

#[tokio::test]
async fn reflection_runtime_saves_eleven_word_near_miss() {
    let (_artifacts_dir, conn, runtime) = guarded_runtime(vec![PROTECTED.to_string()]);

    let response = (runtime.save_lesson)(request(
        "Move   the launch to next Thursday because the vendor contract is pending",
    ))
    .await
    .expect("near miss is saved");
    let artifact_text = std::fs::read_to_string(&response.artifact_path).expect("lesson artifact");
    assert!(
        artifact_text
            .contains("Move the launch to next Thursday because the vendor contract is pending")
    );
    assert_eq!(saved_lesson_count(&conn).await, 1);
}
