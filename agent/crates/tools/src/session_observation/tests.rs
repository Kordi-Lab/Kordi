use super::*;
use crate::{SessionObservationRuntime, Tool, ToolContext};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

fn ctx_with_runtime(runtime: Option<SessionObservationRuntime>) -> ToolContext {
    ToolContext {
        cwd: PathBuf::from("/tmp"),
        artifacts_dir: PathBuf::from("/tmp/artifacts"),
        model: None,
        execution_policy: crate::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: runtime,
        task_operator: None,
        schedule_task: None,
        plan_card: None,
        execution_mode: crate::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

#[test]
fn tool_descriptions_cover_implicit_session_questions() {
    let search_description = SearchSessionsTool.description();
    assert!(search_description.contains("prior chats"));
    assert!(search_description.contains("participants"));
    assert!(search_description.contains("chat counts"));
    assert!(search_description.contains("session ids"));
    assert!(search_description.contains("includeMessages is true"));

    let read_description = ReadSessionTool.description();
    assert!(read_description.contains("message ids"));
    assert!(read_description.contains("messageIds"));
}

#[tokio::test]
async fn search_sessions_rejects_empty_query() {
    let tool = SearchSessionsTool;
    let error = tool
        .execute(
            json!({"query":"   "}),
            &ctx_with_runtime(None),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("empty query should fail");
    assert!(error.to_string().contains("query cannot be empty"));
}

#[tokio::test]
async fn search_sessions_requires_runtime() {
    let tool = SearchSessionsTool;
    let error = tool
        .execute(
            json!({"query":"launch"}),
            &ctx_with_runtime(None),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("missing runtime should fail");
    assert!(
        error
            .to_string()
            .contains("session observation is unavailable")
    );
}

#[tokio::test]
async fn search_sessions_calls_runtime_with_capped_limit() {
    let captured = Arc::new(Mutex::new(Vec::<crate::SearchSessionsRequest>::new()));
    let captured_clone = captured.clone();
    let runtime = SessionObservationRuntime {
        calendar: None,
        search_sessions: Arc::new(move |request| {
            captured_clone.lock().expect("captured").push(request);
            Box::pin(async {
                Ok(crate::SearchSessionsResponse {
                    next_before_sequence: None,
                    sessions: vec![crate::SessionObservationSearchResult {
                        session_id: "session:launch".to_string(),
                        title: "Launch".to_string(),
                        kind: "group".to_string(),
                        participants: vec!["Alice".to_string()],
                        updated_at_label: Some("Today".to_string()),
                        reason: "Matched title".to_string(),
                        snippets: vec![crate::SessionObservationSnippet {
                            message_id: "msg:1".to_string(),
                            sender: "Alice".to_string(),
                            text: "Launch note".to_string(),
                            time_label: Some("13:04".to_string()),
                        }],
                    }],
                })
            })
        }),
        read_session: Arc::new(|_| Box::pin(async { unreachable!("not used") })),
    };

    let result = SearchSessionsTool
        .execute(
            json!({"query":" launch ", "limit": 99}),
            &ctx_with_runtime(Some(runtime)),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("search result");
    assert!(
        result
            .content
            .iter()
            .any(|block| format!("{block:?}").contains("Launch"))
    );
    assert_eq!(captured.lock().expect("captured")[0].query, "launch");
    assert_eq!(
        captured.lock().expect("captured")[0].limit,
        Some(MAX_SEARCH_SESSIONS_LIMIT)
    );
}

#[tokio::test]
async fn read_session_forwards_progressive_disclosure_params() {
    let captured = Arc::new(Mutex::new(Vec::<crate::ReadSessionRequest>::new()));
    let captured_clone = captured.clone();
    let runtime = SessionObservationRuntime {
        calendar: None,
        search_sessions: Arc::new(|_| Box::pin(async { unreachable!("not used") })),
        read_session: Arc::new(move |request| {
            captured_clone.lock().expect("captured").push(request);
            Box::pin(async {
                Ok(crate::ReadSessionResponse {
                    next_before_sequence: None,
                    media: Vec::new(),
                    directory: None,
                    session: crate::SessionObservationReadSession {
                        session_id: "session:launch".to_string(),
                        title: "Launch".to_string(),
                        kind: "group".to_string(),
                        participants: Vec::new(),
                    },
                    window: crate::SessionObservationWindow {
                        around_message_id: None,
                        has_more_before: false,
                        has_more_after: false,
                    },
                    messages: vec![crate::SessionObservationMessage {
                        attachments: Vec::new(),
                        next_offset: None,
                        message_id: "msg:2".to_string(),
                        sender: "Bob".to_string(),
                        role: "person".to_string(),
                        sequence_num: 1,
                        text: Some("The canary deploy is ready".to_string()),
                        time_label: Some("13:04".to_string()),
                    }],
                })
            })
        }),
    };

    ReadSessionTool
        .execute(
            json!({
                "sessionId":" session:launch ",
                "mode":"messages",
                "messageIds":["msg:2", " "],
                "limit": 99
            }),
            &ctx_with_runtime(Some(runtime)),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("read session result");

    let request = &captured.lock().expect("captured")[0];
    assert_eq!(request.session_id, "session:launch");
    assert_eq!(request.mode.as_deref(), Some("messages"));
    assert_eq!(request.message_ids, Some(vec!["msg:2".to_string()]));
    assert_eq!(request.limit, Some(MAX_READ_SESSION_LIMIT));
}

#[tokio::test]
async fn read_session_requires_session_id() {
    let error = ReadSessionTool
        .execute(
            json!({"sessionId":"   "}),
            &ctx_with_runtime(None),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("blank session id should fail");
    assert!(error.to_string().contains("sessionId cannot be empty"));
}
#[tokio::test]
async fn image_reads_return_media_without_copying_bytes_into_diagnostic_details() {
    use base64::Engine;
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.get_ref());
    let image = encoded.clone();
    let runtime = SessionObservationRuntime {
        calendar: None,
        search_sessions: Arc::new(|_| Box::pin(async { unreachable!() })),
        read_session: Arc::new(move |request| {
            assert_eq!(request.attachment_id.as_deref(), Some("image"));
            assert_eq!(request.expected_version, Some(2));
            let image = image.clone();
            Box::pin(async move {
                Ok(crate::ReadSessionResponse {
                    next_before_sequence: None,
                    media: vec![kordi_core::types::ContentBlock::Image {
                        data: image,
                        mime_type: "image/png".into(),
                    }],
                    directory: None,
                    session: crate::SessionObservationReadSession {
                        session_id: "group".into(),
                        title: "Group".into(),
                        kind: "group".into(),
                        participants: vec![],
                    },
                    window: crate::SessionObservationWindow {
                        around_message_id: None,
                        has_more_before: false,
                        has_more_after: false,
                    },
                    messages: vec![],
                })
            })
        }),
    };
    let result=ReadSessionTool.execute(json!({"sessionId":"group","mode":"attachment","messageIds":["message"],"attachmentId":"image","expectedVersion":2}),&ctx_with_runtime(Some(runtime)),tokio_util::sync::CancellationToken::new()).await.unwrap();
    assert!(
        matches!(&result.content[1],kordi_core::types::ContentBlock::Image {data,..} if data==&encoded)
    );
    assert!(!result.details.unwrap().to_string().contains(&encoded));
}
