use super::tests::{EchoTool, NoEvents, request};
use super::*;

fn shell(script: &str) -> WorkerCommand {
    WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    }
}

async fn run(script: &str, request: &RunRequest) -> Result<RunResult, RuntimeError> {
    OmpRuntime::new(shell(script))
        .run_turn(request, &EchoTool, &NoEvents, CancellationToken::new())
        .await
}

#[cfg(unix)]
#[tokio::test]
async fn long_run_output_is_not_a_cumulative_budget() {
    // 400 progress frames of about 150 bytes each far exceed the 4 KiB
    // frame limit in total, as a long agent run's stream does.
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
i=1
while [ $i -le 400 ]; do
  printf '{"type":"event","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":%d,"event":{"kind":"text_delta","delta":"progress progress progress"}}\n' $i
  i=$((i+1))
done
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":401,"text":"done"}'
"#;
    let mut request = request();
    request.limits.max_output_bytes = 4096;
    assert_eq!(run(script, &request).await.unwrap().text, "done");
}

#[cfg(unix)]
#[tokio::test]
async fn one_oversized_frame_reports_the_output_limit() {
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
text=$(head -c 5000 /dev/zero | tr '\0' 'x')
printf '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"text":"%s"}\n' "$text"
"#;
    let mut request = request();
    request.limits.max_output_bytes = 4096;
    assert_eq!(
        run(script, &request).await.err(),
        Some(RuntimeError::OutputLimit)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn sequence_gap_is_diagnosable_without_content() {
    // The frames an older worker wrote when it dropped an oversized result:
    // the error frame skipped the dropped frame's sequence number.
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"event","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"event":{"kind":"status","status":"running"}}'
printf '%s\n' '{"type":"error","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":3,"code":"output_limit","message":"Run reached its output limit."}'
"#;
    let error = run(script, &request()).await.err().unwrap();
    assert_eq!(error, RuntimeError::Protocol(ProtocolViolation::Sequence));
    assert_eq!(error.diagnostic_code(), "protocol_sequence");
    assert_eq!(
        error.to_string(),
        "The agent returned an invalid response. Try again."
    );
}

#[cfg(unix)]
#[tokio::test]
async fn host_does_not_count_tool_or_hook_calls() {
    let mut script =
        String::from("read request\nprintf '%s\\n' '{\"type\":\"ready\",\"schemaVersion\":1}'\n");
    let mut sequence = 0;
    for index in 1..=80 {
        sequence += 1;
        script.push_str(&format!(
            "printf '%s\\n' '{{\"type\":\"hook_call\",\"schemaVersion\":1,\"runId\":\"run-1\",\"attemptId\":\"attempt-1\",\"sequence\":{sequence},\"callId\":\"hook-{index}\",\"name\":\"context\",\"input\":{{\"messages\":[]}}}}'\nread reply\n"
        ));
        sequence += 1;
        script.push_str(&format!(
            "printf '%s\\n' '{{\"type\":\"tool_call\",\"schemaVersion\":1,\"runId\":\"run-1\",\"attemptId\":\"attempt-1\",\"sequence\":{sequence},\"callId\":\"call-{index}\",\"name\":\"echo\",\"input\":{{}}}}'\nread reply\n"
        ));
    }
    sequence += 1;
    script.push_str(&format!(
        "printf '%s\\n' '{{\"type\":\"result\",\"schemaVersion\":1,\"runId\":\"run-1\",\"attemptId\":\"attempt-1\",\"sequence\":{sequence},\"text\":\"done\"}}'\n"
    ));
    let mut request = request();
    request.hooks = vec!["context".into()];
    // Even a host that still passes the optional caps never turns a long,
    // valid run into an invalid response; the worker reports its own limits.
    request.limits.max_steps = Some(4);
    request.limits.max_tool_calls = Some(4);
    assert_eq!(run(&script, &request).await.unwrap().text, "done");
}

#[cfg(unix)]
#[tokio::test]
async fn provider_failure_shows_the_cleaned_provider_reason() {
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"error","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"code":"provider_http_429","message":"The selected provider could not complete this request.","providerReason":"Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded) Bearer abc123secret"}'
"#;
    let error = run(script, &request()).await.err().unwrap();
    assert_eq!(error.diagnostic_code(), "provider_http_429");
    // Servers classify the plain text and other people may read it: no provider text.
    assert_eq!(
        error.to_string(),
        "The provider is busy or rate-limited. Try again shortly."
    );
    assert_eq!(
        error.with_provider_reason(),
        "The provider is busy or rate-limited. Try again shortly. Provider response: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded) Bearer [hidden]"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_reason_on_a_non_provider_code_is_ignored() {
    let script = r#"read request
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"error","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"code":"hook_error","message":"Hook failed.","providerReason":"private hook detail"}'
"#;
    assert_eq!(
        run(script, &request()).await.err(),
        Some(RuntimeError::Worker("hook_error".into()))
    );
}

#[test]
fn diagnostic_codes_are_fixed_identifiers() {
    for error in [
        RuntimeError::Protocol(ProtocolViolation::MalformedFrame),
        RuntimeError::Protocol(ProtocolViolation::PendingCallbacks),
        RuntimeError::OutputLimit,
        RuntimeError::Worker("provider_http_429".into()),
        RuntimeError::Provider {
            code: "provider_error".into(),
            reason: "Provider text".into(),
        },
    ] {
        let code = error.diagnostic_code();
        assert!(!code.is_empty() && code.len() <= 64);
        assert!(
            code.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        );
    }
}
