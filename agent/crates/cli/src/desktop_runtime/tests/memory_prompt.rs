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

fn save_memory_settings(memory_enabled: bool) -> Result<()> {
    Settings {
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        memory: kordi_core::settings::MemorySettings {
            memory_enabled,
            exclude_sensitive: true,
        },
        ..Settings::default()
    }
    .save_global()?;
    Ok(())
}

/// `(custom_type, text)` for every memory update and snapshot entry, in order.
fn memory_entries(runtime: &DesktopRuntimeSession) -> Result<Vec<(String, String)>> {
    let mut statement = runtime.setup.conn.prepare(
        "SELECT json_extract(payload,'$.custom_type'), COALESCE(json_extract(payload,'$.content[0].text'), json_extract(payload,'$.data')) FROM entries WHERE session_id=?1 AND json_extract(payload,'$.custom_type') IN ('memory_update','memory_snapshot') ORDER BY seq",
    )?;
    let entries = statement
        .query_map([runtime.session_id()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

fn write_conversation_memory(path: &std::path::Path, text: &str) -> Result<()> {
    std::fs::create_dir_all(path.parent().expect("lesson dir"))?;
    std::fs::write(
        path,
        format!("# Reflection lessons\n\n- 2026-10-09T10:00:00Z [manual] {text}\n"),
    )?;
    Ok(())
}

const PINEAPPLE: &str = "End every reply in this conversation with the single word PINEAPPLE.";
const MONGO: &str =
    "From now on, end every reply in this conversation with the single word mongo.";

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn memory_changes_are_recorded_as_hidden_update_notes() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    save_memory_settings(true)?;

    let session_id = "memory-update-session";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    let lesson_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        &runtime.setup.tool_ctx.artifacts_dir,
        "conversation",
        session_id,
    );
    write_conversation_memory(&lesson_path, PINEAPPLE)?;
    runtime.refresh_memory_prompt_section();
    let prompt = runtime.setup.system_prompt.clone();
    assert!(prompt.contains(PINEAPPLE));

    // The prompt already shows memory A: record it without an update note.
    runtime.record_memory_updates()?;
    let entries = memory_entries(&runtime)?;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].0, "memory_snapshot");
    assert!(entries[0].1.contains(PINEAPPLE));

    // A changed to B: one update note, then a new snapshot. The prompt stays.
    write_conversation_memory(&lesson_path, MONGO)?;
    runtime.record_memory_updates()?;
    let entries = memory_entries(&runtime)?;
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[1].0, "memory_update");
    assert_eq!(
        entries[1].1,
        format!(
            "Memory update: the saved memories changed since the previous message. They are current and replace any earlier instruction in this chat that conflicts with them.\nAdded:\n- (This conversation) {MONGO}\nRemoved:\n- (This conversation) {PINEAPPLE}\nCurrent memories:\nThis conversation:\n- {MONGO}"
        )
    );
    assert_eq!(entries[2].0, "memory_snapshot");
    assert!(entries[2].1.contains(MONGO) && !entries[2].1.contains(PINEAPPLE));
    assert_eq!(runtime.setup.system_prompt, prompt);
    assert!(!serde_json::to_string(&runtime.detail()?)?.contains("Memory update"));

    // Unchanged: nothing new.
    runtime.record_memory_updates()?;
    assert_eq!(memory_entries(&runtime)?.len(), 3);
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn memory_update_lists_every_memory_when_the_prompt_had_none() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    save_memory_settings(true)?;

    // An older session frozen before any memory existed.
    let (mut runtime, lesson_path) =
        identity_memory_runtime(cwd.path(), "identity-memory-late-session").await?;
    runtime.freeze_identity_prompt()?;
    let stored = stored_identity_prompts(&runtime)?;
    assert!(!stored[0].contains("<desktop_memory_context>"));

    write_conversation_memory(&lesson_path, MONGO)?;
    runtime.record_memory_updates()?;
    runtime.freeze_identity_prompt()?;
    let entries = memory_entries(&runtime)?;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "memory_update");
    assert!(entries[0].1.contains(&format!("\nAdded:\n- (This conversation) {MONGO}\n")));
    assert!(!entries[0].1.contains("Removed:"));
    assert_eq!(entries[1].0, "memory_snapshot");
    assert_eq!(runtime.setup.system_prompt, stored[0]);
    assert!(!serde_json::to_string(&runtime.detail()?)?.contains("Memory update"));
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn memory_updates_are_not_recorded_when_memory_is_off() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    save_memory_settings(false)?;

    let session_id = "memory-off-update-session";
    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), session_id).await?;
    let lesson_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        &runtime.setup.tool_ctx.artifacts_dir,
        "conversation",
        session_id,
    );
    write_conversation_memory(&lesson_path, MONGO)?;
    runtime.record_memory_updates()?;
    write_conversation_memory(&lesson_path, PINEAPPLE)?;
    runtime.record_memory_updates()?;
    assert!(memory_entries(&runtime)?.is_empty());
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn frozen_identity_prompt_is_restored_unchanged() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    save_memory_settings(true)?;

    // Frozen while memory A exists: the stored header keeps the A block.
    let (mut runtime, lesson_path) =
        identity_memory_runtime(cwd.path(), "identity-memory-session").await?;
    write_conversation_memory(&lesson_path, PINEAPPLE)?;
    runtime.refresh_memory_prompt_section();
    runtime.record_memory_updates()?;
    runtime.freeze_identity_prompt()?;
    let stored = stored_identity_prompts(&runtime)?;
    assert_eq!(stored.len(), 1);
    assert!(stored[0].contains(PINEAPPLE));
    assert_eq!(runtime.setup.system_prompt, stored[0]);
    assert_eq!(memory_entries(&runtime)?.len(), 1);

    // Next turn: the file changed to B. The header is restored as frozen and
    // the change arrives as an update note.
    write_conversation_memory(&lesson_path, MONGO)?;
    runtime.record_memory_updates()?;
    runtime.freeze_identity_prompt()?;
    assert_eq!(runtime.setup.system_prompt, stored[0]);
    assert_eq!(stored_identity_prompts(&runtime)?, stored);
    let entries = memory_entries(&runtime)?;
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[1].0, "memory_update");
    assert!(entries[1].1.contains(&format!("\nAdded:\n- (This conversation) {MONGO}\n")));
    assert!(entries[1].1.contains(&format!("\nRemoved:\n- (This conversation) {PINEAPPLE}\n")));
    Ok(())
}
