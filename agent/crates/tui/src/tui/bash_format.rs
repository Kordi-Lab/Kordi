use kordi_core::types::ContentBlock;

use crate::ui_hints::{
    NO_TEXT_OUTPUT, TOOL_COLLAPSE_HINT, TOOL_EXPAND_HINT, TOOL_FAILED_NO_TEXT_OUTPUT,
    image_placeholder,
};

use super::{projection::wrap_visual_preview_lines, tool_format::shorten_display_path};

const LIVE_BASH_PREVIEW_VISUAL_LINES: usize = 5;

fn format_bash_footer(
    label: &str,
    elapsed: Option<&str>,
    hidden_visual_lines: usize,
    expanded: bool,
) -> String {
    let mut parts = vec![format!("{label} {}", elapsed.unwrap_or("0ms"))];
    if hidden_visual_lines > 0 {
        parts.push(format!("{hidden_visual_lines} earlier lines hidden"));
    }
    parts.push(if expanded {
        TOOL_COLLAPSE_HINT.to_string()
    } else {
        TOOL_EXPAND_HINT.to_string()
    });
    parts.join(" • ")
}

fn bash_text_output(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.clone(),
            ContentBlock::Image { mime_type, .. } => image_placeholder(mime_type),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn bash_status_lines(details: Option<&serde_json::Value>) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(details) = details {
        let exit = details.get("exitCode").and_then(|value| value.as_i64());
        let truncated = details
            .get("truncated")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let cancelled = details
            .get("cancelled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let mut flags = Vec::new();
        if truncated {
            flags.push("truncated");
        }
        if cancelled {
            flags.push("cancelled");
        }
        match exit {
            Some(exit) if exit != 0 || !flags.is_empty() => {
                let suffix = if flags.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", flags.join(", "))
                };
                lines.push(format!("exit code: {exit}{suffix}"));
            }
            None if !flags.is_empty() => lines.push(format!("status: {}", flags.join(", "))),
            _ => {}
        }
    }
    lines
}

pub(super) struct BashVisualResult<'a> {
    pub label: &'a str,
    pub content: &'a [ContentBlock],
    pub details: Option<&'a serde_json::Value>,
    pub artifact_path: Option<&'a str>,
    pub is_error: bool,
    pub expanded: bool,
    pub total_width: usize,
    pub elapsed: Option<&'a str>,
}

pub(super) fn format_bash_visual_result_content(result: BashVisualResult<'_>) -> String {
    let available_width = result.total_width.saturating_sub(2).max(1);
    let mut out = bash_status_lines(result.details);
    let text = bash_text_output(result.content).replace('\t', "   ");

    if !text.trim().is_empty() {
        let visual_lines = wrap_visual_preview_lines(&text, available_width);
        let hidden_visual_lines = if result.expanded {
            0
        } else {
            visual_lines
                .len()
                .saturating_sub(LIVE_BASH_PREVIEW_VISUAL_LINES)
        };
        let visible_lines = if result.expanded {
            visual_lines
        } else {
            visual_lines
                .into_iter()
                .skip(hidden_visual_lines)
                .collect::<Vec<_>>()
        };
        if !out.is_empty() && !visible_lines.is_empty() {
            out.push(String::new());
        }
        out.extend(visible_lines);
        out.push(format_bash_footer(
            result.label,
            result.elapsed,
            hidden_visual_lines,
            result.expanded,
        ));
    } else if out.is_empty() {
        out.push(if result.is_error {
            TOOL_FAILED_NO_TEXT_OUTPUT.to_string()
        } else {
            NO_TEXT_OUTPUT.to_string()
        });
    } else {
        out.push(format_bash_footer(
            result.label,
            result.elapsed,
            0,
            result.expanded,
        ));
    }

    if let Some(path) = result.artifact_path {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(format!("artifact: {}", shorten_display_path(path)));
    }

    out.join("\n")
}

pub(super) fn format_live_bash_result_content(
    live_output: &str,
    expanded: bool,
    total_width: usize,
    elapsed: Option<&str>,
) -> String {
    format_bash_visual_result_content(BashVisualResult {
        label: "Elapsed",
        content: &[ContentBlock::Text {
            text: live_output.to_string(),
        }],
        details: None,
        artifact_path: None,
        is_error: false,
        expanded,
        total_width,
        elapsed,
    })
}
