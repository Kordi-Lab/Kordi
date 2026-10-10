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
async fn hosted_credential_is_ephemeral_and_keeps_local_runtime_provider() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let cwd = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::unset("OPENAI_API_KEY");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-5.5".into()),
        ..Settings::default()
    }
    .save_global()?;
    let session_id = "session:self-agent:hosted-ephemeral";
    let mut runtime = DesktopRuntimeSession::create_with_id(cwd.path().into(), session_id).await?;
    runtime.apply_turn_hosted_model("openai-codex/gpt-5.5")?;
    let auth = crate::login::ResolvedProviderAuth {
        source: crate::login::AuthSource::KordiAuth,
        credential_provider: "openai-codex".into(),
        method: crate::login::ProviderAuthMethod::OAuth,
        credential: "synthetic-hosted-token".into(),
        account_id: Some("synthetic-account".into()),
        account_label: None,
        authority: None,
    };
    assert!(runtime
        .set_ephemeral_provider_auth("anthropic", auth.clone())
        .is_err());
    runtime.set_ephemeral_provider_auth("openai-codex", auth)?;
    assert_eq!(runtime.setup.api_key, "synthetic-hosted-token");
    assert_eq!(runtime.setup.auth.as_ref().map(|auth| auth.method), Some(crate::login::ProviderAuthMethod::OAuth));
    assert_eq!(runtime.setup.model.provider, "openai");
    runtime.clear_ephemeral_provider_auth();
    assert_ne!(runtime.setup.api_key, "synthetic-hosted-token");
    let api_before = runtime.setup.model.api.clone();
    runtime.set_ephemeral_provider_auth_with_options(
        "openai",
        crate::login::ResolvedProviderAuth {
            source: crate::login::AuthSource::KordiAuth,
            credential_provider: "openai".into(),
            method: crate::login::ProviderAuthMethod::ApiKey,
            credential: "synthetic-hosted-api-key".into(),
            account_id: None,
            account_label: None,
            authority: None,
        },
        Some("https://synthetic.example/v1".into()),
        Some("openai-responses"),
    )?;
    assert_eq!(runtime.setup.base_url, "https://synthetic.example/v1");
    assert!(matches!(runtime.setup.model.api, kordi_provider::registry::ApiType::OpenaiResponses));
    runtime.clear_ephemeral_provider_auth();
    assert_ne!(runtime.setup.api_key, "synthetic-hosted-api-key");
    assert_eq!(std::mem::discriminant(&runtime.setup.model.api), std::mem::discriminant(&api_before));
    runtime.materialize_session()?;
    drop(runtime);
    let resumed = DesktopRuntimeSession::resume(cwd.path().into(), session_id).await?;
    assert_ne!(resumed.setup.api_key, "synthetic-hosted-token");
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn request_routes_apply_to_one_turn_without_switch_entries() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let cwd = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-5.6-sol".into()),
        ..Settings::default()
    }
    .save_global()?;
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().into(), "session:self-agent:turn-route")
            .await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    drop(runtime.begin_message_streaming("hello".into(), vec![], cancel.clone()).await?);
    let configured = runtime.detail()?;
    let count = |runtime: &DesktopRuntimeSession, kind: &str| -> Result<i64> {
        Ok(runtime.setup.conn.query_row(
            "SELECT count(*) FROM entries WHERE session_id = ?1 AND type = ?2",
            rusqlite::params![runtime.setup.session_id, kind],
            |row| row.get(0),
        )?)
    };

    // A hosted request route runs its exact model, even one the local
    // registry does not list, and records nothing in the transcript.
    runtime.apply_turn_hosted_model("openai-codex/gpt-6-sol")?;
    runtime.apply_turn_thinking("high")?;
    assert_runtime_request_model_context(&mut runtime, "gpt-6-sol", "openai").await?;
    drop(runtime.begin_message_streaming("again".into(), vec![], cancel.clone()).await?);
    let detail = runtime.detail()?;
    assert_eq!((detail.provider, detail.model), (configured.provider, configured.model));
    assert_eq!(detail.thinking, configured.thinking);

    runtime.apply_turn_model("openai/gpt-6-astra")?;
    drop(runtime.begin_message_streaming("local".into(), vec![], cancel.clone()).await?);
    assert_eq!(runtime.detail()?.model, "gpt-5.6-sol");
    assert_eq!(count(&runtime, "model_change")?, 0);
    assert_eq!(count(&runtime, "thinking_level_change")?, 0);

    // A change the person makes is still recorded once.
    runtime.set_explicit_config(Some("openai/gpt-6-astra"), None)?;
    assert_eq!(count(&runtime, "model_change")?, 1);
    assert_eq!(runtime.detail()?.model, "gpt-6-astra");
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
