use super::*;

fn request(fork_turns: Option<&str>, write_scope: Vec<String>) -> SpawnRequest {
    SpawnRequest {
        task_path: "/root/research".to_string(),
        task_name: "research".to_string(),
        task_title: "Research the sources".to_string(),
        message: "Research the sources.".to_string(),
        fork_turns: fork_turns.map(ToString::to_string),
        write_scope,
        cwd: std::path::PathBuf::from("/tmp"),
        parent_message_id: None,
        attachment_paths: Vec::new(),
    }
}

#[test]
fn managed_background_profile_is_isolated_and_scope_aware() {
    let runner = ManagedChildAgentRunner::new(
        DesktopChatManager::default(),
        "parent".to_string(),
        Some("request".to_string()),
        DesktopRuntimeProfile::default(),
    );
    let read_only = runner
        .profile_for(&request(Some("none"), Vec::new()))
        .unwrap();
    let writer = runner
        .profile_for(&request(Some("none"), vec!["src".to_string()]))
        .unwrap();

    assert!(!read_only
        .tool_names
        .unwrap()
        .iter()
        .any(|name| name == "bash"));
    assert!(writer.tool_names.unwrap().iter().any(|name| name == "bash"));
    assert!(runner
        .profile_for(&request(Some("all"), Vec::new()))
        .is_err());
}

#[test]
fn background_child_inherits_parent_hosted_route() {
    let route = DesktopChatMessageRoute {
        model: Some("openai-codex/gpt-5.6-sol".to_string()),
        auth_provider: Some("openai-codex".to_string()),
        auth_choice: Some("cloud-login:account".to_string()),
        thinking: Some("high".to_string()),
    };
    let hosted_auth = crate::chat::hosted_provider_auth::HostedTurnAuth {
        provider: "openai-codex".to_string(),
        auth: kordi_cli::login::ResolvedProviderAuth {
            source: kordi_cli::login::AuthSource::KordiAuth,
            credential_provider: "openai-codex".to_string(),
            method: kordi_cli::login::ProviderAuthMethod::OAuth,
            credential: "access-token".to_string(),
            account_id: None,
            account_label: None,
            authority: None,
        },
        base_url: None,
        api: None,
        expires_at_ms: Some(i64::MAX),
    };
    let lease = kordi_cli::desktop_runtime::DesktopCloudExecutionLease {
        session_id: "session:group:parent".to_string(),
        run_id: "run-parent".to_string(),
        claim_id: "claim-parent".to_string(),
        owner_account_id: "owner".to_string(),
    };
    let runner = ManagedChildAgentRunner::new(
        DesktopChatManager::default(),
        "session:group:parent".to_string(),
        Some("request".to_string()),
        DesktopRuntimeProfile::default(),
    )
    .with_parent_route(
        Some(route),
        Some(InheritedHostedAuth::new(hosted_auth, Some(lease))),
    );

    let input = runner.start_input("child".to_string(), "Count lines.".to_string(), Vec::new());

    let route = input.route.expect("child route");
    assert_eq!(route.auth_choice.as_deref(), Some("cloud-login:account"));
    assert_eq!(route.auth_provider.as_deref(), Some("openai-codex"));
    assert_eq!(route.model.as_deref(), Some("openai-codex/gpt-5.6-sol"));
    assert_eq!(route.thinking.as_deref(), Some("high"));
    let inherited = input.inherited_hosted_auth.expect("inherited hosted auth");
    assert_eq!(inherited.current().auth.credential, "access-token");
    assert_eq!(inherited.current().provider, "openai-codex");
    // The child carries the parent lease so a stale token can be resolved
    // again; no lease reaches the child's own context.
    assert_eq!(
        inherited.lease().map(|lease| lease.claim_id.as_str()),
        Some("claim-parent")
    );
    assert!(input
        .context_messages
        .unwrap_or_default()
        .iter()
        .all(|message| message.execution_lease.is_none()));

    // Child follow-up messages and the parent follow-up turn reuse the
    // same start input, so they share the refreshable credential.
    let follow_up = runner.start_input(
        "session:group:parent".to_string(),
        "Background task finished.".to_string(),
        Vec::new(),
    );
    assert!(follow_up.inherited_hosted_auth.is_some());
}
