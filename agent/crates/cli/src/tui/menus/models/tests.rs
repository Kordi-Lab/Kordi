use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kordi_core::agent_session::ThinkingLevel;
use kordi_core::agent_session_runtime::{AgentSessionRuntimeBootstrap, AgentSessionRuntimeHost};
use kordi_core::settings::{ModelOverride, Settings};
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::registry::{ApiType, CostConfig, Model, ModelInput};
use kordi_session::store;
use kordi_tools::{ExecutionPolicy, ToolContext, ToolExecutionMode};
use kordi_tui::tui::TuiCommand;
use tokio::sync::mpsc;

use crate::extensions::{ExtensionBootstrap, ExtensionCommandRegistry};
use crate::session_bootstrap::{SessionRuntimeSetup, SessionUiOptions};
use crate::tui::controller::TuiController;
use crate::tui::{MODEL_AUTH_MENU_ID, MODEL_PROVIDER_MENU_ID};

fn env_lock() -> &'static Mutex<()> {
    crate::login::auth_test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn set_value(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old {
            unsafe { std::env::set_var(self.key, value) };
        } else {
            unsafe { std::env::remove_var(self.key) };
        }
    }
}

fn test_model() -> Model {
    Model {
        id: "gpt-test".to_string(),
        name: "gpt-test".to_string(),
        provider: "openai".to_string(),
        api: ApiType::OpenaiCompletions,
        context_window: 128_000,
        max_tokens: 16_384,
        reasoning: false,
        input: vec![ModelInput::Text],
        base_url: None,
        cost: CostConfig::default(),
    }
}

fn build_test_controller(
    cwd: std::path::PathBuf,
) -> (TuiController, mpsc::UnboundedReceiver<TuiCommand>) {
    let conn = store::open_memory().expect("memory db");
    let model = test_model();
    let tool_ctx = ToolContext {
        cwd: cwd.clone(),
        artifacts_dir: cwd.join("artifacts"),
        model: None,
        execution_policy: ExecutionPolicy::Safety,
        invocation_id: None,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        mac_local: None,
        execution_mode: ToolExecutionMode::Interactive,
        request_approval: None,
    };
    let runtime_host = AgentSessionRuntimeHost::from_bootstrap(AgentSessionRuntimeBootstrap {
        cwd: Some(cwd),
        ..AgentSessionRuntimeBootstrap::default()
    });
    let options = SessionUiOptions {
        session_id: Some("seed-session".to_string()),
        ..SessionUiOptions::default()
    };
    let session_setup = SessionRuntimeSetup {
        conn,
        session_id: "seed-session".to_string(),
        provider: Arc::new(OpenAiProvider::new()),
        model,
        auth: None,
        ephemeral_auth: None,
        ephemeral_base_url: None,
        ephemeral_original_model_api: None,
        auth_choice_override: None,
        api_key: String::new(),
        base_url: "https://api.openai.com/v1".to_string(),
        headers: HashMap::new(),
        tool_registry: crate::tool_registry::ToolRegistry::default(),
        tool_selection: crate::tool_registry::ToolSelection::All,
        tool_ctx,
        system_prompt: String::new(),
        base_system_prompt: String::new(),
        thinking_level: "medium".to_string(),
        compaction_enabled: true,
        compaction_reserve_tokens: 8_000,
        compaction_keep_recent_tokens: 16_000,
        retry_enabled: true,
        retry_max_retries: 3,
        retry_base_delay_ms: 100,
        retry_max_delay_ms: 1_000,
        session_created: true,
        request_metrics_tracker: Arc::new(tokio::sync::Mutex::new(
            kordi_monitor::RequestMetricsTracker::new(),
        )),
        request_metrics_log_path: None,
        sibling_conn: None,
        extension_commands: ExtensionCommandRegistry::default(),
        extension_bootstrap: ExtensionBootstrap::default(),
        slash_command_items: Vec::new(),
    };
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (_approval_tx, approval_rx) = mpsc::unbounded_channel();
    let controller = TuiController::new(
        runtime_host,
        options,
        session_setup,
        command_tx,
        approval_rx,
    );
    (controller, command_rx)
}

fn drain_commands(rx: &mut mpsc::UnboundedReceiver<TuiCommand>) -> Vec<TuiCommand> {
    let mut commands = Vec::new();
    while let Ok(command) = rx.try_recv() {
        commands.push(command);
    }
    commands
}

fn temp_project() -> tempfile::TempDir {
    let tempdir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        tempdir.path().join("Cargo.toml"),
        "[package]\nname='demo'\n",
    )
    .expect("cargo toml");
    tempdir
}

#[test]
fn exact_model_match_with_multiple_auth_sources_prompts_for_auth_selection() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = temp_project();
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());
    let _auth_path = EnvVarGuard::set_path("KORDI_AUTH_PATH", &tempdir.path().join("auth"));
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-test-key");
    crate::login::save_oauth_credentials(
        "openai-codex",
        &crate::oauth::OAuthCredentials {
            access: "oauth-access".to_string(),
            refresh: "refresh-token".to_string(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_primary"}),
        },
    )
    .expect("save openai oauth");

    let (mut controller, mut command_rx) = build_test_controller(tempdir.path().to_path_buf());
    controller
        .handle_model_selection_command(Some("gpt-5.6-sol"))
        .expect("handle model selection");

    let commands = drain_commands(&mut command_rx);
    let menu = commands
        .into_iter()
        .find_map(|command| match command {
            TuiCommand::OpenSelectMenu {
                menu_id,
                title,
                items,
                ..
            } => Some((menu_id, title, items)),
            _ => None,
        })
        .expect("auth chooser menu");

    assert_eq!(menu.0, MODEL_AUTH_MENU_ID);
    assert_eq!(menu.1, "Select auth for OpenAI");
    assert_eq!(menu.2.len(), 2);
    assert_eq!(menu.2[0].label, "OAuth • acct_primary");
    assert!(
        menu.2[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("currently active") && detail.contains("saved "))
    );
    assert_eq!(menu.2[1].label, "API key (env)");
    assert!(menu.2[1].value.starts_with("env:api-key"));
}

#[test]
fn model_auth_menu_distinguishes_multiple_saved_api_keys() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = temp_project();
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());
    let _auth_path = EnvVarGuard::set_path("KORDI_AUTH_PATH", &tempdir.path().join("auth"));
    let _openrouter = EnvVarGuard::set_value("OPENROUTER_API_KEY", "");

    crate::login::save_api_key("openrouter", "key-1111".to_string()).expect("save first key");
    crate::login::save_api_key("openrouter", "key-2222".to_string()).expect("save second key");

    Settings {
        models: Some(vec![ModelOverride {
            id: "gpt-test".to_string(),
            name: Some("gpt-test".to_string()),
            provider: "openrouter".to_string(),
            api: Some("openai-completions".to_string()),
            base_url: Some("https://openrouter.ai/api/v1".to_string()),
            context_window: Some(128_000),
            max_tokens: Some(16_384),
            reasoning: Some(false),
            input: Some(vec!["text".to_string()]),
        }]),
        ..Settings::default()
    }
    .save_project(tempdir.path())
    .expect("save project settings");

    let (mut controller, mut command_rx) = build_test_controller(tempdir.path().to_path_buf());
    controller
        .handle_model_selection_command(Some("openrouter:gpt-test"))
        .expect("handle model selection");

    let commands = drain_commands(&mut command_rx);
    let menu = commands
        .into_iter()
        .find_map(|command| match command {
            TuiCommand::OpenSelectMenu {
                menu_id,
                title,
                items,
                ..
            } => Some((menu_id, title, items)),
            _ => None,
        })
        .expect("auth chooser menu");

    assert_eq!(menu.0, MODEL_AUTH_MENU_ID);
    assert_eq!(menu.1, "Select auth for OpenRouter");
    let key_2222 = menu
        .2
        .iter()
        .find(|item| item.label == "API key • ending in 2222")
        .expect("saved key 2222 option");
    let key_1111 = menu
        .2
        .iter()
        .find(|item| item.label == "API key • ending in 1111")
        .expect("saved key 1111 option");
    assert!(
        key_2222
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("profile "))
    );
    assert!(
        key_1111
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("profile "))
    );
}

#[test]
fn ambiguous_exact_model_match_prompts_for_provider_selection() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = temp_project();
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());
    let _auth_path = EnvVarGuard::set_path("KORDI_AUTH_PATH", &tempdir.path().join("auth"));
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-test-key");
    let _openrouter = EnvVarGuard::set_value("OPENROUTER_API_KEY", "");
    crate::login::save_api_key("openrouter", "openrouter-saved-key".to_string())
        .expect("save openrouter key");
    crate::login::save_oauth_credentials(
        "openai-codex",
        &crate::oauth::OAuthCredentials {
            access: "oauth-access".to_string(),
            refresh: "refresh-token".to_string(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_primary"}),
        },
    )
    .expect("save openai oauth");

    Settings {
        models: Some(vec![ModelOverride {
            id: "gpt-5.6-sol".to_string(),
            name: Some("gpt-5.6-sol".to_string()),
            provider: "openrouter".to_string(),
            api: Some("openai-completions".to_string()),
            base_url: Some("https://openrouter.ai/api/v1".to_string()),
            context_window: Some(128_000),
            max_tokens: Some(16_384),
            reasoning: Some(false),
            input: Some(vec!["text".to_string()]),
        }]),
        ..Settings::default()
    }
    .save_project(tempdir.path())
    .expect("save project settings");

    let (mut controller, mut command_rx) = build_test_controller(tempdir.path().to_path_buf());
    assert_eq!(
        controller.matching_model_providers("gpt-5.6-sol"),
        vec!["openai".to_string(), "openrouter".to_string()]
    );
    controller
        .handle_model_selection_command(Some("gpt-5.6-sol"))
        .expect("handle model selection");

    let commands = drain_commands(&mut command_rx);
    let menu = commands
        .into_iter()
        .find_map(|command| match command {
            TuiCommand::OpenSelectMenu {
                menu_id,
                title,
                items,
                ..
            } => Some((menu_id, title, items)),
            _ => None,
        })
        .expect("provider chooser menu");

    assert_eq!(menu.0, MODEL_PROVIDER_MENU_ID);
    assert_eq!(menu.1, "Select provider for 'gpt-5.6-sol'");
    assert_eq!(
        controller.pending_model_provider_search.as_deref(),
        Some("gpt-5.6-sol")
    );
    assert_eq!(
        menu.2
            .iter()
            .map(|item| item.value.as_str())
            .collect::<Vec<_>>(),
        vec!["openai", "openrouter"]
    );
    assert_eq!(
        menu.2
            .iter()
            .map(|item| item.label.as_str())
            .collect::<Vec<_>>(),
        vec!["OpenAI", "OpenRouter"]
    );
    assert!(
        menu.2[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("active: OAuth • acct_primary • saved "))
    );
    assert!(
        menu.2[1].detail.as_deref().is_some_and(|detail| {
            detail.contains("active: API key") && detail.contains("saved ")
        })
    );
}

#[test]
fn model_selection_clamps_thinking_for_non_openai_destinations() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let (mut controller, _command_rx) = build_test_controller(tempdir.path().to_path_buf());
    controller.session_setup.thinking_level = ThinkingLevel::Max.as_str().to_string();
    let mut anthropic = test_model();
    anthropic.id = "claude-sonnet-test".to_string();
    anthropic.name = anthropic.id.clone();
    anthropic.provider = "anthropic".to_string();
    anthropic.api = ApiType::AnthropicMessages;
    anthropic.reasoning = true;

    controller.apply_model_selection_with_auth(anthropic, None, None);

    assert_eq!(controller.session_setup.thinking_level, "high");
    assert_eq!(
        controller.runtime_host.session().thinking_level(),
        ThinkingLevel::High
    );
}
