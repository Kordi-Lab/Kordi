use anyhow::{Result, anyhow};
use chrono::Utc;
use rusqlite::{Connection, params};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReflectionScope {
    Conversation,
    Group,
    Project,
}

impl ReflectionScope {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Group => "group",
            Self::Project => "project",
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "group" => Ok(Self::Group),
            "project" => Ok(Self::Project),
            other => Err(anyhow!("unknown reflection scope `{other}`")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReflectionSource {
    UserCorrection,
    RepeatedFailure,
    Outcome,
    Manual,
}

impl ReflectionSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::UserCorrection => "user_correction",
            Self::RepeatedFailure => "repeated_failure",
            Self::Outcome => "outcome",
            Self::Manual => "manual",
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "user_correction" => Ok(Self::UserCorrection),
            "repeated_failure" => Ok(Self::RepeatedFailure),
            "outcome" => Ok(Self::Outcome),
            "manual" => Ok(Self::Manual),
            other => Err(anyhow!("unknown reflection source `{other}`")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewReflectionLesson {
    pub scope: ReflectionScope,
    pub scope_id: String,
    pub lesson: String,
    pub source: ReflectionSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReflectionLesson {
    pub lesson_id: String,
    pub scope: ReflectionScope,
    pub scope_id: String,
    pub lesson: String,
    pub source: ReflectionSource,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

pub fn save_reflection_lesson(conn: &Connection, lesson: NewReflectionLesson) -> Result<String> {
    let scope_id = lesson.scope_id.trim();
    let lesson_text = lesson.lesson.trim();
    if scope_id.is_empty() {
        return Err(anyhow!("reflection scope_id cannot be empty"));
    }
    if lesson_text.is_empty() {
        return Err(anyhow!("reflection lesson cannot be empty"));
    }

    let lesson_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO reflection_lessons (
             lesson_id, scope, scope_id, lesson, source, created_at, updated_at, archived_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![
            lesson_id,
            lesson.scope.as_str(),
            scope_id,
            lesson_text,
            lesson.source.as_str(),
            now,
            now,
        ],
    )?;
    Ok(lesson_id)
}

pub fn list_reflection_lessons(
    conn: &Connection,
    scope: ReflectionScope,
    scope_id: &str,
) -> Result<Vec<ReflectionLesson>> {
    let mut stmt = conn.prepare(
        "SELECT lesson_id, scope, scope_id, lesson, source, created_at, updated_at, archived_at
         FROM reflection_lessons
         WHERE scope = ?1 AND scope_id = ?2 AND archived_at IS NULL
         ORDER BY updated_at ASC, lesson_id ASC",
    )?;
    let rows = stmt.query_map(params![scope.as_str(), scope_id], |row| {
        let scope_value: String = row.get(1)?;
        let source_value: String = row.get(4)?;
        Ok((
            row.get::<_, String>(0)?,
            scope_value,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            source_value,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;

    let mut lessons = Vec::new();
    for row in rows {
        let (lesson_id, scope, scope_id, lesson, source, created_at, updated_at, archived_at) =
            row?;
        lessons.push(ReflectionLesson {
            lesson_id,
            scope: ReflectionScope::from_str(&scope)?,
            scope_id,
            lesson,
            source: ReflectionSource::from_str(&source)?,
            created_at,
            updated_at,
            archived_at,
        });
    }
    Ok(lessons)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_lists_and_archives_scoped_lessons() {
        let conn = crate::store::open_memory().expect("memory db");
        let lesson_id = save_reflection_lesson(
            &conn,
            NewReflectionLesson {
                scope: ReflectionScope::Project,
                scope_id: "/repo".to_string(),
                lesson: "Inspect exact failing assertions before editing again.".to_string(),
                source: ReflectionSource::RepeatedFailure,
            },
        )
        .expect("save lesson");

        let lessons = list_reflection_lessons(&conn, ReflectionScope::Project, "/repo")
            .expect("list lessons");
        assert_eq!(lessons.len(), 1);
        assert_eq!(lessons[0].lesson_id, lesson_id);
        assert_eq!(lessons[0].scope, ReflectionScope::Project);
        assert_eq!(lessons[0].source, ReflectionSource::RepeatedFailure);

        archive_reflection_lesson(&conn, &lesson_id).expect("archive lesson");
        let lessons = list_reflection_lessons(&conn, ReflectionScope::Project, "/repo")
            .expect("list lessons after archive");
        assert!(lessons.is_empty());
    }
}
