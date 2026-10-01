//! The desktop calendar tool waits for the owner's approval against a local
//! server stub, and only shared calendar data closes other tools.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

use super::*;

/// Serves one canned JSON body per connection, in order, and counts requests.
fn serve(bodies: Vec<Value>) -> (String, Arc<AtomicUsize>, Arc<std::sync::Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let addr = listener.local_addr().expect("stub addr");
    let served = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (count, seen) = (served.clone(), requests.clone());
    std::thread::spawn(move || {
        for body in bodies {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let request_body = loop {
                let Ok(read) = stream.read(&mut chunk) else {
                    break None;
                };
                if read == 0 {
                    break None;
                }
                buffer.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                let Some(split) = text.find("\r\n\r\n") else {
                    continue;
                };
                let length = text[..split]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if buffer.len() >= split + 4 + length {
                    break serde_json::from_slice::<Value>(&buffer[split + 4..split + 4 + length])
                        .ok();
                }
            };
            if let Some(request_body) = request_body {
                seen.lock().unwrap().push(request_body);
            }
            count.fetch_add(1, Ordering::SeqCst);
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (format!("http://{addr}"), served, requests)
}

fn quick() -> CalendarApprovalWait {
    CalendarApprovalWait {
        interval: Duration::from_millis(10),
        timeout: Duration::from_millis(200),
    }
}

fn shared() -> Option<(String, String)> {
    Some(("session:group:fixture".into(), "request-1".into()))
}

fn context(calendar: CalendarRuntime) -> ToolContext {
    ToolContext {
        cwd: std::env::temp_dir(),
        artifacts_dir: std::env::temp_dir(),
        model: None,
        execution_policy: crate::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: Some(crate::SessionObservationRuntime {
            calendar: Some(calendar),
            search_sessions: Arc::new(|_| Box::pin(async { unreachable!() })),
            read_session: Arc::new(|_| Box::pin(async { unreachable!() })),
        }),
        task_operator: None,
        schedule_task: None,
        execution_mode: crate::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

async fn read(runtime: &CalendarRuntime) -> ToolResult {
    ReadCalendarTool
        .execute(
            json!({"shareInConversation": true, "startAt": "2026-10-02T00:00:00Z"}),
            &context(runtime.clone()),
            CancellationToken::new(),
        )
        .await
        .expect("calendar tool result")
}

fn text(result: &ToolResult) -> String {
    match &result.content[0] {
        kordi_core::types::ContentBlock::Text { text } => text.clone(),
        _ => panic!("text content"),
    }
}

#[tokio::test]
async fn reads_repeat_until_the_owner_approves_and_shared_data_closes_other_tools() {
    let waiting = json!({"status": "approval_required", "pendingActionId": "a1",
        "message": "Waiting for Olive.", "timeoutMessage": "Olive has not approved."});
    let data = json!({"status": "ready", "scope": "owner_requested_shared_read",
        "events": [{"title": "Saved appointment"}]});
    let (base, served, requests) = serve(vec![waiting.clone(), waiting, data.clone()]);
    let runtime = http_runtime_with_wait(base, "token".into(), shared(), quick());
    let result = read(&runtime).await;
    assert_eq!(result.details, Some(data));
    assert_eq!(served.load(Ordering::SeqCst), 3);
    assert!(runtime.disclosed.load(Ordering::SeqCst));
    let requests = requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .all(|body| body["sessionId"] == "session:group:fixture"
                && body["requestMessageId"] == "request-1"
                && body["startAt"] == "2026-10-02T00:00:00Z")
    );
}

#[tokio::test]
async fn an_unanswered_request_times_out_with_the_owner_text() {
    let waiting = json!({"status": "approval_required", "pendingActionId": "a1",
        "message": "Waiting for Olive.", "timeoutMessage": "Olive has not approved sharing."});
    let (base, served, _) = serve(vec![waiting; 200]);
    let runtime = http_runtime_with_wait(base, "token".into(), shared(), quick());
    let result = read(&runtime).await;
    assert_eq!(text(&result), "Olive has not approved sharing.");
    assert!(result.details.is_none());
    assert!(served.load(Ordering::SeqCst) >= 2);
    assert!(!runtime.disclosed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_decline_and_private_reads_do_not_close_other_tools() {
    let (base, _, _) = serve(vec![json!({"status": "declined",
        "message": "Olive chose not to share their calendar in this chat."})]);
    let runtime = http_runtime_with_wait(base, "token".into(), shared(), quick());
    assert_eq!(
        text(&read(&runtime).await),
        "Olive chose not to share their calendar in this chat."
    );
    assert!(!runtime.disclosed.load(Ordering::SeqCst));

    let private = json!({"status": "ready", "scope": "private_owner_read", "events": []});
    let (base, _, _) = serve(vec![private.clone()]);
    let runtime = http_runtime_with_wait(base, "token".into(), None, quick());
    let result = ReadCalendarTool
        .execute(
            json!({}),
            &context(runtime.clone()),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.details, Some(private));
    assert!(!runtime.disclosed.load(Ordering::SeqCst));
}

#[test]
fn only_saved_data_read_for_sharing_counts_as_disclosed() {
    for (value, disclosed) in [
        (
            json!({"status": "ready", "scope": "owner_requested_shared_read"}),
            true,
        ),
        (
            json!({"status": "empty", "scope": "owner_requested_shared_read"}),
            true,
        ),
        (
            json!({"status": "approval_required", "scope": "owner_requested_shared_read"}),
            false,
        ),
        (json!({"status": "declined"}), false),
        (
            json!({"status": "ready", "scope": "private_owner_read"}),
            false,
        ),
    ] {
        assert_eq!(is_shared_calendar_data(&value), disclosed, "{value}");
    }
}
