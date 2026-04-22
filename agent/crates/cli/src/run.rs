use anyhow::{Result, anyhow, bail};

use bb_core::agent::{self, DEFAULT_SYSTEM_PROMPT};
use bb_core::agent_session::{
    ImageContent, ModelRef, PrintTurnResult, PrintTurnStopReason, parse_model_arg,
};

use crate::agents_md::load_agents_md;
use bb_core::agent_session_runtime::{
    CreateAgentSessionRuntimeOptions, create_agent_session_runtime,
};
use bb_core::config;
use bb_core::settings::Settings;
use bb_provider::registry::ModelRegistry;
use bb_session::store;
use bb_tools::{ExecutionPolicy, ToolContext};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::Cli;
use crate::extensions::{
    ExtensionBootstrap, RuntimeExtensionSupport, auto_install_missing_packages,
    build_skill_system_prompt_section, load_runtime_extension_support,
};
use crate::login;
use crate::runtime_model::{build_runtime_config, resolve_or_synthesize_model};
use crate::tool_registry::{ToolRegistry, ToolSelection, ToolSelectionPreference};
use crate::turn_runner::{self, TurnConfig, TurnEvent, wrap_conn};
use crate::workspace_context::WorkspaceContext;
use bb_monitor::RequestMetricsTracker;

#[derive(Debug, Clone)]
struct PreparedPrintPrompt {
    text: String,
    images: Vec<ImageContent>,
}

pub async fn run_print_mode(cli: Cli) -> Result<()> {
    let cwd = std::fs::canonicalize(cli.cwd.as_deref().unwrap_or("."))?;
    let workspace_context = WorkspaceContext::from_env(cwd.clone());

    let global_dir = config::global_dir();
    std::fs::create_dir_all(&global_dir)?;
    let artifacts_dir = global_dir.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir)?;

    let conn = store::open_db(&global_dir.join("sessions.db"))?;
    let session_id = resolve_session_id(&conn, &cwd, &cli, &workspace_context)?;

    let settings = workspace_context.load_merged_settings();
    let execution_policy = ExecutionPolicy::from(settings.resolved_execution_mode());
    let startup_fallback = crate::login::preferred_startup_provider_and_model(&settings);
    let model_input = cli
        .model
        .as_deref()
        .or(startup_fallback.as_ref().map(|(_, model)| model.as_str()))
        .or(settings.default_model.as_deref());
    let provider_input = cli
        .provider
        .as_deref()
        .or(startup_fallback
            .as_ref()
            .map(|(provider, _)| provider.as_str()))
        .or(settings.default_provider.as_deref());
    let (provider_name, model_id, _thinking_override) =
        parse_model_arg(provider_input, model_input);

    let agents_md = (!workspace_context.is_remote())
        .then(|| load_agents_md(&cwd))
        .flatten();
    let base_prompt = cli
        .system_prompt
        .as_deref()
        .unwrap_or(DEFAULT_SYSTEM_PROMPT);
    let system_prompt = match &cli.append_system_prompt {
        Some(append) => agent::build_system_prompt(base_prompt, Some(append)),
        None => agent::build_system_prompt(base_prompt, agents_md.as_deref()),
    };

    let mut registry = ModelRegistry::new();
    registry.load_custom_models(&settings);
    login::add_cached_github_copilot_models(&mut registry);
    let model = resolve_or_synthesize_model(&registry, &provider_name, &model_id);

    let auth = if cli.api_key.is_some() {
        None
    } else {
        login::resolve_provider_auth(&provider_name)
    };
    let runtime = build_runtime_config(&model, auth.clone());
    let api_key = cli
        .api_key
        .clone()
        .unwrap_or_else(|| runtime.api_key.clone());
    let base_url = runtime.base_url.clone();
    let headers = runtime.headers.clone();

    if !workspace_context.disable_extensions() {
        auto_install_missing_packages(&cwd, &settings);
    }

    let extension_bootstrap = if workspace_context.disable_extensions() {
        ExtensionBootstrap::default()
    } else {
        ExtensionBootstrap::from_cli_values(&cwd, &cli.extensions)
    };
    let RuntimeExtensionSupport {
        session_resources,
        tools,
        mut commands,
    } = if workspace_context.disable_extensions() {
        RuntimeExtensionSupport::default()
    } else {
        load_runtime_extension_support(&cwd, &settings, &extension_bootstrap).await?
    };
    commands.bind_session_context(
        turn_runner::open_sibling_conn(&conn)?,
        session_id.clone(),
        None,
    );
    let _ = commands.send_event(&bb_hooks::Event::SessionStart).await;
    let tool_selection = tool_selection_from_cli_and_settings(&cli, &settings);
    let tool_registry = ToolRegistry::from_builtin_and_extensions(tools, tool_selection);
    let skill_section = build_skill_system_prompt_section(&session_resources);
    let environment_section = workspace_context.environment_prompt_section();
    let system_prompt = format!("{system_prompt}{environment_section}{skill_section}");

    let provider: Arc<dyn bb_provider::Provider> = runtime.provider.clone();

    let tool_ctx = ToolContext {
        cwd: cwd.clone(),
        artifacts_dir,
        execution_policy,
        on_output: None,
        web_search: Some(bb_tools::WebSearchRuntime {
            provider: provider.clone(),
            model: model.clone(),
            api_key: api_key.clone(),
            base_url: base_url.clone(),
            headers: headers.clone(),
            enabled: true,
        }),
        execution_mode: bb_tools::ToolExecutionMode::NonInteractive,
        request_approval: None,
        workspace_api_base_url: workspace_context.workspace_api_base_url_owned(),
    };

    let bootstrap = bb_core::agent_session_runtime::AgentSessionRuntimeBootstrap {
        cwd: Some(cwd.clone()),
        model: Some(ModelRef {
            provider: provider_name.clone(),
            id: model_id.clone(),
            reasoning: model.reasoning,
        }),
        resource_bootstrap: session_resources,
        ..Default::default()
    };
    let runtime_handle = create_agent_session_runtime(
        &bootstrap,
        CreateAgentSessionRuntimeOptions::new(cwd.clone()),
    );

    let mut prepared_messages = Vec::new();
    for raw in cli.messages {
        if commands.is_registered(&raw) {
            if let Some(output) = commands.execute_text(&raw).await? {
                println!("{output}");
            }
            continue;
        }

        let input = commands.apply_input_hooks(&raw, "interactive").await?;
        if input.handled {
            if let Some(output) = input.output {
                println!("{output}");
            }
            continue;
        }

        if let Some(text) = input.text {
            let expanded_text = runtime_handle.session().expand_input_text(text);
            let expanded =
                crate::input_files::expand_at_workspace_references(&expanded_text, &tool_ctx).await;
            for warning in expanded.warnings {
                eprintln!("Warning: {warning}");
            }
            prepared_messages.push(PreparedPrintPrompt {
                text: expanded.text,
                images: load_images_from_paths(&expanded.image_paths)?,
            });
        }
    }

    let initial_message = if prepared_messages.is_empty() {
        None
    } else {
        Some(prepared_messages.remove(0))
    };
    let follow_up_messages = prepared_messages;

    let turn_config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt,
        model,
        provider,
        auth,
        api_key,
        base_url,
        headers,
        compaction_settings: bb_core::types::CompactionSettings {
            enabled: settings.compaction.enabled,
            reserve_tokens: settings.compaction.reserve_tokens,
            keep_recent_tokens: settings.compaction.keep_recent_tokens,
        },
        tool_registry,
        tool_ctx,
        thinking: None,
        retry_enabled: settings.retry.enabled,
        retry_max_retries: settings.retry.max_retries,
        retry_base_delay_ms: settings.retry.base_delay_ms,
        retry_max_delay_ms: settings.retry.max_delay_ms,
        cancel: CancellationToken::new(),
        extensions: commands.clone(),
        request_metrics_tracker: Arc::new(tokio::sync::Mutex::new(RequestMetricsTracker::new())),
        request_metrics_log_path: Some(global_dir.join("request-metrics.jsonl")),
    };

    let mut last_result = None;
    if let Some(initial_message) = initial_message {
        last_result = Some(run_print_turn(&turn_config, initial_message).await?);
    }
    for message in follow_up_messages {
        last_result = Some(run_print_turn(&turn_config, message).await?);
    }

    let _ = commands.send_event(&bb_hooks::Event::SessionShutdown).await;
    if let Some(last_result) = last_result {
        if last_result.is_error() {
            return Err(anyhow!(last_result.error_message.clone().unwrap_or_else(
                || format!("request {:?}", last_result.stop_reason)
            )));
        }

        if !last_result.text.is_empty() {
            println!("{}", last_result.text);
        }
    }

    Ok(())
}

fn resolve_session_id(
    conn: &rusqlite::Connection,
    _cwd: &std::path::Path,
    cli: &Cli,
    workspace_context: &WorkspaceContext,
) -> Result<String> {
    let session_scope_key = workspace_context.session_scope_key();
    if let Some(session_arg) = &cli.session {
        let all = store::list_all_sessions(conn)?;
        let matches: Vec<_> = all
            .iter()
            .filter(|s| s.session_id.starts_with(session_arg.as_str()))
            .collect();
        return match matches.len() {
            1 => Ok(matches[0].session_id.clone()),
            0 => bail!("No session matching '{}'", session_arg),
            n => bail!("{n} sessions match '{}', be more specific", session_arg),
        };
    }
    if cli.r#continue {
        let sessions = store::list_sessions(conn, &session_scope_key)?;
        if let Some(s) = sessions.first() {
            tracing::info!("Continuing session {}", s.session_id);
            return Ok(s.session_id.clone());
        }
    }
    store::create_session(conn, &session_scope_key)
}

fn tool_selection_from_cli_and_settings(cli: &Cli, settings: &Settings) -> ToolSelection {
    let preference = if cli.no_tools {
        ToolSelectionPreference::None
    } else if let Some(tools) = &cli.tools {
        ToolSelectionPreference::Only(
            tools
                .split(',')
                .map(|name| name.trim())
                .filter(|name| !name.is_empty())
                .map(|name| name.to_string())
                .collect(),
        )
    } else {
        ToolSelectionPreference::UseSettings
    };

    preference.resolve(settings.tools.as_deref())
}

fn load_images_from_paths(paths: &[std::path::PathBuf]) -> Result<Vec<ImageContent>> {
    use base64::Engine;

    let mut images = Vec::new();
    for path in paths {
        let data = std::fs::read(path)
            .map_err(|error| anyhow!("Could not read image {}: {error}", path.display()))?;
        let Some(mime_type) = image_mime_type(path) else {
            continue;
        };
        images.push(ImageContent {
            source: base64::engine::general_purpose::STANDARD.encode(data),
            mime_type: Some(mime_type.to_string()),
        });
    }
    Ok(images)
}

fn image_mime_type(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

async fn run_print_turn(
    config: &TurnConfig,
    prompt: PreparedPrintPrompt,
) -> Result<PrintTurnResult> {
    if !prompt.images.is_empty() && !config.model.supports_images() {
        eprintln!(
            "Warning: model '{}' does not advertise image input support. Attached images may be ignored.",
            config.model.id
        );
    }
    turn_runner::append_user_message_with_images(
        &config.conn,
        &config.session_id,
        &prompt.text,
        &prompt.images,
    )
    .await?;

    let (event_tx, mut event_rx) = mpsc::unbounded_channel();

    // Run the turn loop directly (print mode is single-threaded, no need to spawn).
    turn_runner::run_turn_inner(config, &event_tx, &prompt.text).await?;
    drop(event_tx);

    // Drain remaining events
    let mut final_text = String::new();
    let mut error_message = None;
    while let Some(event) = event_rx.recv().await {
        match event {
            TurnEvent::Done { text } => {
                final_text = text;
            }
            TurnEvent::Error(msg) => {
                error_message = Some(msg);
            }
            _ => {}
        }
    }

    if let Some(err) = &error_message {
        Ok(PrintTurnResult {
            text: final_text,
            stop_reason: PrintTurnStopReason::Error,
            error_message: Some(err.clone()),
        })
    } else {
        Ok(PrintTurnResult {
            text: final_text,
            stop_reason: PrintTurnStopReason::Completed,
            error_message: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_cli() -> Cli {
        Cli {
            command: None,
            cwd: None,
            provider: None,
            model: None,
            api_key: None,
            system_prompt: None,
            append_system_prompt: None,
            system_prompt_template: None,
            list_templates: false,
            thinking: None,
            print: true,
            r#continue: false,
            resume: false,
            no_session: false,
            session: None,
            tools: None,
            no_tools: false,
            list_models: None,
            models: None,
            extensions: Vec::new(),
            verbose: false,
            messages: Vec::new(),
        }
    }

    #[test]
    fn resolve_session_id_matches_explicit_session_across_scopes() {
        let temp = tempdir().expect("tempdir");
        let conn = store::open_db(&temp.path().join("sessions.db")).expect("open db");
        let remote_session_id = store::create_session(&conn, "ssh:prod:/srv/prod/kordi")
            .expect("create remote session");

        let mut cli = test_cli();
        cli.session = Some(remote_session_id.chars().take(8).collect());

        let resolved = resolve_session_id(
            &conn,
            temp.path(),
            &cli,
            &WorkspaceContext::local(temp.path().to_path_buf()),
        )
        .expect("resolve session");

        assert_eq!(resolved, remote_session_id);
    }

    #[test]
    fn resolve_session_id_uses_workspace_scope_override_for_continue() {
        let temp = tempdir().expect("tempdir");
        let conn = store::open_db(&temp.path().join("sessions.db")).expect("open db");
        let remote_scope = "ssh:prod-kordi:/srv/prod/kordi";
        let remote_session_id =
            store::create_session(&conn, remote_scope).expect("create remote session");

        let mut cli = test_cli();
        cli.r#continue = true;

        let resolved = resolve_session_id(
            &conn,
            temp.path(),
            &cli,
            &WorkspaceContext::ssh(
                temp.path().to_path_buf(),
                remote_scope,
                "/srv/prod/kordi",
                Some("http://127.0.0.1:7080".to_string()),
            ),
        )
        .expect("resolve continued session");

        assert_eq!(resolved, remote_session_id);
    }

    #[test]
    fn remote_environment_prompt_section_mentions_relative_paths() {
        let context = WorkspaceContext::ssh(
            std::path::PathBuf::from("/tmp/kordi-launch"),
            "ssh:prod-kordi:/srv/prod/kordi",
            "/srv/prod/kordi",
            Some("http://127.0.0.1:7080".to_string()),
        );

        let section = context.environment_prompt_section();
        assert!(section.contains("Environment: SSH remote"));
        assert!(section.contains("Workspace root: /srv/prod/kordi"));
        assert!(section.contains("workspace-relative paths"));
        assert!(section.contains("workspace API"));
    }
}
