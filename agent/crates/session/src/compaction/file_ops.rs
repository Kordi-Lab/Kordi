use std::collections::HashSet;

use kordi_core::types::{AgentMessage, AssistantContent};

// =============================================================================
// File operation tracking
// =============================================================================

/// Extract read/modified files from messages by looking at tool calls.
pub fn extract_file_operations(messages: &[AgentMessage]) -> (Vec<String>, Vec<String>) {
    let mut read_files = HashSet::new();
    let mut modified_files = HashSet::new();

    for msg in messages {
        if let AgentMessage::Assistant(a) = msg {
            for block in &a.content {
                if let AssistantContent::ToolCall {
                    name, arguments, ..
                } = block
                {
                    match name.as_str() {
                        "read" => {
                            if let Some(path) = arguments
                                .get("path")
                                .and_then(|v| v.as_str())
                                .and_then(sanitize_file_operation_path)
                            {
                                read_files.insert(path);
                            }
                        }
                        "edit" | "write" => {
                            if let Some(path) = arguments
                                .get("path")
                                .and_then(|v| v.as_str())
                                .and_then(sanitize_file_operation_path)
                            {
                                modified_files.insert(path);
                            }
                        }
                        "bash" => {
                            if let Some(cmd) = arguments.get("command").and_then(|v| v.as_str()) {
                                extract_bash_file_ops(cmd, &mut modified_files);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let mut read_vec: Vec<String> = read_files.into_iter().collect();
    let mut mod_vec: Vec<String> = modified_files.into_iter().collect();
    read_vec.sort();
    mod_vec.sort();
    (read_vec, mod_vec)
}

/// Best-effort extraction of modified files from bash commands.
fn sanitize_file_operation_path(path: &str) -> Option<String> {
    let trimmed = path
        .trim()
        .trim_matches(|ch| matches!(ch, '\'' | '"' | '`'))
        .trim_end_matches([',', ';']);
    if trimmed.is_empty()
        || trimmed.len() > 4096
        || trimmed == "-"
        || trimmed.starts_with('&')
        || trimmed.starts_with('-')
        || trimmed.starts_with(',')
        || trimmed.contains("\n")
        || trimmed.contains("://")
        || trimmed
            .chars()
            .any(|ch| matches!(ch, '<' | '>' | '{' | '}' | '|' | '*' | '?' | '(' | ')'))
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn extract_bash_file_ops(cmd: &str, modified: &mut HashSet<String>) {
    // Detect redirect operators: > file, >> file
    for part in cmd.split_whitespace() {
        if part.starts_with('>') {
            let file = part.trim_start_matches('>');
            if let Some(file) = sanitize_file_operation_path(file) {
                modified.insert(file);
            }
        }
    }
    // Detect "> file" pattern (space after >)
    let chars: Vec<char> = cmd.chars().collect();
    for i in 0..chars.len() {
        if chars[i] == '>' && (i == 0 || chars[i - 1] != '>') {
            // Skip >> (already handled above for combined token)
            let rest = &cmd[i + 1..];
            let rest = rest.trim_start_matches('>');
            let rest = rest.trim_start();
            if let Some(file) = rest
                .split_whitespace()
                .next()
                .and_then(sanitize_file_operation_path)
            {
                modified.insert(file);
            }
        }
    }
    // Detect tee command
    if cmd.contains("tee ")
        && let Some(pos) = cmd.find("tee ")
    {
        let after = &cmd[pos + 4..];
        // Skip flags
        for token in after.split_whitespace() {
            if token.starts_with('-') {
                continue;
            }
            if let Some(path) = sanitize_file_operation_path(token) {
                modified.insert(path);
            }
            break;
        }
    }
}
