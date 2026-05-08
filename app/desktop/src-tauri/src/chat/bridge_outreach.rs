use std::{path::PathBuf, sync::Arc};

use kordi_cli::desktop_runtime::DesktopRuntimeSession;
use kordi_core::error::KordiError;
use kordi_tools::ReachOutRuntime;

use crate::bridge::{
    desktop_bridge_outreach_prompt_context, desktop_bridge_reach_out_impl, DesktopBridgeManager,
};

use super::{chat_cwd, DesktopChatManager};

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

fn text_explicitly_mentions_label(text: &str, label: &str) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        mention_text_starts_with_label(&text[index + 1..], label)
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

fn text_mentions_non_local_target(text: &str, local_agent_labels: &[String]) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        let after_at = &text[index + 1..];
        if after_at.trim().is_empty() {
            return false;
        }
        !local_agent_labels
            .iter()
            .any(|label| mention_text_starts_with_label(after_at, label))
    })
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

fn reach_out_target_allowed_by_user_text(
    user_text: &str,
    target: &str,
    local_agent_labels: &[String],
) -> bool {
    let target = target.trim();
    if target.is_empty() {
        return false;
    }
    if local_agent_labels
        .iter()
        .any(|label| normalize_mention_label(label) == normalize_mention_label(target))
    {
        return false;
    }
    text_explicitly_mentions_label(user_text, target)
}

pub(super) async fn prepare_desktop_session_for_send(
    runtime: &mut DesktopRuntimeSession,
    bridge_manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
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
    if text_mentions_non_local_target(user_text, &local_agent_labels) {
        let prompt_context = desktop_bridge_outreach_prompt_context(&bridge_manager).await;
        runtime.set_bridge_outreach_prompt_context(match (local_session_context, prompt_context) {
            (Some(local_context), Some(bridge_context)) => {
                Some(format!("{local_context}\n\n{bridge_context}"))
            }
            (Some(local_context), None) => Some(local_context),
            (None, bridge_context) => bridge_context,
        });
        install_reach_out_runtime(
            runtime,
            bridge_manager,
            chat_manager,
            cwd,
            user_text.to_string(),
            local_agent_labels,
        );
    } else {
        runtime.set_bridge_outreach_prompt_context(local_session_context);
        runtime.set_reach_out_runtime(None);
    }
}

fn install_reach_out_runtime(
    runtime: &mut DesktopRuntimeSession,
    bridge_manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
    cwd: PathBuf,
    user_text: String,
    local_agent_labels: Vec<String>,
) {
    let parent_session_id = runtime.session_id().to_string();
    runtime.set_reach_out_runtime(Some(ReachOutRuntime {
        reach_out: Arc::new(move |mut request| {
            let bridge_manager = bridge_manager.clone();
            let chat_manager = chat_manager.clone();
            let cwd = cwd.clone();
            let parent_session_id = parent_session_id.clone();
            let user_text = user_text.clone();
            let local_agent_labels = local_agent_labels.clone();
            Box::pin(async move {
                if !reach_out_target_allowed_by_user_text(
                    &user_text,
                    &request.target,
                    &local_agent_labels,
                ) {
                    return Err(KordiError::Tool(
                        "reach_out is only for explicit non-local @Person/@Agent mentions in the current user message; @Kordi addresses the local agent."
                            .to_string(),
                    ));
                }
                if request.parent_session_id.is_none() {
                    request.parent_session_id = Some(parent_session_id);
                }
                if request.project_name.is_none() {
                    request.project_name = kordi_core::settings::Settings::load_project(&cwd)
                        .project_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                        .or_else(|| {
                            cwd.file_name()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string)
                        });
                }
                desktop_bridge_reach_out_impl(&bridge_manager, &chat_manager, request)
                    .await
                    .map_err(KordiError::Tool)
            })
        }),
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_agent_mentions_do_not_enable_bridge_outreach() {
        let labels = vec!["Kordi".to_string(), "issue-63-agent-outreach".to_string()];

        assert!(!text_mentions_non_local_target("@Kordi hi", &labels));
        assert!(!text_mentions_non_local_target(
            "@issue-63-agent-outreach hi",
            &labels
        ));
        assert!(text_mentions_non_local_target(
            "@Shenzhehere's Kordi hi",
            &labels
        ));
    }

    #[test]
    fn reach_out_requires_current_explicit_non_local_target() {
        let labels = vec!["Kordi".to_string(), "issue-63-agent-outreach".to_string()];

        assert!(!reach_out_target_allowed_by_user_text(
            "@Kordi hi",
            "Kordi",
            &labels
        ));
        assert!(!reach_out_target_allowed_by_user_text(
            "@Kordi hi",
            "Shenzhehere's Kordi",
            &labels
        ));
        assert!(reach_out_target_allowed_by_user_text(
            "@Shenzhehere's Kordi hi",
            "Shenzhehere's Kordi",
            &labels
        ));
    }

    #[test]
    fn hidden_or_unmentioned_reach_out_targets_are_denied() {
        let labels = vec!["Kordi".to_string(), "Alice's Kordi".to_string()];

        assert!(!reach_out_target_allowed_by_user_text(
            "Can someone review this?",
            "Bob's Kordi",
            &labels,
        ));
        assert!(!reach_out_target_allowed_by_user_text(
            "@Bob's Kordi can you review this?",
            "Charlie's Kordi",
            &labels,
        ));
        assert!(!reach_out_target_allowed_by_user_text(
            "@Kordi please ask Bob's Kordi",
            "Bob's Kordi",
            &labels,
        ));
        assert!(reach_out_target_allowed_by_user_text(
            "@Bob's Kordi can you review this?",
            "Bob's Kordi",
            &labels,
        ));
    }
}
