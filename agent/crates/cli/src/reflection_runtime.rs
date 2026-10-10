use std::path::{Path, PathBuf};
use std::sync::Arc;

use kordi_session::reflection_lessons::{
    NewReflectionLesson, ReflectionLesson, ReflectionScope, ReflectionSource,
    find_active_reflection_lesson_by_text, list_all_reflection_lessons, list_reflection_lessons,
    new_reflection_lesson_id, save_reflection_lesson, touch_reflection_lesson,
};
use kordi_tools::memory_guard::{MemoryGuardOptions, check_memory_text};
use kordi_tools::{
    ReflectionLessonRequest, ReflectionLessonResponse, ReflectionRuntime, SaveReflectionLessonFn,
};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::memory_remote::{
    MemoryRemoteError, MemoryRemoteSlot, NewRemoteMemory, current_memory_remote,
    group_lessons_by_scope, import_unlisted_artifact_lines, scope_label_for,
};

const LESSON_ARTIFACT_TITLE: &str = "# Scoped reflection lessons";
const LESSON_SCOPE_ID_PREFIX: &str = "Scope ID: `";

pub(crate) fn reflection_lesson_artifact_path(
    artifacts_dir: &Path,
    scope: &str,
    scope_id: &str,
) -> PathBuf {
    let file_name = if scope == "global" {
        // One account-wide file: `reflection-lessons/global/account.md`.
        format!("{}.md", kordi_tools::reflection_tool::GLOBAL_SCOPE_ID)
    } else {
        format!("{}.md", scope_id_slug(scope_id))
    };
    artifacts_dir
        .join("reflection-lessons")
        .join(scope)
        .join(file_name)
}

/// Guards applied to every memory before anything is written.
#[derive(Clone, Debug, Default)]
pub(crate) struct ReflectionGuards {
    /// Run the sensitive keyword guard (`MemorySettings::exclude_sensitive`).
    pub exclude_sensitive: bool,
    /// Texts from members who turned off AI use. A memory quoting twelve or
    /// more consecutive words from any of them is rejected. Filled by the AI
    /// opt-out work (#1687); empty until then.
    pub protected_texts: Vec<String>,
}

fn tool_error(err: impl std::fmt::Display) -> kordi_core::error::KordiError {
    kordi_core::error::KordiError::Tool(err.to_string())
}

pub(crate) fn build_reflection_runtime(
    conn: Arc<Mutex<rusqlite::Connection>>,
    artifacts_dir: PathBuf,
    guards: ReflectionGuards,
    remote: MemoryRemoteSlot,
) -> ReflectionRuntime {
    let guards = Arc::new(guards);
    let save_lesson: SaveReflectionLessonFn = Arc::new(move |request: ReflectionLessonRequest| {
        let conn = conn.clone();
        let artifacts_dir = artifacts_dir.clone();
        let guards = guards.clone();
        let remote = current_memory_remote(&remote);
        Box::pin(async move {
            let scope = parse_scope(&request.scope)?;
            let source = parse_source(&request.source)?;
            let lesson_text = check_memory_text(
                &request.lesson,
                &MemoryGuardOptions {
                    exclude_sensitive: guards.exclude_sensitive,
                    protected_texts: &guards.protected_texts,
                },
            )
            .map_err(tool_error)?;
            let scope_id = request.scope_id.trim().to_string();
            let scope_label = scope_label_for(&scope, &scope_id);
            let artifact_path =
                reflection_lesson_artifact_path(&artifacts_dir, &request.scope, &scope_id);
            let artifact_path_text = artifact_path.display().to_string();
            let saved = |lesson_id: String, already_saved: bool| ReflectionLessonResponse {
                lesson_id,
                scope: request.scope.clone(),
                scope_id: request.scope_id.clone(),
                artifact_path: artifact_path_text.clone(),
                already_saved,
            };

            // The same text in the same scope is the same memory: reuse the
            // row and skip the upload.
            {
                let conn = conn.lock().await;
                // Lines written by older builds live only in the file. Keep
                // them in the cache before comparing or rewriting the file.
                import_unlisted_artifact_lines(&conn, &artifact_path, &scope, &scope_id)
                    .map_err(tool_error)?;
                if let Some(existing) =
                    reuse_existing_lesson(&conn, &scope, &scope_id, &lesson_text, &scope_label)?
                {
                    return Ok(saved(existing, true));
                }
            }
            let lesson_id = new_reflection_lesson_id();

            // Write through to the account first. A rejection writes nothing;
            // a network failure keeps the memory locally for a later upload.
            let mut remote_memory_id = None;
            let mut created_at = None;
            let mut updated_at = None;
            let mut pending_upload = true;
            // The account answers a save of text it already holds with that
            // memory, whose id differs from the id this save proposed.
            let mut already_on_account = false;
            if let Some(remote) = remote {
                match remote
                    .save(NewRemoteMemory {
                        scope: request.scope.clone(),
                        scope_id: scope_id.clone(),
                        scope_label: scope_label.clone(),
                        source: request.source.clone(),
                        text: lesson_text.clone(),
                        client_memory_id: Some(lesson_id.clone()),
                    })
                    .await
                {
                    Ok(memory) => {
                        already_on_account = memory.memory_id != lesson_id;
                        remote_memory_id = Some(memory.memory_id);
                        created_at = Some(memory.created_at);
                        updated_at = Some(memory.updated_at);
                        pending_upload = false;
                    }
                    Err(error @ (MemoryRemoteError::Rejected(_) | MemoryRemoteError::Disabled)) => {
                        return Err(tool_error(error));
                    }
                    Err(
                        error @ (MemoryRemoteError::Unavailable(_) | MemoryRemoteError::Other(_)),
                    ) => {
                        tracing::warn!("memory saved locally for a later upload: {error}");
                    }
                }
            }

            // Cache an existing account memory under its own id.
            let lesson_id = match (&remote_memory_id, already_on_account) {
                (Some(remote_id), true) => remote_id.clone(),
                _ => lesson_id,
            };
            let lesson_id = {
                let conn = conn.lock().await;
                // Another save of the same text may have finished while this
                // one waited for the account.
                if let Some(existing) =
                    reuse_existing_lesson(&conn, &scope, &scope_id, &lesson_text, &scope_label)?
                {
                    return Ok(saved(existing, true));
                }
                let lesson_id = save_reflection_lesson(
                    &conn,
                    NewReflectionLesson {
                        scope: scope.clone(),
                        scope_id: scope_id.clone(),
                        artifact_path: artifact_path_text.clone(),
                        source,
                        lesson_text,
                        scope_label,
                        remote_memory_id,
                        pending_upload,
                        lesson_id: Some(lesson_id),
                        created_at,
                        updated_at,
                    },
                )
                .map_err(tool_error)?;
                let lessons =
                    list_reflection_lessons(&conn, scope, &scope_id).map_err(tool_error)?;
                rewrite_lesson_artifact(&artifact_path, &request.scope, &scope_id, &lessons)
                    .map_err(tool_error)?;
                lesson_id
            };
            Ok(saved(lesson_id, already_on_account))
        })
    });
    ReflectionRuntime { save_lesson }
}

/// Touch the non-archived row holding `text` in this scope and return its id.
fn reuse_existing_lesson(
    conn: &rusqlite::Connection,
    scope: &ReflectionScope,
    scope_id: &str,
    text: &str,
    scope_label: &Option<String>,
) -> kordi_core::error::KordiResult<Option<String>> {
    let Some(existing) =
        find_active_reflection_lesson_by_text(conn, scope, scope_id, text).map_err(tool_error)?
    else {
        return Ok(None);
    };
    touch_reflection_lesson(conn, &existing.lesson_id, scope_label.as_deref())
        .map_err(tool_error)?;
    Ok(Some(existing.lesson_id))
}

fn lesson_artifact_header(scope: &str, scope_id: &str) -> String {
    format!(
        "{LESSON_ARTIFACT_TITLE}\n\nScope: `{scope}`\n{LESSON_SCOPE_ID_PREFIX}{}`\n\nLessons are stored here so the system prompt only needs this artifact path.\n\n## Lessons\n",
        scope_id.trim()
    )
}

fn sort_key(lesson: &ReflectionLesson) -> (Option<chrono::DateTime<chrono::Utc>>, String, String) {
    (
        chrono::DateTime::parse_from_rfc3339(&lesson.created_at)
            .ok()
            .map(|value| value.with_timezone(&chrono::Utc)),
        lesson.created_at.clone(),
        lesson.lesson_id.clone(),
    )
}

/// Rewrite one lesson file from cache rows. The file is written to a sibling
/// temporary file and renamed, so a crash leaves the old or the new file.
pub(crate) fn rewrite_lesson_artifact(
    artifact_path: &Path,
    scope: &str,
    scope_id: &str,
    lessons: &[ReflectionLesson],
) -> std::io::Result<()> {
    let parent = artifact_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;

    let mut ordered = lessons
        .iter()
        .filter(|lesson| lesson.lesson_text.is_some())
        .collect::<Vec<_>>();
    ordered.sort_by_key(|lesson| sort_key(lesson));

    let mut body = lesson_artifact_header(scope, scope_id);
    for lesson in ordered {
        let text = lesson
            .lesson_text
            .as_deref()
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        body.push_str(&format!(
            "- {} [{}] {}\n",
            lesson.created_at.trim(),
            lesson.source.as_str(),
            text
        ));
    }

    let file_name = artifact_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("lessons.md");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(error) = std::fs::write(&temp_path, body.as_bytes())
        .and_then(|()| std::fs::rename(&temp_path, artifact_path))
    {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedLessonLine {
    pub created_at: String,
    pub source: String,
    pub text: String,
}

/// Parse `- <timestamp> [<source>] <text>` lines. Other lines are ignored.
pub(crate) fn parse_lesson_artifact(text: &str) -> Vec<ParsedLessonLine> {
    text.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("- ")?;
            let (created_at, rest) = rest.split_once(' ')?;
            chrono::DateTime::parse_from_rfc3339(created_at).ok()?;
            let rest = rest.strip_prefix('[')?;
            let (source, rest) = rest.split_once(']')?;
            let text = rest.trim();
            if source.trim().is_empty() || text.is_empty() {
                return None;
            }
            Some(ParsedLessonLine {
                created_at: created_at.to_string(),
                source: source.trim().to_string(),
                text: text.to_string(),
            })
        })
        .collect()
}

/// Read the scope id from the `Scope ID:` header line.
pub(crate) fn parse_lesson_artifact_scope_id(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let value = line.trim().strip_prefix(LESSON_SCOPE_ID_PREFIX)?;
        let value = value.strip_suffix('`')?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Rewrite every lesson file from the cache. Files under `reflection-lessons/`
/// whose scope has no rows left are rewritten to the empty header.
pub(crate) fn rewrite_all_lesson_artifacts(
    conn: &rusqlite::Connection,
    artifacts_dir: &Path,
) -> anyhow::Result<()> {
    let groups = group_lessons_by_scope(list_all_reflection_lessons(conn)?);
    let mut written = std::collections::HashSet::new();
    for ((scope, scope_id), lessons) in &groups {
        let path = reflection_lesson_artifact_path(artifacts_dir, scope, scope_id);
        rewrite_lesson_artifact(&path, scope, scope_id, lessons)?;
        written.insert(path);
    }

    let root = artifacts_dir.join("reflection-lessons");
    let Ok(scopes) = std::fs::read_dir(&root) else {
        return Ok(());
    };
    for scope_entry in scopes.flatten() {
        if !scope_entry.path().is_dir() {
            continue;
        }
        let Some(scope) = scope_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(files) = std::fs::read_dir(scope_entry.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md")
                || written.contains(&path)
            {
                continue;
            }
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            let scope_id = parse_lesson_artifact_scope_id(&existing).unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
                    .to_string()
            });
            rewrite_lesson_artifact(&path, &scope, &scope_id, &[])?;
        }
    }
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
        "global" => Ok(ReflectionScope::Global),
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
mod tests;
