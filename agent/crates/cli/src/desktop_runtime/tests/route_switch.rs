#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn message_route_switches_an_anthropic_runtime_to_openai_oauth() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _anthropic = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "test-anthropic-key");
    let _openai = EnvVarGuard::unset("OPENAI_API_KEY");
    crate::login::save_oauth_credentials(
        "openai-codex",
        &crate::oauth::OAuthCredentials {
            access: "test-codex-access".to_string(),
            refresh: String::new(),
            expires: i64::MAX,
            extra: serde_json::json!({"accountId": "acct_route_test"}),
        },
    )?;
    Settings {
        default_provider: Some("anthropic".to_string()),
        default_model: Some("claude-haiku-4-5-20251001".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let mut runtime = DesktopRuntimeSession::create_with_id(
        cwd.path().to_path_buf(),
        "session:self-agent:route-switch",
    )
    .await?;
    assert_runtime_request_model_context(&mut runtime, "claude-haiku-4-5-20251001", "anthropic")
        .await?;
    runtime.set_model("openai/gpt-6-astra")?;
    runtime.set_auth_choice("openai-codex", "local-active-oauth")?;
    runtime.set_thinking("max")?;

    let detail = runtime.detail()?;
    assert_eq!(detail.provider, "openai");
    assert_eq!(detail.model, "gpt-6-astra");
    assert_eq!(detail.thinking, "max");
    let auth_choice = runtime
        .setup
        .auth_choice_override
        .as_ref()
        .expect("message route keeps the selected auth profile");
    assert_eq!(auth_choice.provider, "openai-codex");
    assert_eq!(auth_choice.choice, "local-active-oauth");
    assert_eq!(
        runtime.setup.auth.as_ref().map(|auth| auth.method),
        Some(crate::login::ProviderAuthMethod::OAuth)
    );
    assert_runtime_request_model_context(&mut runtime, "gpt-6-astra", "openai").await?;
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn explicit_config_on_new_canonical_runtime_survives_restart() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-5.6-sol".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let session_id = "session:self-agent:canonical-runtime";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    let _anthropic = EnvVarGuard::set_value("ANTHROPIC_API_KEY", "test-anthropic-key");
    for (provider, model, thinking, expected_thinking) in [
        ("openai", "gpt-5.6-luna", "max", "max"),
        ("openai", "gpt-6-astra", "max", "max"),
        ("openai", "gpt-6-astra", "off", "low"),
        ("anthropic", "claude-fable-5-1", "xhigh", "xhigh"),
    ] {
        runtime.set_explicit_config(Some(&format!("{provider}/{model}")), Some(thinking))?;
        drop(runtime);
        runtime = DesktopRuntimeSession::resume(cwd.path().to_path_buf(), session_id).await?;
        let detail = runtime.detail()?;
        assert_eq!(detail.provider, provider);
        assert_eq!(detail.model, model);
        assert_eq!(detail.thinking, expected_thinking);
        assert_runtime_request_model_context(&mut runtime, model, provider).await?;
    }
    Ok(())
}

#[derive(Default)]
struct ModelContextCapture {
    requests: Mutex<Vec<kordi_provider::CompletionRequest>>,
}

#[async_trait::async_trait]
impl kordi_provider::Provider for ModelContextCapture {
    fn name(&self) -> &str {
        "model-context-capture"
    }

    async fn stream(
        &self,
        request: kordi_provider::CompletionRequest,
        _options: kordi_provider::RequestOptions,
        tx: tokio::sync::mpsc::UnboundedSender<kordi_provider::StreamEvent>,
    ) -> kordi_core::error::KordiResult<()> {
        self.requests.lock().unwrap().push(request);
        let _ = tx.send(kordi_provider::StreamEvent::TextDelta {
            text: "done".into(),
        });
        let _ = tx.send(kordi_provider::StreamEvent::Done);
        Ok(())
    }
}

async fn assert_runtime_request_model_context(
    runtime: &mut DesktopRuntimeSession,
    model: &str,
    provider: &str,
) -> Result<()> {
    ensure_session_row_created(&mut runtime.setup)?;
    let base_prompt = runtime.setup.system_prompt.clone();
    let workspace = runtime.setup.tool_ctx.cwd.clone();
    let mut config = super::turn_execution::build_turn_config(
        &mut runtime.setup,
        tokio_util::sync::CancellationToken::new(),
        kordi_tools::ExecutionPolicy::Safety,
        false,
        workspace,
    )?;
    let capture = std::sync::Arc::new(ModelContextCapture::default());
    config.provider = capture.clone();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (config, result) = crate::turn_runner::run_turn(config, tx, "hello".into()).await;
    runtime.setup.tool_registry = config.tool_registry;
    result?;
    assert_eq!(runtime.setup.system_prompt, base_prompt);
    let requests = capture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model, model);
    assert!(
        requests[0]
            .system_prompt
            .contains(&format!("Selected model ID: {model:?}"))
    );
    assert!(
        requests[0]
            .system_prompt
            .contains(&format!("Configured provider: {provider:?}"))
    );
    assert_eq!(
        requests[0]
            .system_prompt
            .matches("<kordi_model_context>")
            .count(),
        1
    );
    Ok(())
}
