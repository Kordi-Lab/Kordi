#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn current_model_metadata_matches_the_dispatched_route_without_mutating_saved_identity()
-> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let cwd = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-4o-mini".into()),
        ..Settings::default()
    }
    .save_global()?;
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), "model-context-test")
            .await?;
    let saved_prompt = runtime.setup.system_prompt.clone();
    for model_id in ["gpt-5.6-sol", "gpt-5.4"] {
        runtime.setup.model.id = model_id.into();
        let policy = runtime.setup.tool_ctx.execution_policy;
        let config = turn_execution::build_turn_config(
            &mut runtime.setup,
            tokio_util::sync::CancellationToken::new(),
            policy,
            false,
            cwd.path().to_path_buf(),
        )?;
        let route_json =
            serde_json::json!({"provider":config.model.provider,"model":config.model.id})
                .to_string();
        assert!(config.system_prompt.contains(&route_json));
        assert_eq!(config.model.id, model_id);
        assert_eq!(
            config
                .system_prompt
                .matches("<current_model_route>")
                .count(),
            1
        );
        assert_eq!(runtime.setup.system_prompt, saved_prompt);
        runtime.setup.tool_registry = config.tool_registry;
    }
    Ok(())
}
