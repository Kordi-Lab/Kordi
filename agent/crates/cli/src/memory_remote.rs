//! Account memory write-through for the Mac harness (#1710).
//!
//! When the person is signed in, the account server owns memories. The Mac
//! keeps `reflection_lessons` rows and the `reflection-lessons/<scope>/*.md`
//! files as a cache that is refreshed from the server list.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kordi_session::reflection_lessons::{
    NewReflectionLesson, ReflectionScope, ReflectionSource, archive_reflection_lesson,
    list_all_reflection_lessons, list_pending_upload_reflection_lessons,
    mark_reflection_lesson_uploaded, replace_reflection_lessons_from_remote,
    save_reflection_lesson,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[path = "memory_remote/labels.rs"]
mod labels;
pub(crate) use labels::scope_label_for;
#[allow(
    unused_imports,
    reason = "the desktop library uses these; the CLI binary does not"
)]
pub use labels::{MESSAGE_LABEL_MAX_CHARS, label_from_message, remember_scope_label};

use crate::reflection_runtime::{
    parse_lesson_artifact, parse_lesson_artifact_scope_id, reflection_lesson_artifact_path,
    rewrite_all_lesson_artifacts,
};

/// One account memory as the server returns it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemory {
    pub memory_id: String,
    pub scope: String,
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Body of `POST /v1/cloud/memory`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewRemoteMemory {
    pub scope: String,
    pub scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_memory_id: Option<String>,
}

/// Account memory switches as the server returns them.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemorySettings {
    pub memory_enabled: bool,
    pub exclude_sensitive: bool,
}

/// Body of `GET /v1/cloud/memory`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemoryList {
    pub memories: Vec<RemoteMemory>,
    pub settings: RemoteMemorySettings,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MemoryRemoteError {
    /// The server cannot be reached, the person is signed out, or the server
    /// predates the memory routes. The Mac keeps working locally.
    #[error("account memory is unavailable: {0}")]
    Unavailable(String),
    /// The server guards rejected the text (422 `memory_rejected`).
    #[error("{0}")]
    Rejected(String),
    /// Memory is off for the account (409 `memory_disabled`).
    #[error("Memory is turned off for this account, so nothing was saved.")]
    Disabled,
    #[error("account memory request failed: {0}")]
    Other(String),
}

#[async_trait::async_trait]
pub trait MemoryRemote: Send + Sync {
    fn account_id(&self) -> String;
    async fn list(&self) -> Result<RemoteMemoryList, MemoryRemoteError>;
    async fn save(&self, memory: NewRemoteMemory) -> Result<RemoteMemory, MemoryRemoteError>;
}

/// Shared slot the desktop runtime fills once it knows the cloud session.
pub(crate) type MemoryRemoteSlot = Arc<std::sync::RwLock<Option<Arc<dyn MemoryRemote>>>>;

pub(crate) fn empty_memory_remote_slot() -> MemoryRemoteSlot {
    Arc::new(std::sync::RwLock::new(None))
}

pub(crate) fn current_memory_remote(slot: &MemoryRemoteSlot) -> Option<Arc<dyn MemoryRemote>> {
    slot.read().ok().and_then(|guard| guard.clone())
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub rejected: usize,
    /// Account settings from the list response; `None` when the list was not
    /// reached.
    pub settings: Option<RemoteMemorySettings>,
}

/// Normalise memory text for comparisons: collapse whitespace and fold case.
pub(crate) fn normalise_memory_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Insert a pending cache row for every lesson line in `artifact_path` that
/// the cache does not already hold for that scope. Returns how many rows were
/// added. Lines keep their file order through the id sequence suffix.
pub(crate) fn import_unlisted_artifact_lines(
    conn: &rusqlite::Connection,
    artifact_path: &Path,
    scope: &ReflectionScope,
    scope_id: &str,
) -> anyhow::Result<usize> {
    let Ok(text) = std::fs::read_to_string(artifact_path) else {
        return Ok(0);
    };
    let lines = parse_lesson_artifact(&text);
    if lines.is_empty() {
        return Ok(0);
    }
    let mut known = list_all_reflection_lessons(conn)?
        .into_iter()
        .filter(|row| &row.scope == scope && row.scope_id == scope_id.trim())
        .filter_map(|row| row.lesson_text.map(|text| normalise_memory_text(&text)))
        .collect::<HashSet<_>>();
    let base = uuid::Uuid::new_v4().simple().to_string();
    let mut added = 0;
    for (index, line) in lines.into_iter().enumerate() {
        let normalised = normalise_memory_text(&line.text);
        if normalised.is_empty() || !known.insert(normalised) {
            continue;
        }
        let source = ReflectionSource::parse(&line.source).unwrap_or(ReflectionSource::Manual);
        save_reflection_lesson(
            conn,
            NewReflectionLesson {
                scope: scope.clone(),
                scope_id: scope_id.trim().to_string(),
                artifact_path: artifact_path.display().to_string(),
                source,
                lesson_text: line.text,
                scope_label: scope_label_for(scope, scope_id),
                remote_memory_id: None,
                pending_upload: true,
                lesson_id: Some(format!("mem_{base}_{index:05}")),
                created_at: Some(line.created_at),
                updated_at: None,
            },
        )?;
        added += 1;
    }
    Ok(added)
}

fn upload_marker_path(artifacts_dir: &Path, account_id: &str) -> PathBuf {
    let safe = account_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    artifacts_dir
        .join("reflection-lessons")
        .join(format!(".uploaded-{safe}"))
}

/// Import every pre-existing lesson file once per account.
async fn backfill_existing_files(
    conn: &Mutex<rusqlite::Connection>,
    artifacts_dir: &Path,
    account_id: &str,
) -> anyhow::Result<()> {
    let marker = upload_marker_path(artifacts_dir, account_id);
    if marker.exists() {
        return Ok(());
    }
    let root = artifacts_dir.join("reflection-lessons");
    if let Ok(scopes) = std::fs::read_dir(&root) {
        let conn = conn.lock().await;
        for scope_entry in scopes.flatten() {
            let Some(scope_name) = scope_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(scope) = ReflectionScope::parse(&scope_name) else {
                continue;
            };
            let Ok(files) = std::fs::read_dir(scope_entry.path()) else {
                continue;
            };
            let mut paths = files
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
                .collect::<Vec<_>>();
            paths.sort();
            for path in paths {
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Some(scope_id) = parse_lesson_artifact_scope_id(&text) else {
                    continue;
                };
                // Read through the canonical path so the row points at the
                // file the agent reads.
                let canonical =
                    reflection_lesson_artifact_path(artifacts_dir, &scope_name, &scope_id);
                let source_path = if canonical.exists() { canonical } else { path };
                import_unlisted_artifact_lines(&conn, &source_path, &scope, &scope_id)?;
            }
        }
    }
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&marker, b"")?;
    Ok(())
}

fn remote_rows(artifacts_dir: &Path, memories: Vec<RemoteMemory>) -> Vec<NewReflectionLesson> {
    memories
        .into_iter()
        .filter_map(|memory| {
            let scope = ReflectionScope::parse(&memory.scope).ok()?;
            let source =
                ReflectionSource::parse(&memory.source).unwrap_or(ReflectionSource::Manual);
            if memory.memory_id.trim().is_empty() || memory.scope_id.trim().is_empty() {
                return None;
            }
            let artifact_path =
                reflection_lesson_artifact_path(artifacts_dir, &memory.scope, &memory.scope_id);
            Some(NewReflectionLesson {
                scope,
                scope_id: memory.scope_id,
                artifact_path: artifact_path.display().to_string(),
                source,
                lesson_text: memory.text,
                scope_label: memory.scope_label,
                remote_memory_id: Some(memory.memory_id.clone()),
                pending_upload: false,
                lesson_id: Some(memory.memory_id),
                created_at: Some(memory.created_at),
                updated_at: Some(memory.updated_at),
            })
        })
        .collect()
}

/// Upload pending memories, refresh the cache from the account, and rewrite
/// the lesson files.
pub async fn sync_memories_with_remote(
    conn: &Mutex<rusqlite::Connection>,
    artifacts_dir: &Path,
    remote: &dyn MemoryRemote,
) -> anyhow::Result<MemorySyncReport> {
    let mut report = MemorySyncReport::default();

    // (1) One-time upload of files written before the account owned memories.
    backfill_existing_files(conn, artifacts_dir, &remote.account_id()).await?;

    // (2) Upload pending rows.
    let pending = {
        let conn = conn.lock().await;
        list_pending_upload_reflection_lessons(&conn)?
    };
    for row in pending {
        let Some(text) = row.lesson_text.clone() else {
            continue;
        };
        let request = NewRemoteMemory {
            scope: row.scope.as_str().to_string(),
            scope_id: row.scope_id.clone(),
            scope_label: row
                .scope_label
                .clone()
                .or_else(|| scope_label_for(&row.scope, &row.scope_id)),
            source: row.source.as_str().to_string(),
            text,
            client_memory_id: Some(row.lesson_id.clone()),
        };
        match remote.save(request).await {
            Ok(memory) => {
                let conn = conn.lock().await;
                mark_reflection_lesson_uploaded(&conn, &row.lesson_id, &memory.memory_id)?;
                report.uploaded += 1;
            }
            Err(MemoryRemoteError::Rejected(message)) => {
                tracing::warn!(lesson_id = %row.lesson_id, "account rejected memory: {message}");
                let conn = conn.lock().await;
                archive_reflection_lesson(&conn, &row.lesson_id)?;
                report.rejected += 1;
            }
            Err(MemoryRemoteError::Unavailable(_)) => return Ok(report),
            Err(MemoryRemoteError::Disabled) => {
                // Memory is off for the account: keep the rows local and pending.
                break;
            }
            Err(MemoryRemoteError::Other(message)) => {
                tracing::warn!(lesson_id = %row.lesson_id, "memory upload failed: {message}");
                return Ok(report);
            }
        }
    }

    // (3) Refresh the cache from the account list.
    let list = match remote.list().await {
        Ok(list) => list,
        Err(MemoryRemoteError::Unavailable(_)) => return Ok(report),
        Err(error) => return Err(anyhow::anyhow!(error.to_string())),
    };
    report.settings = Some(list.settings);
    let rows = remote_rows(artifacts_dir, list.memories);
    report.downloaded = rows.len();
    let conn = conn.lock().await;
    replace_reflection_lessons_from_remote(&conn, rows)?;

    // (4) Rewrite the lesson files from the cache.
    rewrite_all_lesson_artifacts(&conn, artifacts_dir)?;
    Ok(report)
}

/// Group cache rows that carry text by (scope, scope id).
pub(crate) fn group_lessons_by_scope(
    lessons: Vec<kordi_session::reflection_lessons::ReflectionLesson>,
) -> BTreeMap<(String, String), Vec<kordi_session::reflection_lessons::ReflectionLesson>> {
    let mut groups: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for lesson in lessons {
        if lesson.lesson_text.is_none() {
            continue;
        }
        groups
            .entry((lesson.scope.as_str().to_string(), lesson.scope_id.clone()))
            .or_default()
            .push(lesson);
    }
    groups
}

#[cfg(test)]
#[path = "memory_remote/tests.rs"]
mod tests;
