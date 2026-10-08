use anyhow::{Result, anyhow};
use chrono::Utc;
use rusqlite::{Connection, params};
use uuid::Uuid;

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ReflectionScope {
    #[default]
    Conversation,
    Group,
    Project,
}

impl ReflectionScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Group => "group",
            Self::Project => "project",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "group" => Ok(Self::Group),
            "project" => Ok(Self::Project),
            other => Err(anyhow!("unknown reflection scope `{other}`")),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ReflectionSource {
    UserCorrection,
    RepeatedFailure,
    Outcome,
    #[default]
    Manual,
}

impl ReflectionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UserCorrection => "user_correction",
            Self::RepeatedFailure => "repeated_failure",
            Self::Outcome => "outcome",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "user_correction" => Ok(Self::UserCorrection),
            "repeated_failure" => Ok(Self::RepeatedFailure),
            "outcome" => Ok(Self::Outcome),
            "manual" => Ok(Self::Manual),
            other => Err(anyhow!("unknown reflection source `{other}`")),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewReflectionLesson {
    pub scope: ReflectionScope,
    pub scope_id: String,
    pub artifact_path: String,
    pub source: ReflectionSource,
    /// The memory text. The artifact file is rewritten from this cache.
    pub lesson_text: String,
    pub scope_label: Option<String>,
    /// The account memory id once the server has the row.
    pub remote_memory_id: Option<String>,
    /// True while the row still has to be sent to the account.
    pub pending_upload: bool,
    /// Explicit id. A fresh id is generated when absent.
    pub lesson_id: Option<String>,
    /// Explicit creation time (RFC 3339). Now when absent.
    pub created_at: Option<String>,
    /// Explicit update time (RFC 3339). The creation time when absent.
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReflectionLesson {
    pub lesson_id: String,
    pub scope: ReflectionScope,
    pub scope_id: String,
    pub artifact_path: String,
    pub source: ReflectionSource,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    /// `None` for rows written before the text moved into the cache.
    pub lesson_text: Option<String>,
    pub scope_label: Option<String>,
    pub remote_memory_id: Option<String>,
    pub pending_upload: bool,
}

/// Generate a local memory id. It fits the account `clientMemoryId` format
/// (`[A-Za-z0-9_-]{1,128}`), so the same id is sent as the retry key.
pub fn new_reflection_lesson_id() -> String {
    format!("mem_{}", Uuid::new_v4().simple())
}

pub fn save_reflection_lesson(conn: &Connection, lesson: NewReflectionLesson) -> Result<String> {
    insert_reflection_lesson(conn, lesson)
}

fn insert_reflection_lesson(conn: &Connection, lesson: NewReflectionLesson) -> Result<String> {
    let scope_id = lesson.scope_id.trim();
    let artifact_path = lesson.artifact_path.trim();
    if scope_id.is_empty() {
        return Err(anyhow!("reflection scope_id cannot be empty"));
    }
    if artifact_path.is_empty() {
        return Err(anyhow!("reflection artifact_path cannot be empty"));
    }

    let lesson_id = lesson
        .lesson_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(new_reflection_lesson_id);
    let created_at = lesson
        .created_at
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let updated_at = lesson
        .updated_at
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| created_at.clone());
    conn.execute(
        "INSERT OR REPLACE INTO reflection_lessons (
             lesson_id, scope, scope_id, artifact_path, source, created_at, updated_at, archived_at,
             lesson_text, remote_memory_id, pending_upload, scope_label
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11)",
        params![
            lesson_id,
            lesson.scope.as_str(),
            scope_id,
            artifact_path,
            lesson.source.as_str(),
            created_at,
            updated_at,
            lesson.lesson_text,
            lesson.remote_memory_id,
            lesson.pending_upload,
            lesson.scope_label,
        ],
    )?;
    Ok(lesson_id)
}

const LESSON_COLUMNS: &str = "lesson_id, scope, scope_id, artifact_path, source, created_at, \
     updated_at, archived_at, lesson_text, scope_label, remote_memory_id, pending_upload";

fn query_lessons(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<ReflectionLesson>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, i64>(11)?,
        ))
    })?;

    let mut lessons = Vec::new();
    for row in rows {
        let (
            lesson_id,
            scope,
            scope_id,
            artifact_path,
            source,
            created_at,
            updated_at,
            archived_at,
            lesson_text,
            scope_label,
            remote_memory_id,
            pending_upload,
        ) = row?;
        lessons.push(ReflectionLesson {
            lesson_id,
            scope: ReflectionScope::parse(&scope)?,
            scope_id,
            artifact_path,
            source: ReflectionSource::parse(&source)?,
            created_at,
            updated_at,
            archived_at,
            lesson_text,
            scope_label,
            remote_memory_id,
            pending_upload: pending_upload != 0,
        });
    }
    Ok(lessons)
}

pub fn list_reflection_lessons(
    conn: &Connection,
    scope: ReflectionScope,
    scope_id: &str,
) -> Result<Vec<ReflectionLesson>> {
    query_lessons(
        conn,
        &format!(
            "SELECT {LESSON_COLUMNS} FROM reflection_lessons
             WHERE scope = ?1 AND scope_id = ?2 AND archived_at IS NULL
             ORDER BY created_at ASC, lesson_id ASC"
        ),
        params![scope.as_str(), scope_id],
    )
}

/// Every non-archived row, oldest first.
pub fn list_all_reflection_lessons(conn: &Connection) -> Result<Vec<ReflectionLesson>> {
    query_lessons(
        conn,
        &format!(
            "SELECT {LESSON_COLUMNS} FROM reflection_lessons
             WHERE archived_at IS NULL
             ORDER BY created_at ASC, lesson_id ASC"
        ),
        [],
    )
}

/// Non-archived rows that still have to be sent to the account, oldest first.
pub fn list_pending_upload_reflection_lessons(conn: &Connection) -> Result<Vec<ReflectionLesson>> {
    query_lessons(
        conn,
        &format!(
            "SELECT {LESSON_COLUMNS} FROM reflection_lessons
             WHERE archived_at IS NULL AND pending_upload <> 0
             ORDER BY created_at ASC, lesson_id ASC"
        ),
        [],
    )
}

pub fn mark_reflection_lesson_uploaded(
    conn: &Connection,
    lesson_id: &str,
    remote_memory_id: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE reflection_lessons
         SET remote_memory_id = ?2, pending_upload = 0
         WHERE lesson_id = ?1",
        params![lesson_id, remote_memory_id],
    )?;
    Ok(())
}

pub fn update_reflection_lesson_text(conn: &Connection, lesson_id: &str, text: &str) -> Result<()> {
    conn.execute(
        "UPDATE reflection_lessons
         SET lesson_text = ?2, updated_at = ?3
         WHERE lesson_id = ?1",
        params![lesson_id, text, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn archive_reflection_lesson(conn: &Connection, lesson_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE reflection_lessons
         SET archived_at = datetime('now'), updated_at = datetime('now')
         WHERE lesson_id = ?1",
        params![lesson_id],
    )?;
    Ok(())
}

/// Archive every non-archived row. Returns how many rows were archived.
pub fn archive_all_reflection_lessons(conn: &Connection) -> Result<usize> {
    let count = conn.execute(
        "UPDATE reflection_lessons
         SET archived_at = datetime('now'), updated_at = datetime('now')
         WHERE archived_at IS NULL",
        [],
    )?;
    Ok(count)
}

/// Replace the cached account memories with `rows` in one transaction.
///
/// Every non-archived row that is not waiting for upload is archived, then
/// `rows` are inserted with their remote ids as lesson ids and
/// `pending_upload = 0`. Rows still waiting for upload are kept.
pub fn replace_reflection_lessons_from_remote(
    conn: &Connection,
    rows: Vec<NewReflectionLesson>,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE reflection_lessons
         SET archived_at = datetime('now'), updated_at = datetime('now')
         WHERE archived_at IS NULL AND pending_upload = 0",
        [],
    )?;
    for mut row in rows {
        let remote_id = row
            .remote_memory_id
            .clone()
            .or_else(|| row.lesson_id.clone())
            .ok_or_else(|| anyhow!("remote memory row needs a memory id"))?;
        row.lesson_id = Some(remote_id.clone());
        row.remote_memory_id = Some(remote_id);
        row.pending_upload = false;
        insert_reflection_lesson(&tx, row)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
