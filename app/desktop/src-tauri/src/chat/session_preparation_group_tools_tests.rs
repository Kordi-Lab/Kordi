//! Issue 1808: a group turn on the Mac prepares the tools of its cloud lease
//! for the model, and a background task gets the lease's create_document.
//! These run the real preparation path, then read the tool list the next
//! turn would hand to the model (Rust loop or OMP alike).

use kordi_cli::desktop_runtime::{
    DesktopChatContextMessage, DesktopCloudExecutionLease, DesktopRuntimeSession,
};
use kordi_tools::connector_tools::{
    ConnectorToolDescriptor, ConnectorToolGroup, CREATE_DOCUMENT_TOOL, DOCUMENT_TOOLS_PROVIDER,
};

use super::prepare_desktop_session_for_send;
use crate::chat::DesktopChatManager;

const OWNER: &str = "acct_owner_synthetic";
const MEMBER: &str = "acct_member_synthetic";
const GROUP: &str = "session:group:synthetic-documents";

struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EnvGuard {
    fn set(values: &[(&'static str, std::ffi::OsString)]) -> Self {
        let previous = values
            .iter()
            .map(|(key, value)| {
                let previous = std::env::var_os(key);
                std::env::set_var(key, value);
                (*key, previous)
            })
            .collect();
        Self(previous)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, previous) in &self.0 {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn tool(provider: &str, name: &str, group: ConnectorToolGroup) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: if provider == DOCUMENT_TOOLS_PROVIDER {
            "kordi-documents".into()
        } else {
            format!("conn_{provider}")
        },
        provider: provider.into(),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: serde_json::json!({ "type": "object" }),
    }
}

/// The lease a group claim delivers to the owner's Mac.
fn group_lease() -> DesktopCloudExecutionLease {
    DesktopCloudExecutionLease {
        session_id: GROUP.into(),
        run_id: "car_synthetic".into(),
        claim_id: "00000000-0000-4000-8000-000000000001".into(),
        owner_account_id: OWNER.into(),
        connector_tools: Some(vec![
            tool("gmail", "gmail_send", ConnectorToolGroup::Act),
            tool(
                DOCUMENT_TOOLS_PROVIDER,
                "read_document",
                ConnectorToolGroup::Read,
            ),
            tool(
                DOCUMENT_TOOLS_PROVIDER,
                CREATE_DOCUMENT_TOOL,
                ConnectorToolGroup::Act,
            ),
        ]),
        connector_audience: Some("shared".into()),
    }
}

fn identity(
    requester: &str,
    lease: Option<DesktopCloudExecutionLease>,
) -> DesktopChatContextMessage {
    DesktopChatContextMessage {
        execution_lease: lease,
        id: "runtime-identity:car_synthetic".into(),
        author_name: "Kordi runtime".into(),
        author_kind: "agent".into(),
        context_role: Some("runtimeIdentity".into()),
        text: serde_json::json!({
            "requestId": "msg_synthetic",
            "agentId": format!("cloud-agent:{OWNER}"),
            "agentName": "Synthetic Agent",
            "ownerAccountId": OWNER,
            "ownerName": "Owner",
            "requesterAccountId": requester,
            "requesterName": "Requester",
        })
        .to_string(),
        created_at_ms: None,
    }
}

/// Prepares one turn like the Mac does and returns the tools the model would
/// get. A background task runs in its own session under the child profile.
async fn prepared_tools(
    root: &std::path::Path,
    session_id: &str,
    context: Vec<DesktopChatContextMessage>,
) -> Vec<String> {
    let cwd = root.join(format!("cwd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cwd).unwrap();
    let mut runtime = if session_id == "background-child" {
        let child = kordi_cli::desktop_runtime::create_background_session(
            &cwd,
            GROUP,
            Some("msg_synthetic"),
            "Write the document",
        )
        .unwrap();
        let profile = kordi_cli::desktop_runtime::DesktopRuntimeProfile {
            tool_names: Some(kordi_cli::task_operator::managed_child_tool_names(false)),
            ..Default::default()
        };
        DesktopRuntimeSession::resume_profiled(cwd.clone(), &child, profile)
            .await
            .unwrap()
    } else {
        DesktopRuntimeSession::create_with_id(cwd.clone(), session_id)
            .await
            .unwrap()
    };
    if session_id == "background-child" {
        runtime.sync_context_messages(&context).unwrap();
    } else {
        runtime.sync_shared_context_messages(&context).unwrap();
    }
    prepare_desktop_session_for_send(
        &DesktopChatManager::default(),
        &mut runtime,
        cwd,
        "Create a document for the group.",
        (Some(GROUP), None),
        Some("msg_synthetic"),
        &context,
        (None, None),
    )
    .await
    .unwrap();
    let tools = runtime.next_turn_tool_names().unwrap();
    // The prompt asks for create_document exactly when the model has it.
    let offered = tools.iter().any(|tool| tool == CREATE_DOCUMENT_TOOL);
    let prompt = runtime.next_turn_system_prompt();
    assert_eq!(prompt.contains("create_document"), offered, "{tools:?}");
    assert!(prompt.contains("Never put absolute local file paths"));
    tools
}

#[tokio::test(flavor = "multi_thread")]
async fn group_turns_and_background_tasks_offer_create_document() {
    let storage = crate::test_support::ScopedKordiStorageRoot::new("group-document-tools");
    let root = storage.root().to_path_buf();
    let home = root.join("home");
    let app = root.join("app");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    let _env = EnvGuard::set(&[
        ("HOME", home.into_os_string()),
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);
    crate::cloud_session::store_session_for_test(OWNER).unwrap();

    // The owner's own request: every lease tool, create_document included.
    let owner = prepared_tools(
        &root,
        &format!("cloud-agent:{OWNER}:{GROUP}:request:msg_owner"),
        vec![identity(OWNER, Some(group_lease()))],
    )
    .await;
    for name in [CREATE_DOCUMENT_TOOL, "read_document", "gmail_send"] {
        assert!(
            owner.iter().any(|tool| tool == name),
            "{name} missing: {owner:?}"
        );
    }

    // A member's request: the shared document tools only.
    let member = prepared_tools(
        &root,
        &format!("cloud-agent:{OWNER}:{GROUP}:request:msg_member"),
        vec![identity(MEMBER, Some(group_lease()))],
    )
    .await;
    assert!(
        member.iter().any(|tool| tool == CREATE_DOCUMENT_TOOL),
        "{member:?}"
    );
    assert!(
        member.iter().any(|tool| tool == "read_document"),
        "{member:?}"
    );
    assert!(
        !member.iter().any(|tool| tool == "gmail_send"),
        "{member:?}"
    );

    // A background task: no lease of its own, the parent's create_document.
    let child_lease = crate::chat::background_tasks::group_document_lease(Some(&group_lease()));
    let child = prepared_tools(
        &root,
        "background-child",
        vec![
            crate::chat::background_tasks::resource_message_for_test(child_lease),
            identity(OWNER, None),
        ],
    )
    .await;
    assert!(
        child.iter().any(|tool| tool == CREATE_DOCUMENT_TOOL),
        "{child:?}"
    );
    assert!(!child.iter().any(|tool| tool == "gmail_send"), "{child:?}");

    // A lease without create_document: no tool and no guidance for it.
    let mut reader_lease = group_lease();
    reader_lease
        .connector_tools
        .as_mut()
        .unwrap()
        .retain(|tool| tool.name != CREATE_DOCUMENT_TOOL);
    let reader = prepared_tools(
        &root,
        &format!("cloud-agent:{OWNER}:{GROUP}:request:msg_reader"),
        vec![identity(OWNER, Some(reader_lease))],
    )
    .await;
    assert!(
        !reader.iter().any(|tool| tool == CREATE_DOCUMENT_TOOL),
        "{reader:?}"
    );
    assert!(
        reader.iter().any(|tool| tool == "read_document"),
        "{reader:?}"
    );
}

/// The real spawn path: the parent's runner starts the background task's
/// turn, and that turn is prepared with the parent's create_document.
#[tokio::test(flavor = "multi_thread")]
async fn a_spawned_background_task_is_prepared_with_create_document() {
    use kordi_cli::task_operator::{ChildAgentRunner, SpawnRequest};

    let storage = crate::test_support::ScopedKordiStorageRoot::new("group-document-spawn");
    let root = storage.root().to_path_buf();
    let (home, app, cwd) = (root.join("home"), root.join("app"), root.join("cwd"));
    for dir in [&home, &app, &cwd] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let _env = EnvGuard::set(&[
        ("HOME", home.into_os_string()),
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);
    crate::cloud_session::store_session_for_test(OWNER).unwrap();

    let manager = DesktopChatManager::default();
    let runner = crate::chat::background_tasks::ManagedChildAgentRunner::new(
        manager.clone(),
        GROUP.to_string(),
        Some("msg_synthetic".to_string()),
        kordi_cli::desktop_runtime::DesktopRuntimeProfile::default(),
    )
    .with_shared_context(true, None, Some(identity(OWNER, None)))
    .with_group_documents(crate::chat::background_tasks::group_document_lease(Some(
        &group_lease(),
    )));
    runner
        .spawn(SpawnRequest {
            task_path: "/root/document".into(),
            task_name: "document".into(),
            task_title: "Write the document".into(),
            message: "Write the launch plan document.".into(),
            fork_turns: Some("none".into()),
            write_scope: Vec::new(),
            cwd,
            parent_message_id: None,
            attachment_paths: Vec::new(),
        })
        .await
        .unwrap();

    // The turn ends at the missing model sign-in, after its preparation.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let turns: Vec<_> = manager.turns.lock().await.values().cloned().collect();
        let done = turns.iter().all(|turn| {
            turn.snapshot
                .lock()
                .map(|snapshot| snapshot.completed)
                .unwrap_or(true)
        });
        if done && !turns.is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the background turn did not end"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let sessions: Vec<_> = manager.sessions.lock().await.values().cloned().collect();
    assert_eq!(sessions.len(), 1);
    let mut child = sessions[0].lock().await;
    let tools = child.next_turn_tool_names().unwrap();
    assert!(
        tools.iter().any(|tool| tool == CREATE_DOCUMENT_TOOL),
        "{tools:?}"
    );
    assert!(!tools.iter().any(|tool| tool == "gmail_send"), "{tools:?}");
    assert!(child
        .next_turn_system_prompt()
        .contains("create it with create_document"));
}

/// The owner's own request on the Mac: the spawned background session gets
/// the parent turn's local tools (shell and file edits included), not the
/// read-only report set, and never task_operator.
#[tokio::test(flavor = "multi_thread")]
async fn an_owner_background_task_keeps_the_parent_local_tools() {
    use kordi_cli::task_operator::{ChildAgentRunner, SpawnRequest};

    let storage = crate::test_support::ScopedKordiStorageRoot::new("owner-background-tools");
    let root = storage.root().to_path_buf();
    let (home, app, cwd) = (root.join("home"), root.join("app"), root.join("cwd"));
    for dir in [&home, &app, &cwd] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let _env = EnvGuard::set(&[
        ("HOME", home.into_os_string()),
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);
    crate::cloud_session::store_session_for_test(OWNER).unwrap();

    let parent_session = format!("cloud-agent:{OWNER}:direct:request:msg_disk");
    let mut parent = DesktopRuntimeSession::create_with_id(cwd.clone(), &parent_session)
        .await
        .unwrap();
    let context = vec![identity(OWNER, None)];
    parent.sync_shared_context_messages(&context).unwrap();
    prepare_desktop_session_for_send(
        &DesktopChatManager::default(),
        &mut parent,
        cwd.clone(),
        "Review my disk usage.",
        (None, None),
        Some("msg_disk"),
        &context,
        (None, None),
    )
    .await
    .unwrap();
    let parent_tools = parent.next_turn_tool_names().unwrap();
    assert!(
        parent_tools.iter().any(|tool| tool == "bash"),
        "{parent_tools:?}"
    );

    let manager = DesktopChatManager::default();
    crate::chat::background_tasks::ManagedChildAgentRunner::new(
        manager.clone(),
        parent_session.clone(),
        Some("msg_disk".to_string()),
        kordi_cli::desktop_runtime::DesktopRuntimeProfile::default(),
    )
    .with_shared_context(false, None, Some(identity(OWNER, None)))
    .with_owner_local_tools(Some(parent_tools))
    .spawn(SpawnRequest {
        task_path: "/root/disk".into(),
        task_name: "disk".into(),
        task_title: "Review local disk usage".into(),
        message: "Measure the largest folders in the home directory.".into(),
        fork_turns: Some("none".into()),
        write_scope: Vec::new(),
        cwd,
        parent_message_id: None,
        attachment_paths: Vec::new(),
    })
    .await
    .unwrap();

    // The turn ends at the missing model sign-in, after its preparation.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !manager.turns.lock().await.values().all(|turn| {
        turn.snapshot
            .lock()
            .map(|snapshot| snapshot.completed)
            .unwrap_or(true)
    }) {
        assert!(
            std::time::Instant::now() < deadline,
            "the background turn did not end"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let sessions: Vec<_> = manager.sessions.lock().await.values().cloned().collect();
    assert_eq!(sessions.len(), 1);
    let mut child = sessions[0].lock().await;
    let tools = child.next_turn_tool_names().unwrap();
    for name in ["bash", "edit", "write", "read"] {
        assert!(tools.iter().any(|tool| tool == name), "{name}: {tools:?}");
    }
    assert!(
        !tools.iter().any(|tool| tool == "task_operator"),
        "{tools:?}"
    );
    assert!(!child
        .next_turn_system_prompt()
        .contains("Write scope: read-only"));
}
