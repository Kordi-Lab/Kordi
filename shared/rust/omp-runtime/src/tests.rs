use super::*;
use serde_json::json;
use std::sync::Arc;

fn request() -> RunRequest {
    RunRequest {
        run_id: "run-1".into(),
        request_id: "request-1".into(),
        attempt_id: "attempt-1".into(),
        session_id: "session-1".into(),
        model: ModelConfig {
            provider: "test".into(),
            id: "test-model".into(),
            api: Some("openai-completions".into()),
            base_url: Some("http://127.0.0.1:1".into()),
            context_window: None,
            max_tokens: None,
        },
        auth: AuthConfig {
            kind: AuthKind::None,
            credential: None,
            headers: None,
        },
        thinking: None,
        system_prompt: "Test".into(),
        messages: vec![],
        message_entry_ids: Some(vec![]),
        prompt: Prompt {
            text: "Hello".into(),
            resume: false,
            entry_id: Some("user-1".into()),
            images: vec![],
            trailing_messages: vec![],
        },
        cwd: "/tmp".into(),
        tools: vec![ToolDefinition {
            name: "echo".into(),
            description: "Echo".into(),
            input_schema: json!({"type":"object"}),
        }],
        hooks: vec![],
        limits: RunLimits::default(),
        compaction: None,
        capabilities: Capabilities::default(),
    }
}

struct EchoTool;
#[async_trait]
impl HostTool for EchoTool {
    async fn execute(&self, call: ToolCall, _: CancellationToken) -> ToolResult {
        ToolResult {
            ok: true,
            content: vec![json!({"type":"text","text":call.input.to_string()})],
            details: None,
        }
    }
}
struct NoEvents;
#[async_trait]
impl EventSink for NoEvents {
    async fn on_event(&self, _: RuntimeEvent) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn run_command_is_flat_and_contains_no_ambient_auth() {
    let request = request();
    let value = serde_json::to_value(WorkerInput::Run {
        schema_version: SCHEMA_VERSION,
        request: &request,
    })
    .unwrap();
    assert_eq!(value["type"], "run");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["runId"], "run-1");
    assert_eq!(value["prompt"]["entryId"], "user-1");
    assert_eq!(value["auth"]["kind"], "none");
    assert!(value["auth"].get("credential").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn supervises_tool_handshake_and_rejects_stale_result() {
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"tool_call","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"callId":"call-1","name":"echo","input":{"hello":"world"}}'
read reply
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":2,"text":"done","messages":[],"checkpoint":{"firstKeptMessageIndex":0,"firstKeptEntryId":"user-1"}}'
"#;
    let command = WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    };
    let result = OmpRuntime::new(command)
        .run_turn(&request(), &EchoTool, &NoEvents, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.text, "done");
    assert_eq!(
        result.checkpoint.unwrap().first_kept_entry_id.as_deref(),
        Some("user-1")
    );

    let stale = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"old-attempt","sequence":1,"text":"wrong"}'
"#;
    let command = WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), stale.into()],
        computer_lock_path: None,
    };
    assert!(matches!(
        OmpRuntime::new(command)
            .run_turn(&request(), &EchoTool, &NoEvents, CancellationToken::new())
            .await,
        Err(RuntimeError::Protocol)
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn processes_worker_events_while_host_tool_is_running() {
    struct WaitForEvent(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl HostTool for WaitForEvent {
        async fn execute(&self, _: ToolCall, _: CancellationToken) -> ToolResult {
            self.0.notified().await;
            ToolResult {
                ok: true,
                content: vec![json!({"type":"text","text":"ok"})],
                details: None,
            }
        }
    }
    struct SignalEvent(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl EventSink for SignalEvent {
        async fn on_event(&self, _: RuntimeEvent) -> Result<(), String> {
            self.0.notify_one();
            Ok(())
        }
    }
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"tool_call","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"callId":"call-1","name":"echo","input":{}}'
printf '%s\n' '{"type":"event","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":2,"event":{"kind":"status","status":"running"}}'
read reply
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":3,"text":"done"}'
"#;
    let command = WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    };
    let signal = Arc::new(tokio::sync::Notify::new());
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        OmpRuntime::new(command).run_turn(
            &request(),
            &WaitForEvent(signal.clone()),
            &SignalEvent(signal),
            CancellationToken::new(),
        ),
    )
    .await
    .expect("worker and host tool must not deadlock")
    .unwrap();
    assert_eq!(result.text, "done");
}

/// Run with KORDI_OMP_WORKER_SCRIPT=<absolute worker.ts path>. This
/// intentionally selects an unknown model so no provider request occurs.
#[tokio::test]
#[ignore]
async fn bun_worker_protocol_smoke_without_network() {
    let script = std::env::var_os("KORDI_OMP_WORKER_SCRIPT").expect("worker script path");
    let mut request = request();
    request.model.provider = "kordi-synthetic-unknown".into();
    request.model.api = None;
    request.model.base_url = None;
    request.auth.kind = AuthKind::ApiKey;
    request.auth.credential = Some("synthetic-test-only".into());
    let command = WorkerCommand {
        program: "bun".into(),
        args: vec!["run".into(), script],
        computer_lock_path: None,
    };
    let result = OmpRuntime::new(command)
        .run_turn(&request, &EchoTool, &NoEvents, CancellationToken::new())
        .await;
    assert!(matches!(result, Err(RuntimeError::Worker(code)) if code == "model_unavailable"));
}

#[cfg(unix)]
#[tokio::test]
async fn computer_use_lock_serializes_workers_and_releases_on_completion() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "kordi-omp-lock-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lock = root.join("computer.lock");
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
sleep 1
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"text":"done"}'
"#;
    let command = WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    }
    .with_computer_lock(&lock);
    let mut first_request = request();
    first_request.capabilities = Capabilities {
        owner_local: true,
        computer: true,
        browser: false,
    };
    let first = tokio::spawn({
        let runtime = OmpRuntime::new(command.clone());
        let request = first_request.clone();
        async move {
            runtime
                .run_turn(&request, &EchoTool, &NoEvents, CancellationToken::new())
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut blocked_request = first_request.clone();
    blocked_request.limits.timeout_ms = 100;
    let blocked = OmpRuntime::new(command.clone())
        .run_turn(
            &blocked_request,
            &EchoTool,
            &NoEvents,
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(blocked, Err(RuntimeError::Timeout)));
    assert_eq!(first.await.unwrap().unwrap().text, "done");
    let mut final_request = first_request;
    final_request.limits.timeout_ms = 2_000;
    assert_eq!(
        OmpRuntime::new(command)
            .run_turn(
                &final_request,
                &EchoTool,
                &NoEvents,
                CancellationToken::new()
            )
            .await
            .unwrap()
            .text,
        "done"
    );
    std::fs::remove_file(&lock).unwrap();
    std::fs::remove_dir(&root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn only_explicitly_requested_hooks_can_round_trip() {
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"hook_call","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"callId":"hook-1","name":"context","input":{"messages":[]}}'
read reply
case "$reply" in *hook_result*) ;; *) exit 2 ;; esac
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":2,"text":"done"}'
"#;
    let command = WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    };
    let mut allowed = request();
    allowed.hooks = vec!["context".into()];
    assert_eq!(
        OmpRuntime::new(command.clone())
            .run_turn(&allowed, &EchoTool, &NoEvents, CancellationToken::new())
            .await
            .unwrap()
            .text,
        "done"
    );
    let denied = request();
    assert!(matches!(
        OmpRuntime::new(command)
            .run_turn(&denied, &EchoTool, &NoEvents, CancellationToken::new())
            .await,
        Err(RuntimeError::Protocol)
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn worker_cleanup_kills_descendants_after_leader_exits() {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "sleep 30 & exit 0"])
        .stdout(Stdio::piped())
        .process_group(0);
    let mut guard = ChildGuard::new(command.spawn().unwrap());
    let mut stdout = guard.0.stdout.take().unwrap();
    guard.0.wait().await.unwrap();
    drop(guard);

    // The descendant inherited stdout. EOF proves it no longer holds the pipe
    // after the already-exited leader's guard is dropped.
    let mut output = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), stdout.read_to_end(&mut output))
        .await
        .expect("worker descendant survived its leader")
        .unwrap();
}
