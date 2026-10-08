use kordi_core::agent_session_runtime::{AgentSessionRuntimeBootstrap, AgentSessionRuntimeHost};
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::registry::{ApiType, CostConfig, Model, ModelInput};
use kordi_session::store;
use kordi_tools::{ExecutionPolicy, ToolContext, ToolExecutionMode};
use kordi_tui::tui::TuiCommand;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::extensions::{ExtensionBootstrap, ExtensionCommandRegistry};
use crate::session_bootstrap::{SessionRuntimeSetup, SessionUiOptions};
use crate::tui::controller::TuiController;
use crate::tui::{LOGIN_AUTH_OPTION_MENU_ID, LOGIN_METHOD_MENU_ID};

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

fn build_test_controller(
    cwd: std::path::PathBuf,
) -> (TuiController, mpsc::UnboundedReceiver<TuiCommand>) {
    let conn = store::open_memory().expect("memory db");
    let model = Model {
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
    };
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
        execution_mode: ToolExecutionMode::Interactive,
        connector_tools: None,
        request_approval: None,
    };
    let runtime_host = AgentSessionRuntimeHost::from_bootstrap(AgentSessionRuntimeBootstrap {
        cwd: Some(cwd),
        ..AgentSessionRuntimeBootstrap::default()
    });
    let options = SessionUiOptions::default();
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

#[test]
fn openai_login_method_detail_reports_multiple_saved_options() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = tempfile::tempdir().expect("tempdir");
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-env-key");
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
    controller.open_login_method_menu("openai");
    let commands = drain_commands(&mut command_rx);
    let menu = commands
        .into_iter()
        .find_map(|command| match command {
            TuiCommand::OpenSelectMenu { menu_id, items, .. } => Some((menu_id, items)),
            _ => None,
        })
        .expect("login method menu");

    assert_eq!(menu.0, LOGIN_METHOD_MENU_ID);
    let oauth = menu
        .1
        .iter()
        .find(|item| item.value == "oauth:openai-codex")
        .expect("oauth item");
    let api_key = menu
        .1
        .iter()
        .find(|item| item.value == "api_key:openai")
        .expect("api key item");
    assert!(
        oauth
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("1 option"))
    );
    assert!(
        api_key
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("1 option"))
    );
}

#[test]
fn openai_login_method_opens_auth_option_menu_when_options_exist() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = tempfile::tempdir().expect("tempdir");
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "openai-env-key");
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
    assert!(
        controller
            .maybe_open_login_auth_option_menu("openai", crate::login::ProviderAuthMethod::OAuth,)
    );

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
        .expect("auth option menu");

    assert_eq!(menu.0, LOGIN_AUTH_OPTION_MENU_ID);
    assert_eq!(menu.1, "Use OpenAI OAuth");
    assert!(
        menu.2
            .iter()
            .any(|item| item.label == "OAuth • acct_primary")
    );
    assert!(
        menu.2
            .iter()
            .any(|item| item.label == "Sign in another account")
    );
}

#[test]
fn login_auth_option_menu_distinguishes_multiple_saved_api_keys() {
    let _lock = env_lock().lock().unwrap();
    let tempdir = tempfile::tempdir().expect("tempdir");
    let _home = EnvVarGuard::set_path("HOME", tempdir.path());

    crate::login::save_api_key("openrouter", "key-1111".to_string()).expect("save first");
    crate::login::save_api_key("openrouter", "key-2222".to_string()).expect("save second");

    let (mut controller, mut command_rx) = build_test_controller(tempdir.path().to_path_buf());
    assert!(
        controller.maybe_open_login_auth_option_menu(
            "openrouter",
            crate::login::ProviderAuthMethod::ApiKey,
        )
    );

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
        .expect("auth option menu");

    assert_eq!(menu.0, LOGIN_AUTH_OPTION_MENU_ID);
    assert_eq!(menu.1, "Use OpenRouter API key");
    let key_2222 = menu
        .2
        .iter()
        .find(|item| item.label == "Saved API key • ending in 2222")
        .expect("saved key 2222 option");
    let key_1111 = menu
        .2
        .iter()
        .find(|item| item.label == "Saved API key • ending in 1111")
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
    assert!(
        menu.2
            .iter()
            .any(|item| item.label == "Paste a new API key")
    );
}
