use std::path::{Path, PathBuf};
use std::sync::Arc;

use kordi_session::reflection_lessons::{
    NewReflectionLesson, ReflectionScope, ReflectionSource, find_active_reflection_lesson_by_text,
    list_reflection_lessons, new_reflection_lesson_id, save_reflection_lesson,
    touch_reflection_lesson,
};
use kordi_tools::memory_categories::MODEL_INFERRED;
use kordi_tools::memory_guard::{MemoryGuardOptions, check_memory_text};
use kordi_tools::{
    ReflectionLessonRequest, ReflectionLessonResponse, ReflectionRuntime, SaveReflectionLessonFn,
};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::memory_remote::{
    MemoryRemoteError, MemoryRemoteSlot, NewRemoteMemory, canonical_group_scope_id,
    check_memory_scope, current_memory_remote, import_unlisted_artifact_lines, scope_label_for,
};

mod artifact;
pub(crate) use artifact::{
    ParsedLessonLine, lesson_declaration, parse_lesson_artifact, parse_lesson_artifact_scope_id,
    rewrite_all_lesson_artifacts, rewrite_lesson_artifact,
};

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

/// Where a session's memories are written, and which session saves them.
#[derive(Clone, Debug)]
pub(crate) struct ReflectionTarget {
    pub artifacts_dir: PathBuf,
    /// The runtime session id: the key of the allowed-scope registry.
    pub session_id: String,
    /// The working directory, whose project a CLI session may save into.
    pub cwd: PathBuf,
}

impl ReflectionTarget {
    pub(crate) fn new(artifacts_dir: &Path, session_id: &str, cwd: &Path) -> Self {
        Self {
            artifacts_dir: artifacts_dir.to_path_buf(),
            session_id: session_id.to_string(),
            cwd: cwd.to_path_buf(),
        }
    }
}

fn tool_error(err: impl std::fmt::Display) -> kordi_core::error::KordiError {
    kordi_core::error::KordiError::Tool(err.to_string())
}

pub(crate) fn build_reflection_runtime(
    conn: Arc<Mutex<rusqlite::Connection>>,
    target: ReflectionTarget,
    guards: ReflectionGuards,
    remote: MemoryRemoteSlot,
) -> ReflectionRuntime {
    let guards = Arc::new(guards);
    let target = Arc::new(target);
    let save_lesson: SaveReflectionLessonFn = Arc::new(move |request: ReflectionLessonRequest| {
        let conn = conn.clone();
        let target = target.clone();
        let guards = guards.clone();
        let remote = current_memory_remote(&remote);
        Box::pin(async move {
            let artifacts_dir = &target.artifacts_dir;
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
            // Group memories are keyed by the cloud group id, whatever form
            // of the group session id the agent passed.
            let scope_id = if scope == ReflectionScope::Group {
                canonical_group_scope_id(&request.scope_id)
            } else {
                request.scope_id.trim().to_string()
            };
            check_memory_scope(&target.session_id, &target.cwd, &scope, &scope_id)
                .map_err(tool_error)?;
            let scope_label = scope_label_for(&scope, &scope_id);
            let artifact_path =
                reflection_lesson_artifact_path(artifacts_dir, &request.scope, &scope_id);
            let artifact_path_text = artifact_path.display().to_string();
            let saved = |lesson_id: String, already_saved: bool| ReflectionLessonResponse {
                lesson_id,
                scope: request.scope.clone(),
                scope_id: scope_id.clone(),
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
            // A pending row uploads only to the account it was saved for.
            let owner_account_id = remote.as_ref().map(|remote| remote.account_id());
            if let Some(remote) = remote {
                match remote
                    .save(NewRemoteMemory {
                        scope: request.scope.clone(),
                        scope_id: scope_id.clone(),
                        scope_label: scope_label.clone(),
                        source: request.source.clone(),
                        text: lesson_text.clone(),
                        client_memory_id: Some(lesson_id.clone()),
                        category: request.category.clone(),
                        confidence: request.confidence.clone(),
                        declared_by: Some("agent".to_string()),
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
                        owner_account_id,
                        category: request.category.clone(),
                        declaration_type: Some(MODEL_INFERRED.to_string()),
                        confidence: request.confidence.clone(),
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
