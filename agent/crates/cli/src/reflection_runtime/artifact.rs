//! The scoped lesson files under `reflection-lessons/<scope>/`: a cache the
//! agent reads, rewritten from the `reflection_lessons` rows.
//!
//! Lines are `- <timestamp> [<source>|<category>|<declaration>] <text>`.
//! Files written before memory categories (#1977) hold `[<source>]` lines,
//! which still parse.

use std::path::Path;

use kordi_session::reflection_lessons::{ReflectionLesson, list_all_reflection_lessons};
use kordi_tools::memory_categories::{
    DEFAULT_MEMORY_CATEGORY, USER_DECLARED, declaration_for_source, is_memory_category,
};

use super::reflection_lesson_artifact_path;
use crate::memory_remote::group_lessons_by_scope;

const LESSON_ARTIFACT_TITLE: &str = "# Scoped reflection lessons";
const LESSON_SCOPE_ID_PREFIX: &str = "Scope ID: `";

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

/// The category a row is filed under: its own, else the default.
pub(crate) fn lesson_category(lesson: &ReflectionLesson) -> &str {
    lesson
        .category
        .as_deref()
        .filter(|category| is_memory_category(category))
        .unwrap_or(DEFAULT_MEMORY_CATEGORY)
}

/// The declaration type of a row: its own, else derived from the source.
pub(crate) fn lesson_declaration(lesson: &ReflectionLesson) -> &str {
    lesson
        .declaration_type
        .as_deref()
        .filter(|value| is_declaration(value))
        .unwrap_or_else(|| declaration_for_source(lesson.source.as_str()))
}

fn is_declaration(value: &str) -> bool {
    value == USER_DECLARED || value == kordi_tools::memory_categories::MODEL_INFERRED
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
            "- {} [{}|{}|{}] {}\n",
            lesson.created_at.trim(),
            lesson.source.as_str(),
            lesson_category(lesson),
            lesson_declaration(lesson),
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
    /// `None` for lines written before memory categories.
    pub category: Option<String>,
    /// `user-declared` or `model-inferred`; derived from the source when the
    /// line does not say.
    pub declaration_type: String,
    pub text: String,
}

/// Parse `- <timestamp> [<source>|<category>|<declaration>] <text>` lines and
/// the older `- <timestamp> [<source>] <text>`. Other lines are ignored.
pub(crate) fn parse_lesson_artifact(text: &str) -> Vec<ParsedLessonLine> {
    text.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("- ")?;
            let (created_at, rest) = rest.split_once(' ')?;
            chrono::DateTime::parse_from_rfc3339(created_at).ok()?;
            let rest = rest.strip_prefix('[')?;
            let (fields, rest) = rest.split_once(']')?;
            let text = rest.trim();
            let mut fields = fields.split('|').map(str::trim);
            let source = fields.next().unwrap_or_default();
            if source.is_empty() || text.is_empty() {
                return None;
            }
            let category = fields
                .next()
                .filter(|category| is_memory_category(category))
                .map(str::to_string);
            let declaration_type = fields
                .next()
                .filter(|value| is_declaration(value))
                .unwrap_or_else(|| declaration_for_source(source))
                .to_string();
            Some(ParsedLessonLine {
                created_at: created_at.to_string(),
                source: source.to_string(),
                category,
                declaration_type,
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
