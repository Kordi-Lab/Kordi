use anyhow::Result;
use chrono::{Local, TimeZone};
use kordi_core::agent_session::ThinkingLevel;
use kordi_monitor::{
    CacheMonitorTextInput, ContextResolutionInput, ContextWindowStatus, RequestCacheMetrics,
    SessionCacheMetricsSource, latest_request_metrics_for_session, render_cache_monitor_text,
    render_context_window_status, resolve_context_window_status,
};

use crate::login;
use crate::session_bootstrap::SessionRuntimeSetup;
use crate::session_info::collect_session_info_summary;

use super::{
    DesktopChatAgentProfile, DesktopChatContextWindowStatus, DesktopChatMessage,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopSessionArtifact,
    attachment_summary_from_metadata, desktop_thinking_levels_for_model, load_project_info,
    load_session_messages, repair_session_title_from_history, session_activity_label,
    session_title_from_messages, truncate_chars,
};

fn discover_workspace_root(cwd: &std::path::Path) -> std::path::PathBuf {
    let mut dir = cwd.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return cwd.to_path_buf();
        }
    }
}

fn repo_relative_display_path(root: &std::path::Path, path: &std::path::Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|relative| relative.display().to_string())
}

fn lesson_artifact_name(scope: &str) -> &'static str {
    match scope {
        "project" => "Project lessons",
        _ => "Session lessons",
    }
}

fn lesson_artifact_summary(scope: &str) -> &'static str {
    match scope {
        "project" => "Pinned project-scoped reflection lessons",
        _ => "Pinned conversation-scoped reflection lessons",
    }
}

fn scoped_lesson_artifact(
    artifacts_dir: &std::path::Path,
    scope: &str,
    scope_id: &str,
) -> Option<DesktopSessionArtifact> {
    let path =
        crate::reflection_runtime::reflection_lesson_artifact_path(artifacts_dir, scope, scope_id);
    if !path.exists() {
        return None;
    }
    let path_text = path.display().to_string();
    Some(DesktopSessionArtifact {
        id: path_text.clone(),
        path: path_text,
        name: lesson_artifact_name(scope).to_string(),
        kind: "document".to_string(),
        summary: lesson_artifact_summary(scope).to_string(),
        time_label: Some("Pinned".to_string()),
        pinned: true,
    })
}

fn reflection_lesson_artifacts_for_session(
    setup: &SessionRuntimeSetup,
    project_root: Option<&str>,
) -> Vec<DesktopSessionArtifact> {
    let mut artifacts = scoped_lesson_artifact(
        &setup.tool_ctx.artifacts_dir,
        "conversation",
        &setup.session_id,
    )
    .into_iter()
    .collect::<Vec<_>>();
    if let Some(project_root) = project_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(artifact) =
            scoped_lesson_artifact(&setup.tool_ctx.artifacts_dir, "project", project_root)
        {
            artifacts.push(artifact);
        }
    }
    artifacts
}

fn infer_agent_label(_cwd: &std::path::Path) -> String {
    // The desktop runtime's built-in local agent has a stable product identity.
    // Project names describe workspace grouping, not the agent itself; bridge
    // agents can still provide custom labels through bridge configuration.
    "Kordi".to_string()
}

fn collect_agent_identity_files(cwd: &std::path::Path) -> Vec<String> {
    let workspace_root = discover_workspace_root(cwd);
    let mut files = Vec::new();

    let project_settings = kordi_core::config::project_settings_path(cwd);
    if project_settings.exists() {
        if let Some(relative) = repo_relative_display_path(&workspace_root, &project_settings) {
            files.push(relative);
        }
    }

    let mut dir = cwd.to_path_buf();
    let mut scanned = Vec::new();
    loop {
        let agents = dir.join("AGENTS.md");
        if agents.exists() {
            scanned.push(agents);
        } else {
            let claude = dir.join("CLAUDE.md");
            if claude.exists() {
                scanned.push(claude);
            }
        }

        if dir == workspace_root {
            break;
        }
        if !dir.pop() {
            break;
        }
    }

    scanned.reverse();
    files.extend(
        scanned
            .into_iter()
            .filter_map(|path| repo_relative_display_path(&workspace_root, &path)),
    );
    files.dedup();
    files
}

pub(super) fn build_agent_profile_from_setup(
    setup: &SessionRuntimeSetup,
) -> DesktopChatAgentProfile {
    let loaded_skills = setup
        .slash_command_items
        .iter()
        .filter_map(|item| item.value.strip_prefix("/skill:").map(ToString::to_string))
        .collect::<Vec<_>>();
    let loaded_tools = setup
        .tool_registry
        .active_tools()
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();
    let loaded_plugins = setup
        .extension_bootstrap
        .package_sources
        .iter()
        .cloned()
        .chain(
            setup
                .extension_bootstrap
                .paths
                .iter()
                .map(|path| path.display().to_string()),
        )
        .collect::<Vec<_>>();

    DesktopChatAgentProfile {
        label: infer_agent_label(&setup.tool_ctx.cwd),
        system_prompt: setup.system_prompt.clone(),
        loaded_skills,
        loaded_tools,
        loaded_plugins,
        identity_files: collect_agent_identity_files(&setup.tool_ctx.cwd),
        default_provider: setup.model.provider.clone(),
        default_model: setup.model.id.clone(),
        workspace_root: setup.tool_ctx.cwd.display().to_string(),
        last_activities: vec![
            format!("Workspace: {}", setup.tool_ctx.cwd.display()),
            format!("Model: {}/{}", setup.model.provider, setup.model.id),
            format!("Thinking: {}", setup.thinking_level),
        ],
    }
}

pub(super) fn build_summary_from_setup(
    setup: &SessionRuntimeSetup,
) -> Result<DesktopChatSessionSummary> {
    let detail = build_detail_from_setup(setup)?;
    Ok(DesktopChatSessionSummary {
        id: detail.id,
        title: detail.title,
        subtitle: detail.subtitle,
        updated_at_label: detail.updated_at_label,
        message_count: detail.message_count,
        draft: detail.draft,
        forked_from_session_id: detail.forked_from_session_id.clone(),
        forked_from_message_id: detail.forked_from_message_id.clone(),
    })
}

pub(super) fn build_detail_from_setup(
    setup: &SessionRuntimeSetup,
) -> Result<DesktopChatSessionDetail> {
    let session_row = if setup.session_created {
        kordi_session::store::get_session(&setup.conn, &setup.session_id)?
    } else {
        None
    };
    let messages = if setup.session_created {
        load_session_messages(&setup.conn, &setup.session_id)?
    } else {
        Vec::new()
    };

    let title = if let Some(row) = session_row.as_ref() {
        repair_session_title_from_history(&setup.conn, row)?
            .or_else(|| session_title_from_messages(&messages))
            .unwrap_or_else(|| "New session".to_string())
    } else {
        "New session".to_string()
    };
    let subtitle = session_focus_subtitle(&messages).unwrap_or_default();
    let updated_at_label = session_row
        .as_ref()
        .map(|row| session_activity_label(&setup.conn, row))
        .unwrap_or_else(|| "Draft".to_string());

    let context_window_status = current_context_window_status(setup);
    let project_root = session_row
        .as_ref()
        .filter(|row| row.session_scope == "project")
        .and_then(|row| row.project_root.as_deref());
    let reflection_lesson_artifacts = reflection_lesson_artifacts_for_session(setup, project_root);
    let project = project_root
        .map(std::path::PathBuf::from)
        .as_deref()
        .and_then(load_project_info);

    let forked_from_session_id = session_row
        .as_ref()
        .and_then(|row| row.parent_session_id.clone());
    let forked_from_message_id = session_row
        .as_ref()
        .and_then(|row| row.parent_session_message_id.clone());

    Ok(DesktopChatSessionDetail {
        id: setup.session_id.clone(),
        title,
        subtitle,
        provider: setup.model.provider.clone(),
        provider_label: login::provider_display_name(&setup.model.provider).into_owned(),
        model: setup.model.id.clone(),
        model_label: setup.model.id.clone(),
        thinking: setup.thinking_level.clone(),
        thinking_label: thinking_label(&setup.thinking_level),
        thinking_levels: desktop_thinking_levels_for_model(&setup.model),
        updated_at_label,
        message_count: messages.len(),
        draft: !setup.session_created,
        cache_monitor_text: current_cache_monitor_text(setup),
        context_window_text: render_context_window_status(&context_window_status),
        context_window_status: DesktopChatContextWindowStatus {
            context_window: context_window_status.context_window,
            used_tokens: context_window_status.used_tokens,
            used_percent: context_window_status.used_percent,
            auto_compaction: context_window_status.auto_compaction,
            compaction_threshold_percent:
                kordi_session::compaction::AUTO_COMPACTION_THRESHOLD_PERCENT,
        },
        project,
        reflection_lesson_artifacts,
        messages,
        forked_from_session_id,
        forked_from_message_id,
    })
}

fn current_auth_cache_metrics_source(
    auth: Option<&crate::login::ResolvedProviderAuth>,
) -> Option<SessionCacheMetricsSource> {
    auth.map(|auth| match auth.method {
        crate::login::ProviderAuthMethod::OAuth => SessionCacheMetricsSource::Estimated,
        crate::login::ProviderAuthMethod::ApiKey => SessionCacheMetricsSource::Official,
    })
}

fn request_matches_cache_domain(
    metrics: &RequestCacheMetrics,
    provider: &str,
    model: &str,
    current_context_epoch: Option<u64>,
) -> bool {
    metrics.provider == provider
        && metrics.model == model
        && current_context_epoch.is_none_or(|epoch| metrics.context_epoch == epoch)
}

fn active_path_has_contextful_entries(path: &[kordi_session::store::EntryRow]) -> bool {
    path.iter().any(|row| row.entry_type == "message")
}

fn estimate_active_path_context_tokens(path: &[kordi_session::store::EntryRow]) -> Option<u64> {
    let latest_compaction_index = path.iter().rposition(|row| row.entry_type == "compaction");
    if let Some(compaction_index) = latest_compaction_index {
        let has_post_compaction_usage = path.iter().skip(compaction_index + 1).rev().any(|row| {
            let Ok(entry) = kordi_session::store::parse_entry(row) else {
                return false;
            };
            match entry {
                kordi_core::types::SessionEntry::Message {
                    message: kordi_core::types::AgentMessage::Assistant(assistant),
                    ..
                } => {
                    assistant.stop_reason != kordi_core::types::StopReason::Aborted
                        && assistant.stop_reason != kordi_core::types::StopReason::Error
                        && kordi_session::compaction::calculate_context_tokens(&assistant.usage) > 0
                }
                _ => false,
            }
        });
        if !has_post_compaction_usage {
            return None;
        }
    }

    kordi_session::context::build_context_from_path(path)
        .ok()
        .map(|ctx| kordi_session::compaction::estimate_context_tokens(&ctx.messages).tokens)
}

fn current_cache_monitor_text(setup: &SessionRuntimeSetup) -> Option<String> {
    let summary = collect_session_info_summary(
        &setup.conn,
        &setup.session_id,
        &setup.model.provider,
        &setup.model.id,
        &setup.thinking_level,
        setup.tool_ctx.execution_policy,
        setup.auth.as_ref(),
    )
    .ok()?;

    let latest_request = setup.request_metrics_log_path.as_ref().and_then(|path| {
        latest_request_metrics_for_session(path, &setup.session_id)
            .ok()
            .flatten()
    });
    let current_context_epoch = setup
        .request_metrics_tracker
        .try_lock()
        .ok()
        .map(|tracker| tracker.state().context_epoch);
    let latest_matches_current_cache_domain = latest_request.as_ref().is_some_and(|metrics| {
        request_matches_cache_domain(
            metrics,
            &setup.model.provider,
            &setup.model.id,
            current_context_epoch,
        )
    });
    let source = if latest_matches_current_cache_domain {
        latest_request.as_ref().map(|metrics| {
            SessionCacheMetricsSource::from_cache_metrics_source(Some(
                &metrics.cache_metrics_source,
            ))
        })
    } else {
        current_auth_cache_metrics_source(setup.auth.as_ref())
            .or(summary.cache_metrics_source.clone())
    };
    let latest_hit_rate_pct = if latest_matches_current_cache_domain {
        latest_request
            .as_ref()
            .and_then(|metrics| metrics.cache_read_hit_rate_pct)
    } else if latest_request.is_some() {
        Some(0.0)
    } else {
        None
    };

    render_cache_monitor_text(&CacheMonitorTextInput {
        source,
        average_hit_rate_pct: summary.cache_read_hit_rate_pct,
        latest_hit_rate_pct,
        has_cache_activity: summary.cache_read_tokens > 0
            || summary.cache_write_tokens > 0
            || summary.input_tokens > 0,
    })
}

fn current_context_window_status(setup: &SessionRuntimeSetup) -> ContextWindowStatus {
    let active_path = kordi_session::tree::active_path(&setup.conn, &setup.session_id).ok();
    let latest_entry_is_compaction = active_path
        .as_ref()
        .and_then(|rows| rows.last())
        .is_some_and(|row| row.entry_type == "compaction");
    let suppress_runtime_usage = latest_entry_is_compaction;
    let context_window = setup.model.context_window;
    let active_path_tokens = if suppress_runtime_usage {
        None
    } else {
        active_path
            .as_deref()
            .and_then(estimate_active_path_context_tokens)
    };

    resolve_context_window_status(&ContextResolutionInput {
        runtime_usage: None,
        active_path_tokens,
        has_contextful_active_path: active_path
            .as_deref()
            .is_some_and(active_path_has_contextful_entries),
        context_window,
        auto_compaction: setup.compaction_enabled,
        suppress_runtime_usage,
    })
}

fn session_focus_subtitle(messages: &[DesktopChatMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .or_else(|| {
            messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant")
        })
        .and_then(|message| {
            let text = message.text.replace('\n', " ").trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
            attachment_summary_from_metadata(&message.attachments)
        })
        .map(|value| truncate_chars(&value, 96))
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn thinking_label(value: &str) -> String {
    match ThinkingLevel::parse(value) {
        Some(ThinkingLevel::Off) => "Off".to_string(),
        Some(ThinkingLevel::Default) => "Default".to_string(),
        Some(ThinkingLevel::Minimal) => "Minimal".to_string(),
        Some(ThinkingLevel::Low) => "Low".to_string(),
        Some(ThinkingLevel::Medium) => "Medium".to_string(),
        Some(ThinkingLevel::High) => "High".to_string(),
        Some(ThinkingLevel::XHigh) => "Extra High".to_string(),
        None => value.to_string(),
    }
}

pub(crate) fn format_message_timestamp(timestamp_ms: i64) -> String {
    format_utc_timestamp(timestamp_ms)
}

pub(crate) fn format_utc_timestamp(timestamp_ms: i64) -> String {
    let local = Local.timestamp_millis_opt(timestamp_ms).single();
    match local {
        Some(datetime) => datetime.format("%H:%M").to_string(),
        None => "--:--".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_label_formats_xhigh() {
        assert_eq!(thinking_label("xhigh"), "Extra High");
    }

    #[test]
    fn local_desktop_agent_label_is_not_inferred_from_project_name() {
        assert_eq!(
            infer_agent_label(std::path::Path::new("/tmp/any-project")),
            "Kordi"
        );
    }
}
