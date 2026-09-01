#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn sync_context_messages_imports_cloud_history_once_as_native_session_context() -> Result<()>
{
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

    let mut runtime = DesktopRuntimeSession::create_with_id(
        cwd.path().to_path_buf(),
        "cloud-agent:acct_a:session:group:g1",
    )
    .await?;
    let imported = vec![
        DesktopChatContextMessage {
            id: "group_persona".to_string(),
            author_name: "Group agent identity".to_string(),
            author_kind: "agent".to_string(),
            context_role: Some("system".to_string()),
            text: "You are Scout. The requester owns you.".to_string(),
            created_at_ms: Some(1_800_000_000_000),
        },
        DesktopChatContextMessage {
            id: "msg_cloud_1".to_string(),
            author_name: "Alex Morgan".to_string(),
            author_kind: "human".to_string(),
            context_role: None,
            text: "Hello group".to_string(),
            created_at_ms: Some(1_800_000_000_000),
        },
    ];

    assert_eq!(runtime.sync_context_messages(&imported)?, 1);
    assert_eq!(runtime.sync_context_messages(&imported)?, 0);
    assert!(
        runtime.agent_profile().system_prompt.starts_with(
            "<desktop_dynamic_system_context>\nYou are Scout. The requester owns you."
        )
    );

    let entries = kordi_session::store::get_entries(
        &runtime.setup.conn,
        "cloud-agent:acct_a:session:group:g1",
    )?;
    let cloud_context_entries = entries
        .iter()
        .filter_map(|row| serde_json::from_str::<SessionEntry>(&row.payload).ok())
        .filter_map(|entry| match entry {
            SessionEntry::CustomMessage {
                custom_type,
                content,
                details,
                ..
            } if custom_type == CLOUD_AGENT_CONTEXT_CUSTOM_TYPE => Some((content, details)),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(cloud_context_entries.len(), 1);
    assert_eq!(
        cloud_context_entries[0]
            .1
            .as_ref()
            .and_then(|value| value.get("cloudMessageId"))
            .and_then(|value| value.as_str()),
        Some("msg_cloud_1")
    );
    assert!(
        matches!(&cloud_context_entries[0].0[0], ContentBlock::Text { text } if text == "Alex Morgan (human): Hello group")
    );
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn saved_owner_persona_refreshes_existing_sessions_and_stays_system_first() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings {
        agent_name: Some("Scout".to_string()),
        default_provider: Some("openai".to_string()),
        default_model: Some("gpt-4o-mini".to_string()),
        ..Settings::default()
    }
    .save_global()?;

    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), "owner-persona-test")
            .await?;
    assert!(runtime.setup.system_prompt.starts_with(
        "<desktop_owner_agent_persona>\nYou are Scout, the user's local Kordi agent."
    ));

    let mut settings = Settings::load_global();
    settings.agent_name = Some("Atlas".to_string());
    settings.save_global()?;
    runtime.refresh_saved_agent_persona();
    assert!(runtime.setup.system_prompt.starts_with(
        "<desktop_owner_agent_persona>\nYou are Atlas, the user's local Kordi agent."
    ));
    assert!(!runtime.setup.system_prompt.contains("You are Scout"));

    runtime.sync_context_messages(&[DesktopChatContextMessage {
        id: "specialist-persona".to_string(),
        author_name: "Specialist identity".to_string(),
        author_kind: "agent".to_string(),
        context_role: Some("system".to_string()),
        text: "You are Researcher.".to_string(),
        created_at_ms: None,
    }])?;
    assert!(
        runtime
            .setup
            .system_prompt
            .starts_with("<desktop_dynamic_system_context>\nYou are Researcher.")
    );
    assert!(
        !runtime
            .setup
            .system_prompt
            .contains("<desktop_owner_agent_persona>")
    );

    runtime.sync_context_messages(&[])?;
    assert!(runtime.setup.system_prompt.starts_with(
        "<desktop_owner_agent_persona>\nYou are Atlas, the user's local Kordi agent."
    ));
    Ok(())
}
