//! HTTP contract between the runner client and the Cloud server's runner
//! endpoints: the run-scoped credential issued with a lease is sent on that
//! run's requests only.

use std::sync::{Arc, Mutex};

use kordi_cloud_agent_runner::client::{
    CloudAgentRunClient, HttpCloudAgentRunClient, RUN_TOKEN_HEADER,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
struct RecordedRequest {
    path: String,
    authorization: Option<String>,
    run_token: Option<String>,
}

fn run_json(run_id: &str) -> Value {
    json!({
        "runId": run_id,
        "status": "leased",
        "prompt": "hello",
        "ownerAccountId": "acct_owner",
        "requesterAccountId": "acct_requester",
        "sessionId": "session:direct-person:a:b",
        "sandboxId": "cas_client_test",
        "providerAuthAvailable": true,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn handle(mut stream: TcpStream, recorded: Arc<Mutex<Vec<RecordedRequest>>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).await.unwrap();
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&buffer) {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let path = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_string();
    let mut authorization = None;
    let mut run_token = None;
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value),
            "content-length" => content_length = value.parse().unwrap_or(0),
            name if name == RUN_TOKEN_HEADER.to_ascii_lowercase() => run_token = Some(value),
            _ => {}
        }
    }
    while buffer.len() < header_end + 4 + content_length {
        let read = stream.read(&mut chunk).await.unwrap();
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    recorded.lock().unwrap().push(RecordedRequest {
        path: path.clone(),
        authorization,
        run_token,
    });
    let body = if path == "/v1/cloud/agent-runs/lease" {
        let mut run = run_json("car_a");
        run["runToken"] = json!("run-token-for-car-a");
        json!({ "run": run })
    } else if path.ends_with("/provider-auth") {
        json!({
            "providerAuth": {
                "snapshotId": "snap",
                "provider": "openai",
                "authChoice": "api-key",
                "payload": {}
            }
        })
    } else {
        json!({ "run": run_json("car_a") })
    }
    .to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    let _ = stream.shutdown().await;
}

async fn start_server() -> (String, Arc<Mutex<Vec<RecordedRequest>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let server_recorded = recorded.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(handle(stream, server_recorded.clone()));
        }
    });
    (base, recorded)
}

#[tokio::test]
async fn leased_run_requests_carry_that_runs_credential() {
    let (base, recorded) = start_server().await;
    let runner = HttpCloudAgentRunClient::new(
        base,
        "shared-runner-token".to_string(),
        "runner-a".to_string(),
    );
    let execution = runner.for_execution();

    let run = execution.lease_next_run().await.unwrap().unwrap();
    assert_eq!(run.run_id, "car_a");
    execution.mark_running("car_a").await.unwrap();
    execution.fetch_provider_auth("car_a").await.unwrap();

    let requests = recorded.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    for request in &requests {
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer shared-runner-token"),
            "{}",
            request.path
        );
    }
    assert_eq!(requests[0].path, "/v1/cloud/agent-runs/lease");
    assert_eq!(requests[0].run_token, None);
    assert_eq!(requests[1].path, "/v1/cloud/agent-runs/car_a/running");
    assert_eq!(
        requests[1].run_token.as_deref(),
        Some("run-token-for-car-a")
    );
    assert_eq!(requests[2].path, "/v1/cloud/agent-runs/car_a/provider-auth");
    assert_eq!(
        requests[2].run_token.as_deref(),
        Some("run-token-for-car-a")
    );
}

#[tokio::test]
async fn an_execution_never_sends_another_executions_run_credential() {
    let (base, recorded) = start_server().await;
    let runner = HttpCloudAgentRunClient::new(
        base,
        "shared-runner-token".to_string(),
        "runner-a".to_string(),
    );
    let leasing = runner.for_execution();
    let other = runner.for_execution();

    leasing.lease_next_run().await.unwrap().unwrap();
    other.mark_running("car_a").await.unwrap();
    leasing.mark_running("car_other").await.unwrap();

    let requests = recorded.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].path, "/v1/cloud/agent-runs/car_a/running");
    assert_eq!(requests[1].run_token, None);
    assert_eq!(requests[2].path, "/v1/cloud/agent-runs/car_other/running");
    assert_eq!(requests[2].run_token, None);
}
