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

fn stored_identity_prompts(runtime: &DesktopRuntimeSession) -> Result<Vec<String>> {
    let mut statement = runtime.setup.conn.prepare(
        "SELECT json_extract(payload,'$.data.systemPrompt') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='runtime_identity_prompt' ORDER BY seq",
    )?;
    let prompts = statement
        .query_map([runtime.session_id()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(prompts)
}

async fn identity_memory_runtime(
    cwd: &std::path::Path,
    session_id: &str,
) -> Result<(DesktopRuntimeSession, std::path::PathBuf)> {
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.to_path_buf(), session_id).await?;
    let identity = kordi_core::types::RuntimeIdentity {
        request_id: "request-a".into(),
        agent_id: "agent-owner".into(),
        agent_name: "Owner's Kordi".into(),
        owner_account_id: "owner".into(),
        owner_name: "Owner".into(),
        requester_account_id: "visitor".into(),
        requester_name: "Visitor".into(),
        request_policy: None,
    };
    runtime.sync_shared_context_messages(&[DesktopChatContextMessage {
        execution_lease: None,
        id: identity.request_id.clone(),
        author_name: "Kordi runtime".into(),
        author_kind: "agent".into(),
        context_role: Some("runtimeIdentity".into()),
        text: serde_json::to_string(&identity)?,
        created_at_ms: None,
    }])?;
    let lesson_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        &runtime.setup.tool_ctx.artifacts_dir,
        "conversation",
        session_id,
    );
    std::fs::create_dir_all(lesson_path.parent().expect("lesson dir"))?;
    Ok((runtime, lesson_path))
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn frozen_identity_prompt_keeps_the_current_memory_block() -> Result<()> {
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

    // Frozen while memory A exists: the stored header carries no memory block.
    let (mut runtime, lesson_path) =
        identity_memory_runtime(cwd.path(), "identity-memory-session").await?;
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-01T10:00:00Z [manual] End every reply with PINEAPPLE.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    runtime.freeze_identity_prompt()?;
    assert!(runtime.setup.system_prompt.contains("PINEAPPLE"));
    let stored = stored_identity_prompts(&runtime)?;
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].contains("<desktop_memory_context>"));
    assert!(!stored[0].contains("PINEAPPLE"));

    // Next turn: the file changed to B; the restored header gets B, not A.
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-09T10:00:00Z [manual] End every reply with mongo.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    runtime.freeze_identity_prompt()?;
    let prompt = &runtime.setup.system_prompt;
    assert!(prompt.starts_with(&stored[0]));
    assert!(prompt.contains("This conversation:\n- End every reply with mongo."));
    assert!(!prompt.contains("PINEAPPLE"));
    assert_eq!(prompt.matches("<desktop_memory_context>").count(), 1);
    assert_eq!(stored_identity_prompts(&runtime)?, stored);

    // Frozen before any memory existed: a later memory file adds the block.
    let (mut runtime, lesson_path) =
        identity_memory_runtime(cwd.path(), "identity-memory-late-session").await?;
    runtime.refresh_memory_prompt_section();
    runtime.freeze_identity_prompt()?;
    assert!(!runtime.setup.system_prompt.contains("<desktop_memory_context>"));
    let stored = stored_identity_prompts(&runtime)?;
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].contains("<desktop_memory_context>"));
    std::fs::write(
        &lesson_path,
        "# Reflection lessons\n\n- 2026-10-09T10:00:00Z [manual] Reply in French.\n",
    )?;
    runtime.refresh_memory_prompt_section();
    runtime.freeze_identity_prompt()?;
    let prompt = &runtime.setup.system_prompt;
    assert!(prompt.starts_with(&stored[0]));
    assert!(prompt.contains("- Reply in French."));
    assert_eq!(prompt.matches("<desktop_memory_context>").count(), 1);
    Ok(())
}
