use super::*;
use kordi_core::settings::ProviderOverride;
use std::sync::Mutex;

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

#[test]
fn bridge_agent_auth_override_resolves_choice_without_changing_global_provider() {
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
