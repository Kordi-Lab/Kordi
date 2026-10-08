use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use chrono::Utc;
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::agent_session_runtime::{AgentSessionRuntimeBootstrap, AgentSessionRuntimeHost};
use kordi_core::types::{
    AgentMessage, ContentBlock, EntryBase, EntryId, SessionEntry, UserMessage,
};
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::registry::{ApiType, CostConfig, Model, ModelInput};
use kordi_session::store;
use kordi_tools::{ExecutionPolicy, ToolContext, ToolExecutionMode};
use kordi_tui::tui::TuiCommand;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::extensions::{ExtensionBootstrap, ExtensionCommandRegistry};
use crate::session_bootstrap::{SessionRuntimeSetup, SessionUiOptions};
use crate::tui::RESUME_SESSION_MENU_ID;
use crate::tui::controller::{PendingImage, QueuedPrompt, TuiController};

fn test_model() -> Model {
    Model {
        id: "gpt-test".to_string(),
        name: "gpt-test".to_string(),
        provider: "openai".to_string(),
        api: ApiType::OpenaiCompletions,
        context_window: 128_000,
        max_tokens: 16_384,
        reasoning: false,
        input: vec![ModelInput::Text],
        base_url: None,
        cost: CostConfig::default(),
    }
}

fn build_test_controller() -> (
    TuiController,
    mpsc::UnboundedReceiver<TuiCommand>,
    tempfile::TempDir,
) {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let cwd = tempdir.path().to_path_buf();
    let conn = store::open_memory().expect("memory db");
    let model = test_model();
    let tool_ctx = ToolContext {
        cwd: cwd.clone(),
        artifacts_dir: cwd.join("artifacts"),
        model: None,
        execution_policy: ExecutionPolicy::Safety,
        invocation_id: None,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: ToolExecutionMode::Interactive,
        request_approval: None,
    };
    let runtime_host = AgentSessionRuntimeHost::from_bootstrap(AgentSessionRuntimeBootstrap {
        cwd: Some(cwd),
        ..AgentSessionRuntimeBootstrap::default()
    });
    let options = SessionUiOptions {
        session_id: Some("seed-session".to_string()),
        ..SessionUiOptions::default()
    };
    let session_setup = SessionRuntimeSetup {
        conn,
        session_id: "seed-session".to_string(),
        provider: Arc::new(OpenAiProvider::new()),
        model,
        auth: None,
        ephemeral_auth: None,
        ephemeral_base_url: None,
        ephemeral_original_model_api: None,
        auth_choice_override: None,
        api_key: String::new(),
        base_url: "https://api.openai.com/v1".to_string(),
        headers: HashMap::new(),
        tool_registry: crate::tool_registry::ToolRegistry::default(),
        tool_selection: crate::tool_registry::ToolSelection::All,
        tool_ctx,
        memory_remote: crate::memory_remote::empty_memory_remote_slot(),
        system_prompt: String::new(),
        base_system_prompt: String::new(),
        thinking_level: "medium".to_string(),
        compaction_enabled: true,
        compaction_reserve_tokens: 8_000,
        compaction_keep_recent_tokens: 16_000,
        retry_enabled: true,
        retry_max_retries: 3,
        retry_base_delay_ms: 100,
        retry_max_delay_ms: 1_000,
        session_created: true,
        request_metrics_tracker: Arc::new(tokio::sync::Mutex::new(
            kordi_monitor::RequestMetricsTracker::new(),
        )),
        request_metrics_log_path: None,
        sibling_conn: None,
        extension_commands: ExtensionCommandRegistry::default(),
        extension_bootstrap: ExtensionBootstrap::default(),
        slash_command_items: Vec::new(),
    };
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (_approval_tx, approval_rx) = mpsc::unbounded_channel();
    let controller = TuiController::new(
        runtime_host,
        options,
        session_setup,
        command_tx,
        approval_rx,
    );
    (controller, command_rx, tempdir)
}

fn drain_commands(rx: &mut mpsc::UnboundedReceiver<TuiCommand>) -> Vec<TuiCommand> {
    let mut commands = Vec::new();
    while let Ok(command) = rx.try_recv() {
        commands.push(command);
    }
    commands
}

#[test]
fn handle_new_session_clears_transient_state_and_emits_reset_commands() {
    let (mut controller, mut command_rx, _tempdir) = build_test_controller();
    controller.queued_prompts = VecDeque::from([QueuedPrompt::Visible("queued".to_string())]);
    controller.pending_tree_summary_target = Some("tree-1".to_string());
    controller.pending_tree_custom_prompt_target = Some("tree-2".to_string());
    controller.pending_images.push(PendingImage {
        data: "abcd".to_string(),
        mime_type: "image/png".to_string(),
    });
    controller.retry_status = Some("retrying".to_string());
    controller.manual_compaction_in_progress = true;
    controller.manual_compaction_generation = 7;
    let cancel = CancellationToken::new();
    controller.local_action_cancel = Some(cancel.clone());
    let previous_session_id = controller.session_setup.session_id.clone();

    controller.handle_new_session();

    assert_ne!(controller.session_setup.session_id, previous_session_id);
    assert!(!controller.session_setup.session_created);
    assert!(controller.queued_prompts.is_empty());
    assert!(controller.pending_tree_summary_target.is_none());
    assert!(controller.pending_tree_custom_prompt_target.is_none());
    assert!(controller.pending_images.is_empty());
    assert!(controller.retry_status.is_none());
    assert!(!controller.manual_compaction_in_progress);
    assert_eq!(controller.manual_compaction_generation, 8);
    assert!(cancel.is_cancelled());

    let commands = drain_commands(&mut command_rx);
    assert!(
        commands
            .iter()
            .any(|command| matches!(command, TuiCommand::SetLocalActionActive(false)))
    );
    assert!(
        commands
            .iter()
            .any(|command| matches!(command, TuiCommand::SetInput(text) if text.is_empty()))
    );
    assert!(commands.iter().any(|command| matches!(command, TuiCommand::SetTranscript(transcript) if transcript.root_blocks().is_empty())));
    assert!(commands.iter().any(|command| matches!(command, TuiCommand::PushNote { text, .. } if text == "New session started")));
}

#[test]
fn open_resume_menu_lists_named_and_unnamed_sessions() {
    let (mut controller, mut command_rx, _tempdir) = build_test_controller();
    let cwd = controller.session_setup.tool_ctx.cwd.display().to_string();
    let named_session =
        store::create_session(&controller.session_setup.conn, &cwd).expect("create named session");
    store::set_session_name(
        &controller.session_setup.conn,
        &named_session,
        Some("named session"),
    )
    .expect("name session");
    let unnamed_session = store::create_session(&controller.session_setup.conn, &cwd)
        .expect("create unnamed session");

    controller.open_resume_menu().expect("open resume menu");

    let commands = drain_commands(&mut command_rx);
    let (menu_id, title, items) = commands
        .into_iter()
        .find_map(|command| match command {
            TuiCommand::OpenSelectMenu {
                menu_id,
                title,
                items,
                ..
            } => Some((menu_id, title, items)),
            _ => None,
        })
        .expect("resume menu command");

    assert_eq!(menu_id, RESUME_SESSION_MENU_ID);
    assert_eq!(title, "Resume session");
    assert!(
        items
            .iter()
            .any(|item| item.label == "named session" && item.value == named_session)
    );
    assert!(items.iter().any(|item| item.label
        == unnamed_session.chars().take(8).collect::<String>()
        && item.value == unnamed_session));
    assert!(items.iter().all(|item| {
        item.detail
            .as_deref()
            .is_some_and(|detail| detail.contains("entries •"))
    }));
}

#[tokio::test]
async fn handle_resume_session_clears_stale_state_and_reports_success() {
    let (mut controller, mut command_rx, _tempdir) = build_test_controller();
    let cwd = controller.session_setup.tool_ctx.cwd.display().to_string();
    let session_id =
        store::create_session(&controller.session_setup.conn, &cwd).expect("create session");
    let user_entry = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "resume me".to_string(),
            }],
            timestamp: Utc::now().timestamp_millis(),
        }),
    };
    store::append_entry(&controller.session_setup.conn, &session_id, &user_entry)
        .expect("append user entry");

    controller.pending_tree_summary_target = Some("tree-1".to_string());
    controller.pending_tree_custom_prompt_target = Some("tree-2".to_string());
    controller.pending_images.push(PendingImage {
        data: "abcd".to_string(),
        mime_type: "image/png".to_string(),
    });
    controller.queued_prompts = VecDeque::from([QueuedPrompt::Hidden("queued".to_string())]);
    controller.streaming = true;
    controller.retry_status = Some("retrying".to_string());
    controller.manual_compaction_in_progress = true;
    controller.manual_compaction_generation = 11;
    let cancel = CancellationToken::new();
    controller.local_action_cancel = Some(cancel.clone());

    controller
        .handle_resume_session(&session_id)
        .await
        .expect("resume session");

    assert_eq!(controller.session_setup.session_id, session_id);
    assert!(controller.session_setup.session_created);
    assert_eq!(
        controller.options.session_id.as_deref(),
        Some(session_id.as_str())
    );
    assert!(controller.pending_tree_summary_target.is_none());
    assert!(controller.pending_tree_custom_prompt_target.is_none());
    assert!(controller.pending_images.is_empty());
    assert!(controller.queued_prompts.is_empty());
    assert!(!controller.streaming);
    assert!(controller.retry_status.is_none());
    assert!(!controller.manual_compaction_in_progress);
    assert_eq!(controller.manual_compaction_generation, 12);
    assert!(cancel.is_cancelled());

    let commands = drain_commands(&mut command_rx);
    assert!(commands.iter().any(|command| matches!(command, TuiCommand::SetStatusLine(text) if text == "Resuming session...")));
    assert!(
        commands
            .iter()
            .any(|command| matches!(command, TuiCommand::SetLocalActionActive(true)))
    );
    assert!(
        commands
            .iter()
            .any(|command| matches!(command, TuiCommand::SetTranscriptWithToolStates { .. }))
    );
    assert!(
        commands
            .iter()
            .any(|command| matches!(command, TuiCommand::SetInput(text) if text.is_empty()))
    );
    assert!(commands.iter().any(
        |command| matches!(command, TuiCommand::SetStatusLine(text) if text == "Resumed session")
    ));
}

#[tokio::test]
async fn handle_resume_session_clamps_restored_thinking_to_model_capabilities() {
    let (mut controller, _command_rx, _tempdir) = build_test_controller();
    let cwd = controller.session_setup.tool_ctx.cwd.display().to_string();
    let session_id =
        store::create_session(&controller.session_setup.conn, &cwd).expect("create session");
    let model_change_id = EntryId::generate();
    let model_change = SessionEntry::ModelChange {
        base: EntryBase {
            id: model_change_id.clone(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        provider: "openai".to_string(),
        model_id: "gpt-5.5".to_string(),
    };
    store::append_entry(&controller.session_setup.conn, &session_id, &model_change)
        .expect("append model change");
    let thinking_change = SessionEntry::ThinkingLevelChange {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: Some(model_change_id),
            timestamp: Utc::now(),
        },
        thinking_level: ThinkingLevel::Max,
    };
    store::append_entry(
        &controller.session_setup.conn,
        &session_id,
        &thinking_change,
    )
    .expect("append thinking change");

    controller
        .handle_resume_session(&session_id)
        .await
        .expect("resume session");

    assert_eq!(controller.session_setup.model.id, "gpt-5.5");
    assert_eq!(controller.session_setup.thinking_level, "xhigh");
    assert_eq!(
        controller.runtime_host.session().thinking_level(),
        ThinkingLevel::XHigh
    );
}
