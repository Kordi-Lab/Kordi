use super::*;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use chrono::Utc;
use kordi_core::types::{EntryBase, EntryId, UserMessage};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::util::ServiceExt;

#[test]
fn max_thinking_level_maps_to_cli_value() {
    assert_eq!(protocol_thinking_level(&ThinkingLevel::Max), "max");
}

#[derive(Clone)]
struct FakeBridgesStatusProvider {
    response: std::result::Result<BridgesStatusResponse, String>,
}

#[async_trait]
impl BridgesStatusProvider for FakeBridgesStatusProvider {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse> {
        self.response.clone().map_err(anyhow::Error::msg)
    }
}

#[derive(Clone, Default)]
struct FakeTurnExecutor {
    calls: Arc<Mutex<Vec<TurnExecution>>>,
    gate: Option<Arc<Notify>>,
}

#[async_trait]
impl TurnExecutor for FakeTurnExecutor {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()> {
        self.calls.lock().await.push(execution);
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        Ok(())
    }
}

fn test_server(
    cwd: PathBuf,
    sessions_db_path: PathBuf,
    bridges_status: std::result::Result<BridgesStatusResponse, String>,
    turn_executor: FakeTurnExecutor,
) -> AppServer {
    AppServer {
        state: Arc::new(AppState {
            cwd,
            sessions_db_path,
            bridges_status: Arc::new(FakeBridgesStatusProvider {
                response: bridges_status,
            }),
            turn_executor: Arc::new(turn_executor),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
        }),
    }
}

fn create_session_with_message(
    conn: &rusqlite::Connection,
    cwd: &str,
    name: &str,
    message: &str,
) -> String {
    let session_id = store::create_session(conn, cwd).expect("create session");
    store::set_session_name(conn, &session_id, Some(name)).expect("set session name");
    let entry = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: message.to_string(),
            }],
            timestamp: Utc::now().timestamp(),
        }),
    };
    store::append_entry(conn, &session_id, &entry).expect("append entry");
    session_id
}

fn sample_bridges_status() -> BridgesStatusResponse {
    BridgesStatusResponse {
        node_id: "kd_test".to_string(),
        healthy: true,
        daemon: BridgesDaemonStatus {
            state: "online".to_string(),
            started_at: "2026-04-19T00:00:00Z".to_string(),
        },
        coordination: BridgesComponentStatus {
            state: "healthy".to_string(),
            detail: Some("coord ok".to_string()),
            checked_at: "2026-04-19T00:01:00Z".to_string(),
        },
        runtime: BridgesComponentStatus {
            state: "healthy".to_string(),
            detail: Some("runtime ok".to_string()),
            checked_at: "2026-04-19T00:02:00Z".to_string(),
        },
        reachability: BridgesReachabilityStatus {
            mode: "direct_and_relay".to_string(),
            endpoint_hints_published: 1,
            derp_connected: true,
            mailbox_fallback: true,
            mailbox_durable: true,
        },
    }
}

#[tokio::test]
async fn bootstrap_reports_workspace_and_services() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let session_id =
        create_session_with_message(&conn, &cwd_str, "First session", "hello from bootstrap");

    let app = test_server(
        cwd.clone(),
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/bootstrap")
                .header("x-kordi-client-kind", "tui")
                .header("x-kordi-client-name", "test-tui")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let snapshot: BootstrapSnapshot = serde_json::from_slice(&body).expect("bootstrap json");

    assert_eq!(snapshot.server.protocol_version, APP_PROTOCOL_VERSION);
    assert_eq!(snapshot.client.client_kind, ClientKind::Tui);
    assert_eq!(snapshot.client.client_name, "test-tui");
    assert_eq!(snapshot.services.runtime.state, ServiceState::Ready);
    assert_eq!(snapshot.services.bridges.state, ServiceState::Ready);
    assert_eq!(
        snapshot.current_session_id.as_deref(),
        Some(session_id.as_str())
    );
}

#[tokio::test]
async fn sessions_endpoint_reads_existing_session_store() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    create_session_with_message(&conn, &cwd_str, "Alpha", "first preview");
    create_session_with_message(&conn, &cwd_str, "Beta", "second preview");

    let app = test_server(
        cwd,
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/sessions?limit=1")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let page: SessionsPage = serde_json::from_slice(&body).expect("sessions json");

    assert_eq!(page.items.len(), 1);
    assert!(page.next_cursor.is_none());
    assert_eq!(page.items[0].source, SessionSource::Local);
    assert_eq!(page.items[0].status, SessionStatus::Idle);
    assert!(
        page.items[0]
            .last_message_preview
            .as_deref()
            .unwrap_or_default()
            .contains("preview")
    );
}

#[tokio::test]
async fn session_detail_exposes_entries_and_lineage() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let source_session_id = create_session_with_message(&conn, &cwd_str, "Source", "fork me");
    let source_entry_id = store::get_entries(&conn, &source_session_id)
        .expect("entries")
        .first()
        .expect("entry")
        .entry_id
        .clone();
    let forked =
        store::fork_session_from_entry(&conn, &source_session_id, &source_entry_id, &cwd_str)
            .expect("fork session");

    let app = test_server(
        cwd,
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/sessions/{}", forked.session_id))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
    let detail: SessionDetail = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("detail json");

    assert_eq!(detail.session.session_id, forked.session_id);
    assert_eq!(
        detail.session.parent_session_id.as_deref(),
        Some(source_session_id.as_str())
    );
    assert_eq!(
        detail.session.parent_session_message_id.as_deref(),
        Some(source_entry_id.as_str())
    );
    assert_eq!(detail.entries.len(), 1);
    assert_eq!(detail.entries[0].entry_id, source_entry_id);
}

#[tokio::test]
async fn fork_endpoint_creates_fork_and_lists_it_under_source() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let source_session_id = create_session_with_message(&conn, &cwd_str, "Source", "make a fork");
    let source_entry_id = store::get_entries(&conn, &source_session_id)
        .expect("entries")
        .first()
        .expect("entry")
        .entry_id
        .clone();

    let app = test_server(
        cwd,
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/sessions/{source_session_id}/forks"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_entry_id": source_entry_id,
                        "title": "Forked task",
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::CREATED);
    let forked: ForkSessionResponse = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("fork json");
    assert_ne!(forked.session.session_id, source_session_id);
    assert_eq!(forked.session.title, "Forked task");
    assert_eq!(
        forked.session.parent_session_id.as_deref(),
        Some(source_session_id.as_str())
    );
    assert_eq!(
        forked.session.parent_session_message_id.as_deref(),
        Some(source_entry_id.as_str())
    );

    let list_response = app
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/sessions/{source_session_id}/forks"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(list_response.status(), StatusCode::OK);
    let forks: SessionForksPage = serde_json::from_slice(
        &to_bytes(list_response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("fork list json");
    assert_eq!(forks.items.len(), 1);
    assert_eq!(forks.items[0].session_id, forked.session.session_id);
}

#[tokio::test]
async fn fork_endpoint_rejects_unknown_source_entry() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let source_session_id = create_session_with_message(&conn, &cwd_str, "Source", "ready");

    let app = test_server(
        cwd,
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/sessions/{source_session_id}/forks"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "source_entry_id": "missing-entry" }).to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn submit_turn_accepts_existing_session_and_marks_it_running() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let session_id = create_session_with_message(&conn, &cwd_str, "Alpha", "ready");
    let gate = Arc::new(Notify::new());
    let executor = FakeTurnExecutor {
        calls: Arc::new(Mutex::new(Vec::new())),
        gate: Some(gate.clone()),
    };

    let app = test_server(cwd, db_path, Ok(sample_bridges_status()), executor.clone());

    let response = app
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/sessions/{session_id}/turns"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&SubmitTurnRequest {
                        session_id: Some(session_id.clone()),
                        title: Some("Renamed session".to_string()),
                        input: "Ship it".to_string(),
                        cwd: None,
                        project_id: None,
                        peer_id: None,
                        model: Some(ModelSelector {
                            provider: Some("openai".to_string()),
                            model_id: "gpt-5.4-mini".to_string(),
                            reasoning: Some(ThinkingLevel::Low),
                        }),
                        thinking: Some(ThinkingLevel::Medium),
                        new_session: None,
                        attachments: None,
                    })
                    .expect("request json"),
                ))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: SubmitTurnAccepted = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("accepted json");
    assert_eq!(accepted.session_id, session_id);

    wait_for_turn_calls(&executor, 1).await;

    let response = app
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/sessions?limit=1")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let page: SessionsPage = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("sessions json");

    assert_eq!(page.items[0].status, SessionStatus::Running);
    assert_eq!(page.items[0].title, "Renamed session");

    let calls = executor.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].input, "Ship it");
    assert_eq!(calls[0].session_id, session_id);
    drop(calls);

    gate.notify_waiters();
}

#[tokio::test]
async fn submit_turn_rejects_concurrent_turns_for_the_same_session() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let conn = store::open_db(&db_path).expect("open db");
    let cwd_str = cwd.display().to_string();
    let session_id = store::create_session(&conn, &cwd_str).expect("create session");
    let gate = Arc::new(Notify::new());
    let executor = FakeTurnExecutor {
        calls: Arc::new(Mutex::new(Vec::new())),
        gate: Some(gate.clone()),
    };

    let app = test_server(cwd, db_path, Ok(sample_bridges_status()), executor.clone());

    let first = submit_turn_request(
        &app,
        &session_id,
        "diagnose memory leak in the Node process",
    )
    .await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    wait_for_turn_calls(&executor, 1).await;
    let accepted_title = store::get_session(&conn, &session_id)
        .expect("read accepted session")
        .expect("accepted session exists");
    assert_eq!(accepted_title.title_source, store::SessionTitleSource::Auto);
    assert_eq!(accepted_title.title_revision, 1);

    let second =
        submit_turn_request(&app, &session_id, "plan the release validation changes").await;
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let rejected_title = store::get_session(&conn, &session_id)
        .expect("read rejected session")
        .expect("rejected session exists");
    assert_eq!(rejected_title.name, accepted_title.name);
    assert_eq!(rejected_title.title_source, accepted_title.title_source);
    assert_eq!(rejected_title.title_revision, accepted_title.title_revision);

    gate.notify_waiters();
}

#[tokio::test]
async fn submit_turn_rejects_unknown_session() {
    let temp = TempDir::new().expect("tempdir");
    let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
    let db_path = temp.path().join("sessions.db");
    let app = test_server(
        cwd,
        db_path,
        Ok(sample_bridges_status()),
        FakeTurnExecutor::default(),
    );

    let response = submit_turn_request(&app, "missing-session", "Hello").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

async fn submit_turn_request(
    app: &AppServer,
    session_id: &str,
    input: &str,
) -> axum::http::Response<Body> {
    app.router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/sessions/{session_id}/turns"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&SubmitTurnRequest {
                        session_id: None,
                        title: None,
                        input: input.to_string(),
                        cwd: None,
                        project_id: None,
                        peer_id: None,
                        model: None,
                        thinking: None,
                        new_session: None,
                        attachments: None,
                    })
                    .expect("request json"),
                ))
                .expect("request"),
        )
        .await
        .expect("response")
}

async fn wait_for_turn_calls(executor: &FakeTurnExecutor, expected: usize) {
    for _ in 0..50 {
        if executor.calls.lock().await.len() >= expected {
            return;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {expected} turn calls");
}
