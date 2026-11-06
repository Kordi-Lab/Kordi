use super::*;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
    SessionEntry, StopReason, Usage, UserMessage,
};

#[test]
fn model_runtime_is_hidden_and_snapshot_excludes_private_trace_fields() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let id = kordi_session::store::create_session_with_parent_and_message(
        &conn,
        "/tmp/test",
        Some("parent"),
        Some("request"),
    )?;
    assert!(background_snapshot_from_store(&conn, &id).is_err());
    kordi_session::store::update_session_scope(&conn, &id, "runtime", "/tmp/test", None)?;
    let user_id = EntryId::generate();
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Message {
            base: EntryBase {
                id: user_id.clone(),
                parent_id: None,
                timestamp: chrono::Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "Task brief".into(),
                }],
                timestamp: 1000,
            }),
        },
    )?;
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: Some(user_id),
                timestamp: chrono::Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![
                    AssistantContent::Thinking {
                        thinking: "PRIVATE_TRACE".into(),
                    },
                    AssistantContent::Text {
                        text: "SUBSESSION_RESULT".into(),
                    },
                ],
                provider: "test".into(),
                model: "test".into(),
                usage: Usage::default(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: 2000,
            }),
        },
    )?;
    let snapshot = background_snapshot_from_store(&conn, &id)?;
    assert_eq!(snapshot.parent_session_id, "parent");
    assert_eq!(snapshot.parent_request_id.as_deref(), Some("request"));
    assert_eq!(snapshot.messages[1].text, "SUBSESSION_RESULT");
    let encoded = serde_json::to_string(&snapshot)?;
    assert!(!encoded.contains("PRIVATE_TRACE"));
    assert!(!encoded.contains("thinkingText"));
    assert!(!encoded.contains("forkedFromSessionId"));
    let profile = super::super::DesktopRuntimeProfile {
        system_prompt: Some("PRIVATE_PROFILE".into()),
        tool_names: Some(vec!["web_search".into()]),
        ..Default::default()
    };
    kordi_session::store::append_entry(
        &conn,
        &id,
        &SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: chrono::Utc::now(),
            },
            custom_type: "subsession_runtime_profile".into(),
            data: Some(serde_json::json!({"profile":profile,"executionPolicy":"safety"})),
        },
    )?;
    let restored = saved_runtime_profile_from_store(&conn, &id)?.expect("saved runtime profile");
    assert_eq!(restored.tool_names, Some(vec!["web_search".into()]));
    assert_eq!(
        restored.execution_policy,
        Some(kordi_tools::ExecutionPolicy::Safety)
    );
    let snapshot = background_snapshot_from_store(&conn, &id)?;
    assert!(snapshot.can_resume);
    assert!(!serde_json::to_string(&snapshot)?.contains("PRIVATE_PROFILE"));
    assert!(kordi_session::store::list_sessions(&conn, "/tmp/test")?.is_empty());
    Ok(())
}

fn runtime_session_with_profile(
    conn: &rusqlite::Connection,
    profile: &super::super::DesktopRuntimeProfile,
) -> Result<String> {
    let id = kordi_session::store::create_session_with_parent_and_message(
        conn,
        "/tmp/test",
        Some("parent"),
        Some("request"),
    )?;
    kordi_session::store::update_session_scope(conn, &id, "runtime", "/tmp/test", None)?;
    append_runtime_profile(conn, &id, None, profile)?;
    Ok(id)
}

fn hosted_codex_route() -> super::super::DesktopRuntimeTurnRoute {
    super::super::DesktopRuntimeTurnRoute {
        model: Some("openai-codex/gpt-6-sol".into()),
        auth_provider: Some("openai-codex".into()),
        auth_choice: Some("cloud-login:synthetic".into()),
        thinking: Some("high".into()),
    }
}

/// The parent turn ran on a ChatGPT sign-in. Its model namespace is `openai`,
/// so without the route a resumed background session ran on an OpenAI key.
#[test]
fn background_session_keeps_the_parent_turn_account() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let profile = super::super::DesktopRuntimeProfile {
        provider: Some("openai".into()),
        model: Some("gpt-6-sol".into()),
        turn_route: Some(hosted_codex_route()),
        ..Default::default()
    };
    let id = runtime_session_with_profile(&conn, &profile)?;
    assert_eq!(
        background_turn_route_from_store(&conn, &id)?,
        Some(hosted_codex_route())
    );
    // The route is local metadata and never reaches the shared snapshot.
    let snapshot = serde_json::to_string(&background_snapshot_from_store(&conn, &id)?)?;
    assert!(!snapshot.contains("cloud-login:synthetic"));
    Ok(())
}

#[test]
fn background_session_saved_before_routes_uses_its_profile_model() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let profile = super::super::DesktopRuntimeProfile {
        provider: Some("openai".into()),
        model: Some("gpt-6-sol".into()),
        thinking: Some("medium".into()),
        ..Default::default()
    };
    let id = runtime_session_with_profile(&conn, &profile)?;
    let route = background_turn_route_from_store(&conn, &id)?.expect("profile route");
    assert_eq!(route.model.as_deref(), Some("openai/gpt-6-sol"));
    assert_eq!(route.auth_choice, None);
    assert_eq!(route.thinking.as_deref(), Some("medium"));
    Ok(())
}

#[test]
fn owner_model_choice_keeps_the_background_session_account() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let profile = super::super::DesktopRuntimeProfile {
        provider: Some("openai".into()),
        model: Some("gpt-6-sol".into()),
        tool_names: Some(vec!["read_session".into()]),
        turn_route: Some(hosted_codex_route()),
        ..Default::default()
    };
    let id = runtime_session_with_profile(&conn, &profile)?;
    let next = set_background_turn_route_in_store(
        &conn,
        &id,
        super::super::DesktopRuntimeTurnRoute {
            model: Some("openai-codex/gpt-6-mini".into()),
            auth_provider: Some("anthropic".into()),
            auth_choice: Some("cloud-login:other".into()),
            thinking: None,
        },
    )?;
    assert_eq!(next.model.as_deref(), Some("openai-codex/gpt-6-mini"));
    assert_eq!(next.auth_choice.as_deref(), Some("cloud-login:synthetic"));
    assert_eq!(next.thinking.as_deref(), Some("high"));
    assert_eq!(background_turn_route_from_store(&conn, &id)?, Some(next));
    // The rest of the profile is kept with the new route.
    let restored = saved_runtime_profile_from_store(&conn, &id)?.expect("profile");
    assert_eq!(restored.tool_names, Some(vec!["read_session".into()]));

    let other_provider = set_background_turn_route_in_store(
        &conn,
        &id,
        super::super::DesktopRuntimeTurnRoute {
            model: Some("anthropic/claude-test".into()),
            ..Default::default()
        },
    );
    assert!(other_provider.is_err());
    Ok(())
}
