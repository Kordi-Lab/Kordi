use bb_core::error::{BbError, BbResult};
use futures::future::BoxFuture;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::{ToolResult, support::text_result, text::format_limited_results};

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceEntrySummary {
    pub path: String,
    pub name: String,
    pub kind: WorkspaceEntryKind,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceEntriesSnapshot {
    pub workspace_root: String,
    pub path: String,
    pub items: Vec<WorkspaceEntrySummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceFileTextSnapshot {
    pub workspace_root: String,
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub byte_size: u64,
    pub line_count: u64,
    pub start_line: u64,
    pub end_line: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceGrepSnapshot {
    pub workspace_root: String,
    pub path: String,
    pub items: Vec<String>,
    pub match_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceFindSnapshot {
    pub workspace_root: String,
    pub path: String,
    pub items: Vec<String>,
    pub match_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExpandedWorkspaceInputSnapshot {
    pub text: String,
    pub expanded_paths: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorPayload {
    error: String,
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

async fn decode_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> BbResult<T> {
    let status = response.status();
    if status.is_success() {
        return response.json::<T>().await.map_err(|error| {
            BbError::Tool(format!("Decoding workspace API response failed: {error}"))
        });
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| BbError::Tool(format!("Reading workspace API error failed: {error}")))?;
    let message = serde_json::from_slice::<ErrorPayload>(&body)
        .map(|payload| payload.error)
        .unwrap_or_else(|_| String::from_utf8_lossy(&body).trim().to_string());
    let prefix = match status {
        StatusCode::NOT_FOUND => "Workspace path not found",
        StatusCode::BAD_REQUEST => "Workspace request failed",
        StatusCode::NOT_IMPLEMENTED => "Workspace operation not supported",
        _ => "Workspace API request failed",
    };
    Err(BbError::Tool(format!("{prefix}: {message}")))
}

pub async fn fetch_entries(base_url: &str, path: &str) -> BbResult<WorkspaceEntriesSnapshot> {
    let response = reqwest::Client::new()
        .get(endpoint(base_url, "/v1/workspace/entries"))
        .query(&[("path", path)])
        .send()
        .await
        .map_err(|error| BbError::Tool(format!("Calling workspace entries API failed: {error}")))?;
    decode_response(response).await
}

pub async fn fetch_file(
    base_url: &str,
    path: &str,
    offset: usize,
    limit: usize,
) -> BbResult<WorkspaceFileTextSnapshot> {
    let response = reqwest::Client::new()
        .get(endpoint(base_url, "/v1/workspace/file"))
        .query(&[
            ("path", path.to_string()),
            ("offset", offset.to_string()),
            ("limit", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|error| BbError::Tool(format!("Calling workspace file API failed: {error}")))?;
    decode_response(response).await
}

pub async fn fetch_grep(
    base_url: &str,
    pattern: &str,
    path: Option<&str>,
    glob: Option<&str>,
    ignore_case: bool,
    literal: bool,
    context: usize,
    limit: usize,
) -> BbResult<WorkspaceGrepSnapshot> {
    let mut query = vec![
        ("pattern", pattern.to_string()),
        ("ignoreCase", ignore_case.to_string()),
        ("literal", literal.to_string()),
        ("context", context.to_string()),
        ("limit", limit.to_string()),
    ];
    if let Some(path) = path {
        query.push(("path", path.to_string()));
    }
    if let Some(glob) = glob {
        query.push(("glob", glob.to_string()));
    }

    let response = reqwest::Client::new()
        .get(endpoint(base_url, "/v1/workspace/grep"))
        .query(&query)
        .send()
        .await
        .map_err(|error| BbError::Tool(format!("Calling workspace grep API failed: {error}")))?;
    decode_response(response).await
}

pub async fn fetch_find(
    base_url: &str,
    pattern: &str,
    path: Option<&str>,
    limit: usize,
) -> BbResult<WorkspaceFindSnapshot> {
    let mut query = vec![
        ("pattern", pattern.to_string()),
        ("limit", limit.to_string()),
    ];
    if let Some(path) = path {
        query.push(("path", path.to_string()));
    }

    let response = reqwest::Client::new()
        .get(endpoint(base_url, "/v1/workspace/find"))
        .query(&query)
        .send()
        .await
        .map_err(|error| BbError::Tool(format!("Calling workspace find API failed: {error}")))?;
    decode_response(response).await
}

pub async fn expand_input(base_url: &str, input: &str) -> BbResult<ExpandedWorkspaceInputSnapshot> {
    let response = reqwest::Client::new()
        .post(endpoint(base_url, "/v1/workspace/expand-input"))
        .json(&json!({ "input": input }))
        .send()
        .await
        .map_err(|error| {
            BbError::Tool(format!(
                "Calling workspace expand-input API failed: {error}"
            ))
        })?;
    decode_response(response).await
}

pub async fn read_file_result(
    base_url: &str,
    path: &str,
    offset: usize,
    limit: usize,
) -> BbResult<ToolResult> {
    let snapshot = fetch_file(base_url, path, offset, limit).await?;
    let text = if snapshot.line_count > 0 && snapshot.start_line > snapshot.line_count {
        format!(
            "File has {} lines. Offset {} is past end of file.",
            snapshot.line_count, offset
        )
    } else {
        let mut text = snapshot.text;
        if snapshot.end_line < snapshot.line_count {
            let remaining = snapshot.line_count.saturating_sub(snapshot.end_line);
            text.push_str(&format!(
                "\n\n[{remaining} more lines in file. Use offset={} to continue.]",
                snapshot.end_line + 1
            ));
        }
        text
    };

    Ok(text_result(
        text,
        Some(json!({
            "path": snapshot.path,
            "totalLines": snapshot.line_count,
            "startLine": snapshot.start_line,
            "endLine": snapshot.end_line,
        })),
    ))
}

pub async fn list_directory_result(
    base_url: &str,
    path: &str,
    limit: usize,
    max_depth: usize,
) -> BbResult<ToolResult> {
    let root = fetch_entries(base_url, path).await?;
    let mut lines = Vec::new();
    let mut count = 0usize;
    let truncated = build_tree_lines(
        base_url,
        root,
        String::new(),
        0,
        max_depth,
        limit,
        &mut count,
        &mut lines,
    )
    .await?;

    let text = if lines.is_empty() {
        "Directory is empty.".to_string()
    } else {
        lines.join("\n")
    };

    Ok(text_result(
        text,
        Some(json!({
            "entryCount": count,
            "truncated": truncated,
        })),
    ))
}

fn build_tree_lines<'a>(
    base_url: &'a str,
    root: WorkspaceEntriesSnapshot,
    prefix: String,
    depth: usize,
    max_depth: usize,
    limit: usize,
    count: &'a mut usize,
    lines: &'a mut Vec<String>,
) -> BoxFuture<'a, BbResult<bool>> {
    Box::pin(async move {
        let items = root.items;
        let total = items.len();
        for (index, item) in items.into_iter().enumerate() {
            if *count >= limit {
                return Ok(true);
            }

            let is_last = index + 1 == total;
            let connector = if is_last { "└── " } else { "├── " };
            let display_name = if item.kind == WorkspaceEntryKind::Directory {
                format!("{}/", item.name)
            } else {
                item.name.clone()
            };
            lines.push(format!("{prefix}{connector}{display_name}"));
            *count += 1;

            if item.kind == WorkspaceEntryKind::Directory && depth < max_depth {
                let child_prefix = if is_last {
                    format!("{prefix}    ")
                } else {
                    format!("{prefix}│   ")
                };
                let child = fetch_entries(base_url, &item.path).await?;
                if build_tree_lines(
                    base_url,
                    child,
                    child_prefix,
                    depth + 1,
                    max_depth,
                    limit,
                    count,
                    lines,
                )
                .await?
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    })
}

pub async fn grep_result(
    base_url: &str,
    pattern: &str,
    path: Option<&str>,
    glob: Option<&str>,
    ignore_case: bool,
    literal: bool,
    context: usize,
    limit: usize,
) -> BbResult<ToolResult> {
    let snapshot = fetch_grep(
        base_url,
        pattern,
        path,
        glob,
        ignore_case,
        literal,
        context,
        limit,
    )
    .await?;
    let (text, _) = format_limited_results(&snapshot.items, "No matches found.", limit);
    Ok(text_result(
        text,
        Some(json!({
            "matchCount": snapshot.match_count,
            "truncated": snapshot.truncated,
        })),
    ))
}

pub async fn find_result(
    base_url: &str,
    pattern: &str,
    path: Option<&str>,
    limit: usize,
) -> BbResult<ToolResult> {
    let snapshot = fetch_find(base_url, pattern, path, limit).await?;
    let (text, _) = format_limited_results(&snapshot.items, "No files found.", limit);
    Ok(text_result(
        text,
        Some(json!({
            "matchCount": snapshot.match_count,
            "truncated": snapshot.truncated,
        })),
    ))
}
