use super::*;
use axum::body::to_bytes;
use axum::http::{Request, StatusCode};
use tempfile::TempDir;
use tower::util::ServiceExt;

#[test]
fn max_thinking_level_maps_to_cli_value() {
    assert_eq!(protocol_thinking_level(&ThinkingLevel::Max), "max");
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
