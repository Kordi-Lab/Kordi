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
    runtime.set_model("openai/gpt-5.6-sol")?;
    runtime.set_auth_choice("openai-codex", "local-active-oauth")?;
    runtime.set_thinking("max")?;

    let detail = runtime.detail()?;
    assert_eq!(detail.provider, "openai");
    assert_eq!(detail.model, "gpt-5.6-sol");
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
    Ok(())
}
