use super::*;
use crate::reflection_runtime::{ReflectionGuards, build_reflection_runtime};
use kordi_session::reflection_lessons::{list_all_reflection_lessons, list_reflection_lessons};
use kordi_tools::ReflectionLessonRequest;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeRemote {
    memories: std::sync::Mutex<Vec<RemoteMemory>>,
    saves: std::sync::Mutex<Vec<NewRemoteMemory>>,
    unavailable: AtomicBool,
    reject: std::sync::Mutex<Option<String>>,
    counter: AtomicUsize,
}

impl FakeRemote {
    fn set_unavailable(&self, value: bool) {
        self.unavailable.store(value, Ordering::SeqCst);
    }

    fn texts(&self) -> Vec<String> {
        self.memories
            .lock()
            .unwrap()
            .iter()
            .map(|memory| memory.text.clone())
            .collect()
    }

    fn save_count(&self) -> usize {
        self.saves.lock().unwrap().len()
    }
}

#[async_trait::async_trait]
impl MemoryRemote for FakeRemote {
    fn account_id(&self) -> String {
        "acct_test".to_string()
    }

    async fn list(&self) -> Result<RemoteMemoryList, MemoryRemoteError> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(MemoryRemoteError::Unavailable("offline".to_string()));
        }
        Ok(RemoteMemoryList {
            memories: self.memories.lock().unwrap().clone(),
            settings: RemoteMemorySettings {
                memory_enabled: true,
                exclude_sensitive: true,
            },
        })
    }

    async fn save(&self, memory: NewRemoteMemory) -> Result<RemoteMemory, MemoryRemoteError> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(MemoryRemoteError::Unavailable("offline".to_string()));
        }
        if let Some(message) = self.reject.lock().unwrap().clone() {
            return Err(MemoryRemoteError::Rejected(message));
        }
        self.saves.lock().unwrap().push(memory.clone());
        let mut memories = self.memories.lock().unwrap();
        let memory_id = format!(
            "remote_{}",
            memory
                .client_memory_id
                .clone()
                .unwrap_or_else(|| self.counter.fetch_add(1, Ordering::SeqCst).to_string())
        );
        if let Some(existing) = memories.iter().find(|row| row.memory_id == memory_id) {
            return Ok(existing.clone());
        }
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let stamp = format!("2026-10-07T10:00:{:02}+00:00", n % 60);
        let saved = RemoteMemory {
            memory_id,
            scope: memory.scope,
            scope_id: memory.scope_id,
            scope_label: memory.scope_label,
            source: memory.source,
            text: memory.text,
            created_at: stamp.clone(),
            updated_at: stamp,
        };
        memories.push(saved.clone());
        Ok(saved)
    }
}

struct Harness {
    artifacts: tempfile::TempDir,
    conn: Arc<Mutex<rusqlite::Connection>>,
    remote: Arc<FakeRemote>,
    slot: MemoryRemoteSlot,
}

impl Harness {
    fn new() -> Self {
        Self {
            artifacts: tempfile::tempdir().expect("artifacts dir"),
            conn: Arc::new(Mutex::new(
                kordi_session::store::open_memory().expect("memory db"),
            )),
            remote: Arc::new(FakeRemote::default()),
            slot: empty_memory_remote_slot(),
        }
    }

    fn connect(&self) {
        let remote: Arc<dyn MemoryRemote> = self.remote.clone();
        *self.slot.write().unwrap() = Some(remote);
    }

    fn runtime(&self) -> kordi_tools::ReflectionRuntime {
        build_reflection_runtime(
            self.conn.clone(),
            self.artifacts.path().to_path_buf(),
            ReflectionGuards {
                exclude_sensitive: true,
                protected_texts: Vec::new(),
            },
            self.slot.clone(),
        )
    }

    async fn save(&self, lesson: &str) -> kordi_core::error::KordiResult<String> {
        (self.runtime().save_lesson)(ReflectionLessonRequest {
            scope: "project".to_string(),
            scope_id: "/work/acme-app".to_string(),
            source: "user_correction".to_string(),
            lesson: lesson.to_string(),
        })
        .await
        .map(|response| response.artifact_path)
    }

    fn artifact(&self) -> std::path::PathBuf {
        reflection_lesson_artifact_path(self.artifacts.path(), "project", "/work/acme-app")
    }

    async fn sync(&self) -> MemorySyncReport {
        sync_memories_with_remote(&self.conn, self.artifacts.path(), self.remote.as_ref())
            .await
            .expect("sync")
    }

    async fn rows(&self) -> Vec<kordi_session::reflection_lessons::ReflectionLesson> {
        list_all_reflection_lessons(&*self.conn.lock().await).expect("rows")
    }
}

#[test]
fn parses_lesson_lines_and_scope_header() {
    let text = "# Scoped reflection lessons\n\nScope: `project`\nScope ID: `/work/acme-app`\n\n## Lessons\n- 2026-10-01T09:00:00+00:00 [manual] Use pnpm, not npm.\nnot a lesson\n- garbage [manual] skipped\n- 2026-10-01T09:00:01Z [outcome]   Run the visual job serially.\n";
    let lines = crate::reflection_runtime::parse_lesson_artifact(text);
    assert_eq!(
        lines,
        vec![
            crate::reflection_runtime::ParsedLessonLine {
                created_at: "2026-10-01T09:00:00+00:00".to_string(),
                source: "manual".to_string(),
                text: "Use pnpm, not npm.".to_string(),
            },
            crate::reflection_runtime::ParsedLessonLine {
                created_at: "2026-10-01T09:00:01Z".to_string(),
                source: "outcome".to_string(),
                text: "Run the visual job serially.".to_string(),
            },
        ]
    );
    assert_eq!(
        parse_lesson_artifact_scope_id(text).as_deref(),
        Some("/work/acme-app")
    );
}

#[test]
fn rewrite_writes_header_for_empty_list_and_leaves_no_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = reflection_lesson_artifact_path(dir.path(), "conversation", "s-1");
    crate::reflection_runtime::rewrite_lesson_artifact(&path, "conversation", "s-1", &[]).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.starts_with("# Scoped reflection lessons"));
    assert!(text.contains("Scope ID: `s-1`"));
    assert!(crate::reflection_runtime::parse_lesson_artifact(&text).is_empty());
    let entries = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
    assert_eq!(entries, 1);
}

#[tokio::test]
async fn write_through_stores_remote_id_and_rewrites_file() {
    let harness = Harness::new();
    harness.connect();

    harness
        .save("Run the migration test first.")
        .await
        .expect("save");

    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].pending_upload);
    let remote_id = rows[0].remote_memory_id.clone().expect("remote id");
    assert_eq!(remote_id, format!("remote_{}", rows[0].lesson_id));
    assert!(rows[0].lesson_id.starts_with("mem_"));
    assert_eq!(rows[0].scope_label.as_deref(), Some("acme-app"));
    let sent = harness.remote.saves.lock().unwrap()[0].clone();
    assert_eq!(
        sent.client_memory_id.as_deref(),
        Some(rows[0].lesson_id.as_str())
    );
    assert_eq!(sent.scope_label.as_deref(), Some("acme-app"));
    assert_eq!(rows[0].created_at, "2026-10-07T10:00:00+00:00");

    let text = std::fs::read_to_string(harness.artifact()).unwrap();
    assert!(
        text.contains(
            "- 2026-10-07T10:00:00+00:00 [user_correction] Run the migration test first."
        )
    );
}

#[tokio::test]
async fn network_failure_saves_locally_and_next_sync_uploads() {
    let harness = Harness::new();
    harness.connect();
    harness.remote.set_unavailable(true);

    harness
        .save("Keep the runner serial.")
        .await
        .expect("saved locally");
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].pending_upload);
    assert!(
        std::fs::read_to_string(harness.artifact())
            .unwrap()
            .contains("Keep the runner serial.")
    );

    // Still offline: nothing is uploaded and nothing is lost.
    let report = harness.sync().await;
    assert_eq!(report.uploaded, 0);
    assert!(report.settings.is_none());
    assert_eq!(harness.rows().await.len(), 1);

    harness.remote.set_unavailable(false);
    let report = harness.sync().await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.downloaded, 1);
    assert!(report.settings.is_some());
    assert_eq!(harness.remote.texts(), vec!["Keep the runner serial."]);
    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].pending_upload);
    assert!(
        std::fs::read_to_string(harness.artifact())
            .unwrap()
            .contains("Keep the runner serial.")
    );
}

#[tokio::test]
async fn signed_out_save_marks_pending() {
    let harness = Harness::new();
    harness.save("Prefer small PRs.").await.expect("save");
    let rows = harness.rows().await;
    assert!(rows[0].pending_upload);
    assert!(rows[0].remote_memory_id.is_none());
}

#[tokio::test]
async fn refresh_replaces_stale_row_and_rewrites_file() {
    let harness = Harness::new();
    harness.connect();
    harness
        .save("Old wording of the memory.")
        .await
        .expect("save");
    assert!(
        std::fs::read_to_string(harness.artifact())
            .unwrap()
            .contains("Old wording of the memory.")
    );

    // Another device edits the memory on the account.
    {
        let mut memories = harness.remote.memories.lock().unwrap();
        memories[0].text = "New wording from the phone.".to_string();
        memories[0].updated_at = "2026-10-07T11:00:00+00:00".to_string();
    }
    let report = harness.sync().await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(report.downloaded, 1);

    let rows = harness.rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].lesson_text.as_deref(),
        Some("New wording from the phone.")
    );
    let text = std::fs::read_to_string(harness.artifact()).unwrap();
    assert!(text.contains("New wording from the phone."));
    assert!(!text.contains("Old wording of the memory."));
}

#[tokio::test]
async fn refresh_empties_files_for_deleted_scopes() {
    let harness = Harness::new();
    harness.connect();
    harness.save("Soon deleted elsewhere.").await.expect("save");
    harness.remote.memories.lock().unwrap().clear();

    harness.sync().await;
    assert!(harness.rows().await.is_empty());
    let text = std::fs::read_to_string(harness.artifact()).unwrap();
    assert!(text.contains("Scope ID: `/work/acme-app`"));
    assert!(!text.contains("Soon deleted elsewhere."));
}

#[tokio::test]
async fn existing_file_lines_upload_once_in_order() {
    let harness = Harness::new();
    let path = harness.artifact();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        "# Scoped reflection lessons\n\nScope: `project`\nScope ID: `/work/acme-app`\n\nLessons are stored here so the system prompt only needs this artifact path.\n\n## Lessons\n- 2026-09-01T08:00:00+00:00 [user_correction] First appended lesson.\n- 2026-09-01T08:00:00+00:00 [outcome] Second lesson, same second.\n- 2026-09-02T08:00:00+00:00 [repeated_failure] Third lesson.\n",
    )
    .unwrap();

    let report = harness.sync().await;
    assert_eq!(report.uploaded, 3);
    assert_eq!(report.downloaded, 3);
    let saves = harness.remote.saves.lock().unwrap().clone();
    assert_eq!(
        saves
            .iter()
            .map(|save| (
                save.source.as_str(),
                save.text.as_str(),
                save.scope_id.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                "user_correction",
                "First appended lesson.",
                "/work/acme-app"
            ),
            ("outcome", "Second lesson, same second.", "/work/acme-app"),
            ("repeated_failure", "Third lesson.", "/work/acme-app"),
        ]
    );
    assert!(
        harness
            .artifacts
            .path()
            .join("reflection-lessons/.uploaded-acct_test")
            .exists()
    );

    let text = std::fs::read_to_string(&path).unwrap();
    let parsed = crate::reflection_runtime::parse_lesson_artifact(&text);
    assert_eq!(
        parsed
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>(),
        vec![
            "First appended lesson.",
            "Second lesson, same second.",
            "Third lesson."
        ]
    );

    let report = harness.sync().await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(harness.remote.save_count(), 3);
}

#[tokio::test]
async fn signed_out_save_keeps_lines_from_older_builds() {
    let harness = Harness::new();
    let path = harness.artifact();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        "# Scoped reflection lessons\n\nScope: `project`\nScope ID: `/work/acme-app`\n\n## Lessons\n- 2026-09-01T08:00:00+00:00 [manual] Written by an older build.\n",
    )
    .unwrap();

    harness.save("Written now.").await.expect("save");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("Written by an older build."));
    assert!(text.contains("Written now."));
    assert_eq!(harness.rows().await.len(), 2);
}

#[tokio::test]
async fn server_rejection_is_a_tool_error_and_writes_nothing() {
    let harness = Harness::new();
    harness.connect();
    *harness.remote.reject.lock().unwrap() =
        Some("Memories cannot quote a member who turned off AI use.".to_string());

    match harness.save("A memory the server refuses.").await {
        Err(kordi_core::error::KordiError::Tool(message)) => {
            assert!(message.contains("turned off AI use"), "{message}");
        }
        other => panic!("expected a tool error, got {other:?}"),
    }
    assert!(harness.rows().await.is_empty());
    assert!(!harness.artifact().exists());
    let conn = harness.conn.lock().await;
    assert!(
        list_reflection_lessons(&conn, ReflectionScope::Project, "/work/acme-app")
            .unwrap()
            .is_empty()
    );
}
