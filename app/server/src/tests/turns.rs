use super::*;
use axum::body::to_bytes;
use axum::http::{Request, StatusCode};
use tempfile::TempDir;
use tower::util::ServiceExt;

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
