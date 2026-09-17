use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use crate::{
    Tool, ToolContext, ToolResult, path::resolve_path, support::text_result,
    text::format_limited_results,
};

const DEFAULT_LIMIT: usize = 100;
const MAX_MATCH_LINE_COLUMNS: usize = 2_000;
const MAX_SEARCH_FILE_SIZE: &str = "1M";
const MAX_SEARCH_STREAM_BYTES: usize = 512 * 1024;
const DEFAULT_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".multi-instance-data",
    ".multi-instance-logs",
    "node_modules",
    "target",
];

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn description(&self) -> &str {
        "Search file contents using ripgrep (rg). Falls back to grep -rn if rg is unavailable. \
         Returns matching lines with file:line: prefix."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Search pattern (regex or literal string)"
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file to search (default: current directory)"
                },
                "glob": {
                    "type": "string",
                    "description": "Filter files by glob pattern, e.g. '*.rs' or '**/*.spec.ts'"
                },
                "ignoreCase": {
                    "type": "boolean",
                    "description": "Case-insensitive search (default: false)"
                },
                "literal": {
                    "type": "boolean",
                    "description": "Treat pattern as literal string instead of regex (default: false)"
                },
                "context": {
                    "type": "number",
                    "description": "Number of lines to show before and after each match (default: 0)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of matches to return (default: 100)"
                }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let pattern = params
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| KordiError::Tool("Missing 'pattern' parameter".into()))?;

        let search_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .map(|p| resolve_path(&ctx.cwd, p))
            .unwrap_or_else(|| ctx.cwd.clone());

        let glob_filter = params.get("glob").and_then(|v| v.as_str());
        let ignore_case = params
            .get("ignoreCase")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let literal = params
            .get("literal")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let context_lines = params
            .get("context")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_LIMIT);

        if !search_path.exists() {
            return Err(KordiError::Tool(format!(
                "Path not found: {}",
                search_path.display()
            )));
        }

        // Try rg first
        match grep_with_rg(
            pattern,
            &search_path,
            glob_filter,
            ignore_case,
            literal,
            context_lines,
            limit,
        )
        .await
        {
            Ok(results) => format_results(results, limit),
            Err(_) => {
                // Fall back to grep -rn
                match grep_with_grep_cmd(
                    pattern,
                    &search_path,
                    ignore_case,
                    literal,
                    context_lines,
                    limit,
                )
                .await
                {
                    Ok(results) => format_results(results, limit),
                    Err(e) => Err(KordiError::Tool(format!("Grep failed: {e}"))),
                }
            }
        }
    }
}

async fn grep_with_rg(
    pattern: &str,
    path: &Path,
    glob_filter: Option<&str>,
    ignore_case: bool,
    literal: bool,
    context_lines: usize,
    limit: usize,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut cmd = Command::new("rg");
    cmd.arg("--line-number")
        .arg("--no-heading")
        .arg("--max-count")
        .arg(limit.to_string())
        .arg("--max-columns")
        .arg(MAX_MATCH_LINE_COLUMNS.to_string())
        .arg("--max-filesize")
        .arg(MAX_SEARCH_FILE_SIZE);

    for excluded_dir in DEFAULT_EXCLUDED_DIRS {
        cmd.arg("--glob").arg(format!("!{excluded_dir}/**"));
        cmd.arg("--glob").arg(format!("!**/{excluded_dir}/**"));
    }

    if ignore_case {
        cmd.arg("--ignore-case");
    }
    if literal {
        cmd.arg("--fixed-strings");
    }
    if context_lines > 0 {
        cmd.arg("--context").arg(context_lines.to_string());
    }
    if let Some(glob) = glob_filter {
        cmd.arg("--glob").arg(glob);
    }

    cmd.arg(pattern).arg(path);

    let output = run_search_command_capped(cmd).await?;

    // rg returns exit code 1 for "no matches" — that's not an error
    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rg failed: {stderr}").into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty() && !result_line_has_excluded_dir(l))
        .take(limit)
        .map(|l| l.to_string())
        .collect();
    Ok(results)
}

async fn grep_with_grep_cmd(
    pattern: &str,
    path: &Path,
    ignore_case: bool,
    literal: bool,
    context_lines: usize,
    limit: usize,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut cmd = Command::new("grep");
    cmd.arg("-rn");

    if ignore_case {
        cmd.arg("-i");
    }
    if literal {
        cmd.arg("-F");
    }
    if context_lines > 0 {
        cmd.arg("-C").arg(context_lines.to_string());
    }

    cmd.arg(pattern).arg(path);

    let output = run_search_command_capped(cmd).await?;

    // grep returns exit code 1 for "no matches"
    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("grep failed: {stderr}").into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty() && !result_line_has_excluded_dir(l))
        .take(limit)
        .map(|l| l.to_string())
        .collect();
    Ok(results)
}

fn result_line_has_excluded_dir(line: &str) -> bool {
    DEFAULT_EXCLUDED_DIRS.iter().any(|dir| {
        line.starts_with(&format!("{dir}/"))
            || line.starts_with(&format!("./{dir}/"))
            || line.contains(&format!("/{dir}/"))
    })
}

struct SearchCommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

async fn run_search_command_capped(
    mut cmd: Command,
) -> Result<SearchCommandOutput, Box<dyn std::error::Error + Send + Sync>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("search command stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("search command stderr was not piped"))?;

    let stdout_task = tokio::spawn(read_stream_capped(stdout, MAX_SEARCH_STREAM_BYTES));
    let stderr_task = tokio::spawn(read_stream_capped(stderr, MAX_SEARCH_STREAM_BYTES));
    let status = child.wait().await?;
    let stdout = stdout_task.await??.0;
    let stderr = stderr_task.await??.0;

    Ok(SearchCommandOutput {
        status,
        stdout,
        stderr,
    })
}

async fn read_stream_capped<R>(mut reader: R, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(max_bytes.min(8 * 1024));
    let mut chunk = [0u8; 8 * 1024];
    let mut truncated = false;

    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = max_bytes.saturating_sub(output.len());
        if remaining > 0 {
            let keep = remaining.min(read);
            output.extend_from_slice(&chunk[..keep]);
        }
        if read > remaining {
            truncated = true;
        }
    }

    Ok((output, truncated))
}

fn format_results(results: Vec<String>, limit: usize) -> KordiResult<ToolResult> {
    let total = results.len();
    let (text, truncated) = format_limited_results(&results, "No matches found.", limit);

    Ok(text_result(
        text,
        Some(json!({
            "matchCount": total,
            "truncated": truncated,
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_core::types::ContentBlock;
    use std::fs;

    fn test_context(cwd: &Path) -> ToolContext {
        ToolContext {
            cwd: cwd.to_path_buf(),
            artifacts_dir: cwd.join("artifacts"),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            session_observation: None,
            task_operator: None,
            schedule_task: None,
            execution_mode: crate::ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    fn text_content(result: &ToolResult) -> &str {
        let ContentBlock::Text { text } = &result.content[0] else {
            panic!("expected text result");
        };
        text
    }

    #[tokio::test]
    async fn search_stream_reader_keeps_only_the_configured_byte_budget() {
        let data = vec![b'x'; MAX_SEARCH_STREAM_BYTES + 1_024];
        let (output, truncated) = read_stream_capped(&data[..], 8 * 1024)
            .await
            .expect("stream should read");

        assert_eq!(output.len(), 8 * 1024);
        assert!(truncated);
    }

    #[tokio::test]
    async fn grep_skips_generated_logs_and_build_outputs_by_default() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        fs::create_dir_all(root.join(".multi-instance-logs/user3")).expect("logs dir");
        fs::create_dir_all(root.join("target/debug")).expect("target dir");
        fs::write(root.join("issue.md"), "issue 317 body\n").expect("issue file");
        fs::write(
            root.join(".multi-instance-logs/user3/dev-1486.log"),
            "building 317/490\n".repeat(500),
        )
        .expect("log file");
        fs::write(
            root.join("target/debug/build.log"),
            "issue 317 in target\n".repeat(500),
        )
        .expect("target file");

        let result = GrepTool
            .execute(
                json!({"pattern": "317|issue 317", "path": ".", "limit": 20}),
                &test_context(root),
                CancellationToken::new(),
            )
            .await
            .expect("grep should run");
        let text = text_content(&result);

        assert!(text.contains("issue.md"));
        assert!(!text.contains(".multi-instance-logs"));
        assert!(!text.contains("target/debug"));
    }
}
