#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn refresh_memory_prompt_section_rereads_edited_lesson_files() -> Result<()> {
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

    let session_id = "memory-refresh-session";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    assert!(!runtime.setup.system_prompt.contains("<desktop_memory_context>"));

    let lesson_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        &runtime.setup.tool_ctx.artifacts_dir,
        "conversation",
        session_id,
    );
    std::fs::create_dir_all(lesson_path.parent().expect("lesson dir"))?;
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-01T10:00:00Z [manual] End every reply with PINEAPPLE.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    assert!(
        runtime
            .setup
            .system_prompt
            .contains("This conversation:\n- End every reply with PINEAPPLE.")
    );

    runtime.set_session_prompt_context(Some("Session details".to_string()));
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-09T10:00:00Z [manual] End every reply with the single word mongo.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    let prompt = &runtime.setup.system_prompt;
    assert!(prompt.contains("This conversation:\n- End every reply with the single word mongo."));
    assert!(!prompt.contains("PINEAPPLE"));
    assert_eq!(prompt.matches("<desktop_memory_context>").count(), 1);
    assert_eq!(prompt.matches("## Memories").count(), 1);
    assert!(prompt.contains("Session details"));

    std::fs::remove_file(&lesson_path)?;
    runtime.refresh_memory_prompt_section();
    assert!(!runtime.setup.system_prompt.contains("<desktop_memory_context>"));
    assert!(runtime.setup.system_prompt.contains("Session details"));
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn refresh_memory_prompt_section_leaves_no_block_when_memory_is_off() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        memory: kordi_core::settings::MemorySettings {
            memory_enabled: false,
            exclude_sensitive: true,
        },
        ..Settings::default()
    }
    .save_global()?;

    let session_id = "memory-off-session";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    let lesson_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        &runtime.setup.tool_ctx.artifacts_dir,
        "conversation",
        session_id,
    );
    std::fs::create_dir_all(lesson_path.parent().expect("lesson dir"))?;
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-01T10:00:00Z [manual] Reply in French.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    assert!(!runtime.setup.system_prompt.contains("<desktop_memory_context>"));
    assert!(!runtime.setup.system_prompt.contains("Reply in French"));
    Ok(())
}
