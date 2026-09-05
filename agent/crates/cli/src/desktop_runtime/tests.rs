use super::*;
use kordi_core::settings::ProviderOverride;
use std::sync::Mutex;

include!("tests/route_switch.rs");
include!("tests/background_sessions.rs");
include!("tests/persona.rs");
fn effective_thinking_for_model(requested: ThinkingLevel, model: &Model) -> ThinkingLevel {
    model_options::effective_thinking_for_model_with_auth(requested, model, None)
}

fn request_thinking_for_model(thinking_level: &str, model: &Model) -> Option<String> {
    model_options::request_thinking_for_model_with_auth(thinking_level, model, None)
}

fn env_lock() -> &'static Mutex<()> {
    crate::login::auth_test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set_value(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn unset(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        unsafe { std::env::remove_var(key) };
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

fn local_provider_settings(provider: &str, base_url: &str) -> Settings {
    Settings {
        providers: Some(vec![ProviderOverride {
            name: provider.to_string(),
            base_url: Some(base_url.to_string()),
            api_key_env: None,
            api: None,
            headers: None,
        }]),
        ..Settings::default()
    }
}

fn lm_studio_settings() -> Settings {
    local_provider_settings("lm-studio", "http://localhost:1234/v1")
}

#[test]
fn attachment_metadata_from_path_includes_size_local_path_and_mime_type() -> Result<()> {
    let path = std::env::temp_dir().join(format!(
        "kordi-attachment-test-{}.png",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, b"png-bytes")?;
    let metadata = attachment_metadata_from_path(path.to_str().expect("temp path is utf-8"));

    assert_eq!(metadata.kind, "image");
    assert_eq!(metadata.format_label.as_deref(), Some("PNG"));
    assert_eq!(metadata.mime_type.as_deref(), Some("image/png"));
    assert_eq!(metadata.local_path.as_deref(), path.to_str());
    assert_eq!(metadata.size_bytes, Some(9));

    std::fs::remove_file(path)?;
    Ok(())
}

#[test]
fn local_model_id_with_publisher_slash_stays_on_current_local_provider() -> Result<()> {
    let model = resolve_model_candidate(
        &lm_studio_settings(),
        "google/gemma-4-e4b",
        Some("lm-studio"),
    )?;

    assert_eq!(model.provider, "lm-studio");
    assert_eq!(model.id, "google/gemma-4-e4b");
    Ok(())
}

#[test]
fn ollama_model_selection_resolves_to_ollama_provider() -> Result<()> {
    let model = resolve_model_candidate(
        &local_provider_settings("ollama", "http://localhost:11434/v1"),
        "ollama/llama3.2:latest",
        Some("anthropic"),
    )?;

    assert_eq!(model.provider, "ollama");
    assert_eq!(model.id, "llama3.2:latest");
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn desktop_model_options_filter_openai_codex_oauth_models_and_do_not_readd_default()
-> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai_env = EnvVarGuard::unset("OPENAI_API_KEY");
    let _anthropic_env = EnvVarGuard::unset("ANTHROPIC_API_KEY");
    crate::login::save_oauth_credentials(
        "openai-codex",
        &crate::oauth::OAuthCredentials {
            access: "codex-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_test"}),
        },
    )?;
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-5".to_string()),
        ..Settings::default()
    }
    .save_project(cwd.path())?;
    clear_desktop_model_options_cache();

    let options = authenticated_model_options(cwd.path()).await;
    let values = options
        .iter()
        .map(|option| option.value.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        values
            .iter()
            .copied()
            .filter(|value| value.starts_with("openai/"))
            .collect::<Vec<_>>(),
        vec![
            "openai/gpt-6-astra",
            "openai/gpt-5.6-luna",
            "openai/gpt-5.6-sol",
            "openai/gpt-5.6-terra",
            "openai/gpt-5.5",
            "openai/gpt-5.4-mini",
            "openai/gpt-5.4",
            "openai/gpt-5.3-codex-spark",
        ]
    );

    assert!(values.contains(&"openai/gpt-5.5"));
    assert_eq!(
        options
            .iter()
            .find(|option| option.value == "openai/gpt-6-astra")
            .expect("GPT-6 OAuth option")
            .thinking_levels,
        ["low", "medium", "high", "xhigh", "max"]
    );
    assert!(!values.contains(&"openai/gpt-5"));
    assert!(!values.contains(&"openai/gpt-4o-mini"));
    Ok(())
}

#[test]
fn session_agent_auth_override_resolves_choice_without_changing_global_provider() {
    let _lock = env_lock().lock().unwrap();
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "env-openai-key");
    let choice = SessionAuthChoiceOverride {
        provider: "openai-codex".to_string(),
        choice: "env:api-key".to_string(),
    };

    let auth = resolve_auth_choice_override_for_model("openai", &choice)
        .expect("matching OpenAI route resolves explicit auth choice");

    assert_eq!(auth.credential, "env-openai-key");
    assert_eq!(auth.method, crate::login::ProviderAuthMethod::ApiKey);
    assert!(resolve_auth_choice_override_for_model("anthropic", &choice).is_none());
}

fn test_model(provider: &str, id: &str, reasoning: bool) -> Model {
    Model {
        id: id.to_string(),
        name: id.to_string(),
        provider: provider.to_string(),
        api: kordi_provider::registry::ApiType::OpenaiCompletions,
        context_window: 4096,
        max_tokens: 1024,
        reasoning,
        input: vec![kordi_provider::registry::ModelInput::Text],
        base_url: None,
        cost: kordi_provider::registry::CostConfig::default(),
    }
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn desktop_runtime_attaches_cloud_scheduled_task_runtime() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), "session-schedule-runtime")
            .await?;
    assert!(runtime.setup.tool_ctx.schedule_task.is_none());
    runtime.set_scheduled_tasks_cloud_runtime(
        "https://cloud.example/".to_string(),
        "session-token".to_string(),
    );
    assert!(runtime.setup.tool_ctx.schedule_task.is_some());
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn create_with_id_scopes_task_operator_to_requested_session_id() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let requested_session_id = "cloud-agent:acct_a:acct_b";
    let runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), requested_session_id)
            .await?;
    let task_operator = runtime
        .setup
        .tool_ctx
        .task_operator
        .clone()
        .expect("task operator runtime");

    let created = (task_operator.run)(
        kordi_tools::task_operator::models::TaskOperatorRuntimeRequest::Create(
            kordi_tools::task_operator::models::TaskCreateRequest {
                task_id: Some("task_cloud".to_string()),
                task_title: "Cloud Task".to_string(),
                summary: None,
                status: Some("open".to_string()),
                parent_task_id: None,
                involved_participants: Vec::new(),
            },
        ),
    )
    .await?;

    let created_task_id = created.tasks.first().expect("created task").path.as_str();
    let stored =
        kordi_session::tasks::get_task(&runtime.setup.conn, requested_session_id, created_task_id)?;
    assert!(
        stored.is_some(),
        "task_operator should use requested create_with_id session id"
    );
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn sync_visible_task_records_makes_active_cloud_tasks_closable_by_title() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let session_id = "cloud-agent:acct_a:session:group:g1";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    assert_eq!(
        runtime.sync_visible_task_records(&[DesktopVisibleTaskRecord {
            task_id: "another_test_task".to_string(),
            parent_task_id: None,
            title: "Another Test Task".to_string(),
            summary: Some("Shared Cloud task".to_string()),
            status: "active".to_string(),
            involved_participants: vec!["Research Agent".to_string(), "Alex Morgan".to_string()],
        }])?,
        1
    );

    let task_operator = runtime
        .setup
        .tool_ctx
        .task_operator
        .clone()
        .expect("task operator runtime");
    let closed = (task_operator.run)(
        kordi_tools::task_operator::models::TaskOperatorRuntimeRequest::Close(
            kordi_tools::task_operator::models::TaskCloseRequest {
                task_id: None,
                task_title: Some("Another Test Task".to_string()),
                query: None,
                target: None,
            },
        ),
    )
    .await?;

    assert_eq!(closed.target.as_deref(), Some("another_test_task"));
    assert_eq!(
        closed.tasks.first().map(|task| task.status.as_str()),
        Some("closed")
    );
    Ok(())
}

#[test]
fn non_reasoning_models_do_not_send_thinking_controls() {
    let model = test_model("ollama", "qwen:1.8b-chat", false);
    assert_eq!(desktop_thinking_levels_for_model(&model), vec!["off"]);
    assert_eq!(request_thinking_for_model("medium", &model), None);
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::Medium, &model),
        ThinkingLevel::Off
    );

    let reasoning_model = test_model("openai", "gpt-5", true);
    assert_eq!(
        desktop_thinking_levels_for_model(&reasoning_model),
        vec!["off", "minimal", "low", "medium", "high"]
    );
    assert_eq!(
        request_thinking_for_model("medium", &reasoning_model).as_deref(),
        Some("medium")
    );
    assert_eq!(
        request_thinking_for_model("off", &reasoning_model).as_deref(),
        Some("off")
    );
    assert_eq!(
        request_thinking_for_model("default", &reasoning_model),
        None
    );
}

#[test]
fn xhigh_is_exposed_only_for_supported_model_families() {
    let gpt = test_model("openai", "gpt-5.4", true);
    assert_eq!(
        desktop_thinking_levels_for_model(&gpt),
        vec!["off", "minimal", "low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::XHigh, &gpt),
        ThinkingLevel::XHigh
    );
    assert_eq!(
        request_thinking_for_model("Extra High", &gpt).as_deref(),
        Some("xhigh")
    );

    let standard = test_model("openai", "gpt-5.1-codex", true);
    assert_eq!(
        desktop_thinking_levels_for_model(&standard),
        vec!["off", "minimal", "low", "medium", "high"]
    );
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::XHigh, &standard),
        ThinkingLevel::High
    );

    let local = test_model("lm-studio", "gpt-oss-20b", true);
    assert_eq!(desktop_thinking_levels_for_model(&local), vec!["default"]);
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::XHigh, &local),
        ThinkingLevel::Default
    );
}

#[test]
fn openai_thinking_levels_follow_model_and_auth_route() {
    let gpt_56 = test_model("openai", "gpt-5.6-luna", true);
    for method in [
        login::ProviderAuthMethod::ApiKey,
        login::ProviderAuthMethod::OAuth,
    ] {
        assert_eq!(
            model_options::desktop_thinking_levels_for_model_with_auth(&gpt_56, Some(method)),
            vec!["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
    }

    let gpt_55 = test_model("openai", "gpt-5.5", true);
    assert_eq!(
        model_options::desktop_thinking_levels_for_model_with_auth(
            &gpt_55,
            Some(login::ProviderAuthMethod::ApiKey),
        ),
        vec!["off", "low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        model_options::desktop_thinking_levels_for_model_with_auth(
            &gpt_55,
            Some(login::ProviderAuthMethod::OAuth),
        ),
        vec!["off", "minimal", "low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        model_options::effective_thinking_for_model_with_auth(
            ThinkingLevel::Max,
            &gpt_55,
            Some(login::ProviderAuthMethod::OAuth),
        ),
        ThinkingLevel::XHigh
    );
}

#[test]
fn local_thinking_models_expose_only_documented_controls() {
    let qwen3 = test_model("ollama", "qwen3:30b", false);
    assert_eq!(desktop_thinking_levels_for_model(&qwen3), vec!["default"]);
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::High, &qwen3),
        ThinkingLevel::Default
    );
    assert_eq!(request_thinking_for_model("default", &qwen3), None);

    let gpt_oss = test_model("ollama", "gpt-oss:20b", false);
    assert_eq!(
        desktop_thinking_levels_for_model(&gpt_oss),
        vec!["low", "medium", "high"]
    );
    assert_eq!(
        effective_thinking_for_model(ThinkingLevel::Off, &gpt_oss),
        ThinkingLevel::Medium
    );
    assert_eq!(
        request_thinking_for_model("high", &gpt_oss).as_deref(),
        Some("high")
    );

    let lm_studio_r1 = test_model("lm-studio", "deepseek-r1-distill-qwen-7b", false);
    assert_eq!(
        desktop_thinking_levels_for_model(&lm_studio_r1),
        vec!["default"]
    );
    assert_eq!(request_thinking_for_model("default", &lm_studio_r1), None);

    let gemma = test_model("lm-studio", "google/gemma-4-e4b", false);
    assert_eq!(desktop_thinking_levels_for_model(&gemma), vec!["default"]);
    assert_eq!(request_thinking_for_model("off", &gemma), None);
}

#[test]
fn ollama_selection_is_not_absorbed_by_current_lm_studio_provider() -> Result<()> {
    let settings = Settings {
        providers: Some(vec![
            ProviderOverride {
                name: "lm-studio".to_string(),
                base_url: Some("http://localhost:1234/v1".to_string()),
                api_key_env: None,
                api: None,
                headers: None,
            },
            ProviderOverride {
                name: "ollama".to_string(),
                base_url: Some("http://localhost:11434/v1".to_string()),
                api_key_env: None,
                api: None,
                headers: None,
            },
        ]),
        ..Settings::default()
    };
    let model = resolve_model_candidate(&settings, "ollama/qwen:1.8b-chat", Some("lm-studio"))?;

    assert_eq!(model.provider, "ollama");
    assert_eq!(model.id, "qwen:1.8b-chat");
    Ok(())
}

#[test]
fn unconfigured_provider_prefix_is_not_synthesized_from_slash_model_id() {
    let settings = Settings::default();
    if login::provider_configured_for_settings(&settings, "google") {
        return;
    }

    let result = resolve_model_candidate(&settings, "google/gemma-4-e4b", None);

    assert!(result.is_err());
}
