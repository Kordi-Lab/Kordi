//! Group memories saved under a local group session id land under the cloud
//! group id (#1710).

use super::*;
use kordi_session::reflection_lessons::{ReflectionLesson, save_reflection_lesson};

fn group_save(scope_id: &str, lesson: &str) -> ReflectionLessonRequest {
    ReflectionLessonRequest {
        scope: "group".to_string(),
        scope_id: scope_id.to_string(),
        source: "user_correction".to_string(),
        lesson: lesson.to_string(),
    }
}

fn group_file(harness: &Harness, scope_id: &str) -> std::path::PathBuf {
    reflection_lesson_artifact_path(harness.artifacts.path(), "group", scope_id)
}

/// Cache a pending group row the way older builds did: under the raw local
/// group session id, with its own lesson file.
async fn cache_local_group_row(harness: &Harness, raw_scope_id: &str, text: &str) -> String {
    let conn = harness.conn.lock().await;
    let path = group_file(harness, raw_scope_id);
    let lesson_id = save_reflection_lesson(
        &conn,
        NewReflectionLesson {
            scope: ReflectionScope::Group,
            scope_id: raw_scope_id.to_string(),
            artifact_path: path.display().to_string(),
            source: ReflectionSource::UserCorrection,
            lesson_text: text.to_string(),
            pending_upload: true,
            ..NewReflectionLesson::default()
        },
    )
    .expect("cache row");
    let rows = list_reflection_lessons(&conn, ReflectionScope::Group, raw_scope_id).expect("rows");
    rewrite_lesson_artifact(&path, "group", raw_scope_id, &rows).expect("old file");
    lesson_id
}

fn group_rows(rows: &[ReflectionLesson]) -> Vec<(&str, bool)> {
    rows.iter()
        .filter(|row| row.scope == ReflectionScope::Group)
        .map(|row| (row.scope_id.as_str(), row.pending_upload))
        .collect()
}

#[tokio::test]
async fn a_group_save_with_the_local_id_lands_under_the_cloud_id() {
    remember_group_scope_alias("local-save-1", "cloud-save-1");
    let harness = Harness::new();
    harness.connect();

    let response = (harness.runtime().save_lesson)(group_save(
        "cloud-agent:acct_test:session:group:local-save-1:request:msg_1",
        "Post release notes in the thread.",
    ))
    .await
    .expect("save");

    assert_eq!(response.scope_id, "cloud-save-1");
    let cloud_file = group_file(&harness, "cloud-save-1");
    assert_eq!(response.artifact_path, cloud_file.display().to_string());
    let text = std::fs::read_to_string(&cloud_file).expect("cloud group file");
    assert!(text.contains("Scope ID: `cloud-save-1`"));
    assert!(text.contains("Post release notes in the thread."));
    assert!(!group_file(&harness, "session:group:local-save-1").exists());
    assert!(!group_file(&harness, "local-save-1").exists());

    let saves = harness.remote.saves.lock().unwrap().clone();
    assert_eq!(saves.len(), 1);
    assert_eq!(saves[0].scope_id, "cloud-save-1");
    assert_eq!(
        group_rows(&harness.rows().await),
        vec![("cloud-save-1", false)]
    );
}

#[tokio::test]
async fn sync_moves_a_pending_local_group_row_to_the_cloud_id() {
    let harness = Harness::new();
    let raw = "session:group:local-sync-1";
    cache_local_group_row(&harness, raw, "Tag the owner on blockers.").await;
    remember_group_scope_alias(raw, "cloud-sync-1");

    let report = harness.sync().await;

    assert_eq!(report.uploaded, 1);
    assert_eq!(report.rejected, 0);
    let saves = harness.remote.saves.lock().unwrap().clone();
    assert_eq!(saves.len(), 1);
    assert_eq!(saves[0].scope_id, "cloud-sync-1");
    assert_eq!(
        group_rows(&harness.rows().await),
        vec![("cloud-sync-1", false)]
    );
    let cloud_text = std::fs::read_to_string(group_file(&harness, "cloud-sync-1")).unwrap();
    assert!(cloud_text.contains("Tag the owner on blockers."));
    let old_text = std::fs::read_to_string(group_file(&harness, raw)).unwrap();
    assert!(!old_text.contains("Tag the owner on blockers."));
}

#[tokio::test]
async fn sync_archives_a_local_row_whose_text_the_cloud_scope_already_holds() {
    let harness = Harness::new();
    remember_group_scope_alias("local-sync-2", "cloud-sync-2");
    harness.connect();
    (harness.runtime().save_lesson)(group_save("cloud-sync-2", "Reply in threads."))
        .await
        .expect("cloud save");
    cache_local_group_row(&harness, "session:group:local-sync-2", "Reply in threads.").await;

    let report = harness.sync().await;

    assert_eq!(report.uploaded, 0);
    assert_eq!(harness.remote.save_count(), 1);
    assert_eq!(
        group_rows(&harness.rows().await),
        vec![("cloud-sync-2", false)]
    );
}

#[tokio::test]
async fn sync_archives_an_unmapped_group_row_the_account_refuses() {
    let harness = Harness::new();
    cache_local_group_row(
        &harness,
        "session:group:local-unmapped",
        "Use short replies.",
    )
    .await;
    *harness.remote.reject.lock().unwrap() = Some("Not a member of this group.".to_string());

    let report = harness.sync().await;

    assert_eq!(report.rejected, 1);
    assert!(group_rows(&harness.rows().await).is_empty());
}
