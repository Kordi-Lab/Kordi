use serde_json::Value;

use super::helpers::{arg_str, collapse_preview_line, preview_text_lines, shorten_path};

pub(super) fn render_call_body(args: &Value, expanded: bool) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(scope) = arg_str(args, "scope") {
        lines.push(format!("scope: {scope}"));
    }
    if let Some(scope_id) = arg_str(args, "scopeId") {
        lines.push(format!("scope id: {}", shorten_path(&scope_id)));
    }
    if let Some(source) = arg_str(args, "source") {
        lines.push(format!("source: {source}"));
    }
    if let Some(lesson) = arg_str(args, "lesson") {
        lines.push("lesson:".to_string());
        lines.extend(preview_text_lines(
            &lesson,
            if expanded { 8 } else { 3 },
            expanded,
        ));
    }
    lines
}

pub(super) fn render_result_body(details: Option<&Value>) -> Option<Vec<String>> {
    let details = details?;
    if details.get("status").and_then(|value| value.as_str()) != Some("saved") {
        return None;
    }

    let mut lines = vec!["lesson saved".to_string()];
    if let Some(scope) = details.get("scope").and_then(|value| value.as_str()) {
        lines.push(format!("scope: {scope}"));
    }
    if let Some(scope_id) = details.get("scopeId").and_then(|value| value.as_str()) {
        lines.push(format!("scope id: {}", shorten_path(scope_id)));
    }
    if let Some(lesson_id) = details.get("lessonId").and_then(|value| value.as_str()) {
        lines.push(format!("lesson id: {lesson_id}"));
    }
    Some(lines)
}

pub(crate) fn title_inner(raw_args: &str) -> Option<String> {
    let args = serde_json::from_str::<Value>(raw_args).ok()?;
    let scope = arg_str(&args, "scope")?;
    let source = arg_str(&args, "source").unwrap_or_else(|| "lesson".to_string());
    let lesson = arg_str(&args, "lesson")
        .map(|lesson| collapse_preview_line(&lesson, 60))
        .unwrap_or_default();
    if lesson.is_empty() {
        Some(format!("{scope}/{source}"))
    } else {
        Some(format!("{scope}/{source}: {lesson}"))
    }
}
