use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::timeout,
};

const TOKEN: &str = "synthetic-fly-api-token-never-in-manifest";
const NONCE: &str = "synthetic-lease-nonce";
#[derive(Clone)]
struct Request {
    method: String,
    path: String,
    body: Value,
    leased: bool,
}
struct MockState {
    machine: Option<Value>,
    requests: Vec<Request>,
    ambiguous_create: bool,
    start_wait_failure: Option<Value>,
}
struct Mock {
    api: Api,
    state: Arc<Mutex<MockState>>,
    task: JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn config() -> DeploymentConfig {
    DeploymentConfig {
        actor_id: "synthetic-actor".into(),
        image: format!("registry.example.invalid/worker@sha256:{}", "a".repeat(64)),
        api_base: "https://simulator.example.invalid/".into(),
        backend: Backend::Fly {
            app: "synthetic-app".into(),
            region: "ord".into(),
            actor_token_secret: "ACTOR_TOKEN_REFERENCE".into(),
            account_token_secret: Some("ACCOUNT_TOKEN_REFERENCE".into()),
            account_email_secret: None,
            account_password_secret: None,
        },
    }
}
fn machine(config: &DeploymentConfig, state: &str) -> Value {
    let mut value = config.manifest();
    value["id"] = json!("machine-1");
    value["instance_id"] = json!("instance-1");
    value["state"] = json!(state);
    value
}
async fn mock(initial: Option<Value>, ambiguous_create: bool) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!(
        "http://{}/v1/apps/synthetic-app",
        listener.local_addr().unwrap()
    );
    let state = Arc::new(Mutex::new(MockState {
        machine: initial,
        requests: Vec::new(),
        ambiguous_create,
        start_wait_failure: None,
    }));
    let shared = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            let (header_end, length) = loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break (0, 0);
                }
                bytes.extend_from_slice(&buf[..n]);
                assert!(bytes.len() <= 128 * 1024);
                if let Some(pos) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..pos]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    break (pos + 4, length);
                }
            };
            if header_end == 0 {
                continue;
            }
            while bytes.len() < header_end + length {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
            }
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let mut first = headers.lines().next().unwrap().split_whitespace();
            let method = first.next().unwrap().to_string();
            let path = first
                .next()
                .unwrap()
                .strip_prefix("/v1/apps/synthetic-app")
                .unwrap()
                .to_string();
            let lower = headers.to_ascii_lowercase();
            assert!(lower.contains(&format!("authorization: bearer {TOKEN}")));
            let leased = lower.contains(&format!("fly-machine-lease-nonce: {NONCE}"));
            let body = if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
            };
            let request = Request {
                method,
                path,
                body,
                leased,
            };
            let response = respond(&mut shared.lock().unwrap(), &request);
            let Some((status, body)) = response else {
                continue;
            };
            let body = body.to_string();
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    Mock {
        api: Api {
            client: Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            base,
            token: TOKEN.into(),
        },
        state,
        task,
    }
}
fn respond(state: &mut MockState, request: &Request) -> Option<(&'static str, Value)> {
    state.requests.push(request.clone());
    let ok = |value| Some(("200 OK", value));
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/machines") => ok(state.machine.iter().cloned().collect()),
        ("POST", "/machines") => {
            assert_eq!(request.body["skip_launch"], true);
            assert!(!request.body.to_string().contains(TOKEN));
            let mut value = request.body.clone();
            value["id"] = json!("machine-1");
            value["instance_id"] = json!("instance-1");
            value["state"] = json!("created");
            state.machine = Some(value.clone());
            if state.ambiguous_create {
                None
            } else {
                ok(value)
            }
        }
        ("GET", "/machines/machine-1") => ok(state.machine.clone().unwrap()),
        ("POST", "/machines/machine-1/lease") => {
            assert_eq!(request.body["ttl"], 300);
            ok(json!({"data":{"nonce":NONCE}}))
        }
        ("DELETE", "/machines/machine-1/lease") => {
            assert!(request.leased);
            ok(Value::Null)
        }
        ("POST", "/machines/machine-1/start") => {
            assert!(request.leased);
            state.machine.as_mut().unwrap()["state"] = json!("started");
            ok(json!({}))
        }
        ("POST", "/machines/machine-1/stop") => {
            assert!(request.leased);
            assert_eq!(request.body["signal"], "SIGTERM");
            assert_eq!(request.body["timeout"], "30s");
            state.machine.as_mut().unwrap()["state"] = json!("stopped");
            ok(json!({}))
        }
        ("GET", path) if path.starts_with("/machines/machine-1/wait?") => {
            if path.contains("state=started")
                && let Some(machine) = state.start_wait_failure.take()
            {
                state.machine = Some(machine);
                return Some(("408 Request Timeout", json!({})));
            }
            if path.contains("state=stopped") {
                assert!(path.contains("instance_id=instance-1"));
            }
            assert!(path.contains("state=started") || path.contains("state=stopped"));
            ok(json!({}))
        }
        _ => Some(("404 Not Found", json!({}))),
    }
}
fn mutations(state: &MockState) -> Vec<&Request> {
    state
        .requests
        .iter()
        .filter(|r| r.method != "GET")
        .collect()
}

#[tokio::test]
async fn deploy_creates_without_launch_then_starts_under_lease() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        config.validate().unwrap();
        let mock = mock(None, false).await;
        let result = execute_with(&mock.api, &config, Operation::Deploy)
            .await
            .unwrap();
        assert_eq!(result["worker_state"], "running");
        let state = mock.state.lock().unwrap();
        let changes = mutations(&state);
        assert_eq!(
            changes.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
            vec![
                "/machines",
                "/machines/machine-1/lease",
                "/machines/machine-1/start",
                "/machines/machine-1/lease"
            ]
        );
        assert_eq!(changes[3].method, "DELETE");
        assert!(changes[2].leased && changes[3].leased);
        let start = state
            .requests
            .iter()
            .position(|r| r.path.ends_with("/start"))
            .unwrap();
        assert_eq!(state.requests[start - 1].method, "GET");
        assert!(
            state.requests[start + 1]
                .path
                .contains("/wait?state=started")
        );
        assert_eq!(state.requests[start + 2].path, "/machines/machine-1");
        assert!(!config.manifest().to_string().contains(TOKEN));
        assert_eq!(
            changes[0].body["config"]["processes"][0]["secrets"][0]["name"],
            "ACTOR_TOKEN_REFERENCE"
        );
    })
    .await
    .expect("bounded Fly mock test");
}
#[tokio::test]
async fn stop_uses_lease_nonce_and_instance_specific_wait() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        let mock = mock(Some(machine(&config, "started")), false).await;
        let result = execute_with(&mock.api, &config, Operation::Stop)
            .await
            .unwrap();
        assert_eq!(result["worker_state"], "stopped");
        let state = mock.state.lock().unwrap();
        let changes = mutations(&state);
        assert_eq!(changes.len(), 3);
        assert!(changes[1].path.ends_with("/stop") && changes[1].leased);
        assert_eq!(changes[2].method, "DELETE");
        assert!(
            state
                .requests
                .iter()
                .any(|r| r.path.contains("state=stopped&instance_id=instance-1"))
        );
    })
    .await
    .expect("bounded Fly mock test");
}
#[tokio::test]
async fn ambiguous_create_is_not_blindly_retried_and_status_reconciles() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        let mock = mock(None, true).await;
        let error = execute_with(&mock.api, &config, Operation::Deploy)
            .await
            .unwrap_err();
        assert!(!error.to_string().contains(TOKEN));
        assert_eq!(mutations(&mock.state.lock().unwrap()).len(), 1);
        let status = execute_with(&mock.api, &config, Operation::Status)
            .await
            .unwrap();
        assert_eq!(status["worker_state"], "created");
        let state = mock.state.lock().unwrap();
        assert_eq!(mutations(&state).len(), 1);
        assert_eq!(
            state
                .requests
                .iter()
                .filter(|r| r.method == "POST" && r.path == "/machines")
                .count(),
            1
        );
    })
    .await
    .expect("bounded Fly mock test");
}
#[tokio::test]
async fn ownership_or_configuration_mismatch_never_mutates() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        for key in ["owner", "image", "environment", "auto_destroy", "schedule"] {
            let mut existing = machine(&config, "started");
            match key {
                "owner" => {
                    existing["config"]["metadata"]["kordi_simulator_actor"] =
                        json!("different-actor")
                }
                "image" => existing["config"]["image"] = json!("different-image"),
                "auto_destroy" => existing["config"]["auto_destroy"] = json!(true),
                "schedule" => existing["config"]["schedule"] = json!("hourly"),
                _ => existing["config"]["processes"][0]["env"]["UNEXPECTED"] = json!("synthetic"),
            }
            let mock = mock(Some(existing), false).await;
            assert!(
                execute_with(&mock.api, &config, Operation::Deploy)
                    .await
                    .is_err()
            );
            assert!(
                execute_with(&mock.api, &config, Operation::Stop)
                    .await
                    .is_err()
            );
            assert!(mutations(&mock.state.lock().unwrap()).is_empty());
        }
    })
    .await
    .expect("bounded Fly mock test");
}

#[tokio::test]
async fn start_wait_failure_accepts_only_verified_owned_stopped_worker_and_releases_lease() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        for outcome in ["quick-exit", "running", "different-owner", "different-id"] {
            let mut current = machine(
                &config,
                if outcome == "running" {
                    "started"
                } else {
                    "stopped"
                },
            );
            if outcome == "different-owner" {
                current["config"]["metadata"]["kordi_simulator_actor"] = json!("other-actor");
            }
            if outcome == "different-id" {
                current["id"] = json!("machine-other");
            }
            let mock = mock(Some(machine(&config, "created")), false).await;
            mock.state.lock().unwrap().start_wait_failure = Some(current);
            let result = execute_with(&mock.api, &config, Operation::Deploy).await;
            if outcome == "quick-exit" {
                assert_eq!(result.unwrap()["worker_state"], "stopped");
            } else {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains("HTTP 408"),
                    "original wait error must be preserved"
                );
                assert!(!error.contains(TOKEN));
            }
            let state = mock.state.lock().unwrap();
            let last = state.requests.last().unwrap();
            assert_eq!(last.method, "DELETE");
            assert_eq!(last.path, "/machines/machine-1/lease");
            assert!(last.leased);
            let wait = state
                .requests
                .iter()
                .position(|r| r.path.contains("/wait?state=started"))
                .unwrap();
            assert_eq!(state.requests[wait + 1].method, "GET");
            assert_eq!(state.requests[wait + 1].path, "/machines/machine-1");
        }
    })
    .await
    .expect("bounded Fly mock test");
}

#[tokio::test]
async fn stop_never_started_worker_needs_no_instance_or_mutation() {
    timeout(Duration::from_secs(5), async {
        let config = config();
        let mut created = machine(&config, "created");
        created.as_object_mut().unwrap().remove("instance_id");
        let mock = mock(Some(created), false).await;
        let result = execute_with(&mock.api, &config, Operation::Stop)
            .await
            .unwrap();
        assert_eq!(result["worker_state"], "created");
        assert!(mutations(&mock.state.lock().unwrap()).is_empty());
    })
    .await
    .expect("bounded Fly mock test");
}
