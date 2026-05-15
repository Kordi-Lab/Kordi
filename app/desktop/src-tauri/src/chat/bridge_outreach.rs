use std::path::PathBuf;

use kordi_cli::desktop_runtime::DesktopRuntimeSession;

use super::chat_cwd;

fn sanitize_bridge_segment(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn bridge_agent_session_cwd(
    local_agent_node_id: &str,
    peer_node_id: &str,
) -> Result<PathBuf, String> {
    let root = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(chat_cwd()?);
    let dir = root
        .join("korde")
        .join("bridge-agent-sessions")
        .join(sanitize_bridge_segment(local_agent_node_id))
        .join(sanitize_bridge_segment(peer_node_id));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn normalize_mention_label(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn mention_text_starts_with_label(text: &str, label: &str) -> bool {
    let normalized_text = normalize_mention_label(text);
    let normalized_label = normalize_mention_label(label);
    if normalized_text.is_empty() || normalized_label.is_empty() {
        return false;
    }
    if normalized_text == normalized_label {
        return true;
    }
    let Some(rest) = normalized_text.strip_prefix(&normalized_label) else {
        return false;
    };
    rest.chars().next().is_none_or(|ch| {
        ch.is_whitespace() || matches!(ch, ':' | ';' | ',' | '.' | '!' | '?' | '—' | '-')
    })
}

fn local_agent_mention_labels(
    runtime: &DesktopRuntimeSession,
    cwd: &std::path::Path,
) -> Vec<String> {
    let profile = runtime.agent_profile();
    let mut labels = vec!["Kordi".to_string(), profile.label];
    if let Some(name) = std::path::Path::new(&profile.workspace_root)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        labels.push(name.to_string());
    }
    if let Some(name) = cwd
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        labels.push(name.to_string());
    }
    labels.sort_by_key(|label| normalize_mention_label(label));
    labels.dedup_by(|left, right| normalize_mention_label(left) == normalize_mention_label(right));
    labels
}

fn text_mentions_local_agent(text: &str, local_agent_labels: &[String]) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        let after_at = &text[index + 1..];
        local_agent_labels
            .iter()
            .any(|label| mention_text_starts_with_label(after_at, label))
    })
}

pub(super) async fn prepare_desktop_session_for_send(
    runtime: &mut DesktopRuntimeSession,
    cwd: PathBuf,
    user_text: &str,
) {
    let local_agent_labels = local_agent_mention_labels(runtime, &cwd);
    let local_session_context = if text_mentions_local_agent(user_text, &local_agent_labels) {
        if let Ok(task_records) =
            crate::canonical_sessions::local_agent_session_task_records(Some(runtime.session_id()))
        {
            let _ = runtime.sync_visible_task_records(&task_records);
        }
        crate::canonical_sessions::local_agent_session_prompt_context(Some(runtime.session_id()))
            .ok()
            .flatten()
    } else {
        None
    };
    runtime.set_bridge_outreach_prompt_context(local_session_context);
    runtime.set_reach_out_runtime(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_agent_mentions_are_detected_without_remote_outreach() {
        let labels = vec!["Kordi".to_string(), "issue-63-agent-outreach".to_string()];

        assert!(text_mentions_local_agent("@Kordi hi", &labels));
        assert!(text_mentions_local_agent(
            "@issue-63-agent-outreach hi",
            &labels
        ));
        assert!(!text_mentions_local_agent(
            "@Shenzhehere's Kordi hi",
            &labels
        ));
    }
}
