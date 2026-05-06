use serde_json::Value;

use crate::ui_hints::more_lines_expand_hint;

use super::helpers::{arg_str, collapse_preview_line, preview_text_lines, shorten_path};

pub(super) fn render_call_body(args: &Value, expanded: bool) -> Vec<String> {
    match arg_str(args, "action").as_deref() {
        Some("manifest") => render_manifest_call(args, expanded),
        Some("estimate") => render_estimate_call(args),
        Some("spawn") => render_spawn_call(args, expanded),
        Some("message") => render_message_call(args, expanded),
        Some("wait") => render_wait_call(args),
        Some("list") => render_list_call(args),
        Some("close") => render_close_call(args),
        _ => Vec::new(),
    }
}

pub(super) fn render_result_body(details: Option<&Value>, expanded: bool) -> Option<Vec<String>> {
    let details = details?;
    let mut lines = Vec::new();

    if let Some(warning) = details.get("warning").and_then(|value| value.as_str()) {
        lines.push(format!("workflow warning: {warning}"));
        lines.push(String::new());
    }

    if let Some(manifest_id) = details.get("manifestId").and_then(|value| value.as_str()) {
        lines.push(format!("manifest accepted: {manifest_id}"));
        lines.extend(render_tasks_summary(details, expanded));
        append_estimate(&mut lines, details.get("estimate"));
        return Some(lines);
    }

    if details.get("estimate").is_some() {
        let status = details
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("estimated");
        lines.push(format!("status: {status}"));
        append_estimate(&mut lines, details.get("estimate"));
        return Some(lines);
    }

    if let Some(status) = details.get("status").and_then(|value| value.as_str()) {
        lines.push(format!("status: {status}"));
        if let Some(target) = details.get("target").and_then(|value| value.as_str()) {
            lines.push(format!("target: {target}"));
        }
        if let Some(message) = details.get("message").and_then(|value| value.as_str()) {
            lines.push(format!("message: {}", collapse_preview_line(message, 140)));
        }
        lines.extend(render_task_statuses(details.get("tasks"), expanded));
        return Some(lines);
    }

    if lines.is_empty() { None } else { Some(lines) }
}

pub(crate) fn title_inner(raw_args: &str) -> Option<String> {
    let args = serde_json::from_str::<Value>(raw_args).ok()?;
    match arg_str(&args, "action").as_deref()? {
        "manifest" => args
            .get("tasks")
            .and_then(|value| value.as_array())
            .map(|tasks| format!("manifest: {} task(s)", tasks.len())),
        "estimate" => Some("estimate".to_string()),
        "spawn" => Some(format!(
            "spawn {}",
            arg_str(&args, "taskName").unwrap_or_else(|| "task".to_string())
        )),
        "message" => Some(format!(
            "message {}",
            arg_str(&args, "target").unwrap_or_else(|| "task".to_string())
        )),
        "wait" => args
            .get("timeoutMs")
            .and_then(|value| value.as_u64())
            .map(|timeout| format!("wait {timeout}ms"))
            .or_else(|| Some("wait".to_string())),
        "list" => Some(format!(
            "list {}",
            arg_str(&args, "pathPrefix").unwrap_or_else(|| "/root".to_string())
        )),
        "close" => Some(format!(
            "close {}",
            arg_str(&args, "target").unwrap_or_else(|| "task".to_string())
        )),
        _ => None,
    }
}

fn render_manifest_call(args: &Value, expanded: bool) -> Vec<String> {
    let tasks = args
        .get("tasks")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut lines = vec![format!("manifest: {} task(s)", tasks.len())];
    let max_tasks = if expanded { 12 } else { 4 };
    for task in tasks.iter().take(max_tasks) {
        let task_id = task
            .get("taskId")
            .and_then(|value| value.as_str())
            .unwrap_or("task");
        let title = task
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let risk = task
            .get("risk")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let write_scope = format_write_scope(task.get("writeScope"));
        lines.push(format!(
            "- {task_id}: {} [{risk}; {write_scope}]",
            collapse_preview_line(title, 80)
        ));
    }
    if tasks.len() > max_tasks {
        lines.push(more_lines_expand_hint(tasks.len() - max_tasks));
    }
    lines
}

fn render_estimate_call(args: &Value) -> Vec<String> {
    let input = args
        .get("estimatedInputTokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let output = args
        .get("estimatedOutputTokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    vec![format!("estimate: {input} input + {output} output tokens")]
}

fn render_spawn_call(args: &Value, expanded: bool) -> Vec<String> {
    let task_name = arg_str(args, "taskName").unwrap_or_else(|| "task".to_string());
    let mut lines = vec![format!("spawn: {task_name}")];
    lines.push(format!(
        "write scope: {}",
        format_write_scope(args.get("writeScope"))
    ));
    if let Some(fork_turns) = arg_str(args, "forkTurns") {
        lines.push(format!("fork turns: {fork_turns}"));
    }
    append_message_preview(&mut lines, args, expanded);
    lines
}

fn render_message_call(args: &Value, expanded: bool) -> Vec<String> {
    let target = arg_str(args, "target").unwrap_or_default();
    let mut lines = vec![format!("target: {target}")];
    append_message_preview(&mut lines, args, expanded);
    lines
}

fn render_wait_call(args: &Value) -> Vec<String> {
    let timeout = args
        .get("timeoutMs")
        .and_then(|value| value.as_u64())
        .map(|timeout| format!("wait up to {timeout}ms"))
        .unwrap_or_else(|| "wait for next task update".to_string());
    vec![timeout]
}

fn render_list_call(args: &Value) -> Vec<String> {
    let prefix = arg_str(args, "pathPrefix").unwrap_or_else(|| "/root".to_string());
    vec![format!("path prefix: {prefix}")]
}

fn render_close_call(args: &Value) -> Vec<String> {
    let target = arg_str(args, "target").unwrap_or_default();
    vec![format!("target: {target}")]
}

fn append_message_preview(lines: &mut Vec<String>, args: &Value, expanded: bool) {
    if let Some(message) = arg_str(args, "message") {
        lines.push("message:".to_string());
        lines.extend(preview_text_lines(
            &message,
            if expanded { 16 } else { 3 },
            expanded,
        ));
    }
}

fn render_tasks_summary(details: &Value, expanded: bool) -> Vec<String> {
    let mut lines = Vec::new();
    let Some(tasks) = details.get("tasks").and_then(|value| value.as_array()) else {
        return lines;
    };
    lines.push(format!("{} task(s)", tasks.len()));
    let max_tasks = if expanded { 12 } else { 4 };
    for task in tasks.iter().take(max_tasks) {
        let task_id = task
            .get("taskId")
            .or_else(|| task.get("path"))
            .and_then(|value| value.as_str())
            .unwrap_or("task");
        let title = task
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let status_or_risk = task
            .get("status")
            .or_else(|| task.get("risk"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        lines.push(format!(
            "- {task_id}: {} [{status_or_risk}]",
            collapse_preview_line(title, 80)
        ));
    }
    if tasks.len() > max_tasks {
        lines.push(more_lines_expand_hint(tasks.len() - max_tasks));
    }
    lines
}

fn render_task_statuses(tasks: Option<&Value>, expanded: bool) -> Vec<String> {
    let mut lines = Vec::new();
    let Some(tasks) = tasks.and_then(|value| value.as_array()) else {
        return lines;
    };
    if tasks.is_empty() {
        return lines;
    }
    lines.push(String::new());
    lines.push(format!("{} task(s):", tasks.len()));
    let max_tasks = if expanded { 12 } else { 5 };
    for task in tasks.iter().take(max_tasks) {
        let path = task
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("task");
        let status = task
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let title = task
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut line = format!("- {path} [{status}]");
        if !title.is_empty() {
            line.push_str(&format!(" {}", collapse_preview_line(title, 72)));
        }
        if let Some(summary) = task.get("summary").and_then(|value| value.as_str()) {
            line.push_str(&format!(" — {}", collapse_preview_line(summary, 72)));
        }
        lines.push(line);
    }
    if tasks.len() > max_tasks {
        lines.push(more_lines_expand_hint(tasks.len() - max_tasks));
    }
    lines
}

fn append_estimate(lines: &mut Vec<String>, estimate: Option<&Value>) {
    let Some(estimate) = estimate else {
        return;
    };
    let input = estimate
        .get("inputTokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let output = estimate
        .get("outputTokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let cost = estimate
        .get("costMicrounits")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    lines.push(format!(
        "estimate: {input} input + {output} output tokens, {cost} microunits"
    ));
}

fn format_write_scope(value: Option<&Value>) -> String {
    let scopes = value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(shorten_path)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if scopes.is_empty() {
        "read-only".to_string()
    } else if scopes.len() <= 3 {
        scopes.join(", ")
    } else {
        format!("{}, +{} more", scopes[..3].join(", "), scopes.len() - 3)
    }
}
