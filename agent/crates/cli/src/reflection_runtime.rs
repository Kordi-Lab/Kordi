use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use kordi_session::reflection_lessons::{
    NewReflectionLesson, ReflectionScope, ReflectionSource, save_reflection_lesson,
};
use kordi_tools::{
    ReflectionLessonRequest, ReflectionLessonResponse, ReflectionRuntime, SaveReflectionLessonFn,
};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

pub(crate) fn reflection_lesson_artifact_path(
    artifacts_dir: &Path,
    scope: &str,
    scope_id: &str,
) -> PathBuf {
    artifacts_dir
        .join("reflection-lessons")
        .join(scope)
        .join(format!("{}.md", scope_id_slug(scope_id)))
}

pub(crate) fn build_reflection_runtime(
    conn: Arc<Mutex<rusqlite::Connection>>,
    artifacts_dir: PathBuf,
) -> ReflectionRuntime {
    let save_lesson: SaveReflectionLessonFn = Arc::new(move |request: ReflectionLessonRequest| {
        let conn = conn.clone();
        let artifacts_dir = artifacts_dir.clone();
        Box::pin(async move {
            let scope = parse_scope(&request.scope)?;
            let source = parse_source(&request.source)?;
            let artifact_path =
                reflection_lesson_artifact_path(&artifacts_dir, &request.scope, &request.scope_id);
            append_lesson_to_artifact(
                &artifact_path,
                &request.scope,
                &request.scope_id,
                &request.source,
                &request.lesson,
            )
            .map_err(|err| kordi_core::error::KordiError::Tool(err.to_string()))?;

            let artifact_path_text = artifact_path.display().to_string();
            let lesson_id = {
                let conn = conn.lock().await;
                save_reflection_lesson(
                    &conn,
                    NewReflectionLesson {
                        scope,
                        scope_id: request.scope_id.clone(),
                        artifact_path: artifact_path_text.clone(),
                        source,
                    },
                )
                .map_err(|err| kordi_core::error::KordiError::Tool(err.to_string()))?
            };
            Ok(ReflectionLessonResponse {
                lesson_id,
                scope: request.scope,
                scope_id: request.scope_id,
                artifact_path: artifact_path_text,
            })
        })
    });
    ReflectionRuntime { save_lesson }
}

fn append_lesson_to_artifact(
    artifact_path: &Path,
    scope: &str,
    scope_id: &str,
    source: &str,
    lesson: &str,
) -> std::io::Result<()> {
    if let Some(parent) = artifact_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let needs_header = std::fs::metadata(artifact_path)
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(artifact_path)?;

    use std::io::Write;
    if needs_header {
        writeln!(file, "# Scoped reflection lessons")?;
        writeln!(file)?;
        writeln!(file, "Scope: `{scope}`")?;
        writeln!(file, "Scope ID: `{}`", scope_id.trim())?;
        writeln!(file)?;
        writeln!(
            file,
            "Lessons are stored here so the system prompt only needs this artifact path."
        )?;
        writeln!(file)?;
        writeln!(file, "## Lessons")?;
    }

    let lesson_text = lesson.split_whitespace().collect::<Vec<_>>().join(" ");
    writeln!(
        file,
        "- {} [{}] {}",
        Utc::now().to_rfc3339(),
        source.trim(),
        lesson_text
    )?;
    Ok(())
}

fn scope_id_slug(scope_id: &str) -> String {
    let trimmed = scope_id.trim();
    let mut slug = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        slug = "scope".to_string();
    }
    if slug.len() > 64 {
        slug.truncate(64);
        slug = slug.trim_matches('-').to_string();
    }
    format!("{}-{}", slug, short_hash_hex(trimmed))
}

fn short_hash_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn parse_scope(scope: &str) -> kordi_core::error::KordiResult<ReflectionScope> {
    match scope {
        "conversation" => Ok(ReflectionScope::Conversation),
        "group" => Ok(ReflectionScope::Group),
        "project" => Ok(ReflectionScope::Project),
        other => Err(kordi_core::error::KordiError::Tool(format!(
            "unknown reflection scope `{other}`"
        ))),
    }
}

fn parse_source(source: &str) -> kordi_core::error::KordiResult<ReflectionSource> {
    match source {
        "user_correction" => Ok(ReflectionSource::UserCorrection),
        "repeated_failure" => Ok(ReflectionSource::RepeatedFailure),
        "outcome" => Ok(ReflectionSource::Outcome),
        "manual" => Ok(ReflectionSource::Manual),
        other => Err(kordi_core::error::KordiError::Tool(format!(
            "unknown reflection source `{other}`"
        ))),
    }
}

#[cfg(test)]
mod tests {
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
        let runtime = build_reflection_runtime(conn.clone(), artifacts_dir.path().to_path_buf());

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
}
