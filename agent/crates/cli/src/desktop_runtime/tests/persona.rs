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
        runtime.agent_profile().system_prompt.contains(
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
            .contains("<desktop_dynamic_system_context>\nYou are Researcher.")
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

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn shared_context_is_bounded_and_does_not_include_the_member_directory() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let test_home = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", test_home.path());
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "test-openai-key");
    Settings { default_provider: Some("openai".to_string()), default_model: Some("gpt-4o-mini".to_string()), ..Settings::default() }.save_global()?;
    let cwd = tempfile::tempdir()?;
    let mut runtime = DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), &format!("shared-context-{}", uuid::Uuid::new_v4())).await?;
    let mut messages = (0..100).map(|index| DesktopChatContextMessage {
        id: format!("message-{index}"), author_name: "Recent speaker".to_string(), author_kind: "human".to_string(),
        context_role: None, text: format!("history-{index}: {}", "x".repeat(2000)), created_at_ms: Some(index),
    }).collect::<Vec<_>>();
    messages.push(DesktopChatContextMessage {
        id: "directory".to_string(), author_name: "Directory".to_string(), author_kind: "agent".to_string(),
        context_role: Some("resource".to_string()), text: "Unrelated Participant Secret Name".to_string(), created_at_ms: None,
    });
    runtime.group_observation_context(Some("group-a"), Some("Unrelated Participant Secret Name"))?;
    assert_eq!(runtime.group_observation_context(None, None)?, Some(("group-a".to_string(), Some("Unrelated Participant Secret Name".to_string()))));
    runtime.sync_shared_context_messages(&messages)?;
    assert_eq!(runtime.group_observation_context(None, None)?.unwrap().0, "group-a");
    let context = kordi_session::context::build_context(&runtime.setup.conn, runtime.session_id())?;
    let payload = serde_json::to_string(&context.messages)?;
    assert!(!payload.contains("Secret Name"));
    assert!(!payload.contains("history-91:"));
    assert!(payload.contains("history-92:"));
    assert!(payload.contains("history-99:"));
    assert!(payload.len() < 8000);
    runtime.sync_shared_context_messages(&[])?;
    assert!(kordi_session::context::build_context(&runtime.setup.conn, runtime.session_id())?.messages.is_empty());
    assert!(!kordi_session::store::get_entries(&runtime.setup.conn, runtime.session_id())?.is_empty());
    Ok(())
}
