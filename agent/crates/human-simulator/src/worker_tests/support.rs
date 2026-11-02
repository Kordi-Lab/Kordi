use crate::{
    client::{AccountCredentials, ApiClient},
    config::ActorConfig,
    protocol::{ActorState, ActorView, PendingSend},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct ActorRecord {
    pub(super) view: ActorView,
    pub(super) syncs: u64,
    pub(super) decides: u64,
    pub(super) capacity_rejections: u64,
    pub(super) checkpoints: u64,
    pub(super) heartbeats: u64,
    pub(super) operator_stopped: bool,
    pub(super) decide_failure_status: Option<u16>,
}

pub(super) struct MockState {
    pub(super) actors: HashMap<String, ActorRecord>,
    pub(super) active_slots: usize,
    pub(super) max_slots: usize,
    pub(super) permanently_full: bool,
    pub(super) sends: Vec<(String, Uuid)>,
}

pub(super) struct MockServer {
    pub(super) base: String,
    pub(super) state: Arc<Mutex<MockState>>,
    task: JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    pub(super) async fn new(actor_ids: &[&str], max_slots: usize, permanently_full: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let actors = actor_ids
            .iter()
            .map(|id| {
                (
                    (*id).to_owned(),
                    ActorRecord {
                        view: view(id, &base),
                        syncs: 0,
                        decides: 0,
                        capacity_rejections: 0,
                        checkpoints: 0,
                        heartbeats: 0,
                        operator_stopped: false,
                        decide_failure_status: None,
                    },
                )
            })
            .collect();
        let state = Arc::new(Mutex::new(MockState {
            actors,
            active_slots: 0,
            max_slots,
            permanently_full,
            sends: Vec::new(),
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let shared = shared.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut stream).await;
                    let (status, body, delay_slot) = respond(&shared, &request).await;
                    if delay_slot {
                        timeout(Duration::from_secs(5), async {
                            loop {
                                let capacity_rejected = shared
                                    .lock()
                                    .unwrap()
                                    .actors
                                    .values()
                                    .any(|record| record.capacity_rejections > 0);
                                if capacity_rejected {
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(5)).await;
                            }
                        })
                        .await
                        .expect("a worker should encounter full model capacity");
                        shared.lock().unwrap().active_slots -= 1;
                    }
                    let body = body.to_string();
                    let reason = if status == 200 {
                        "OK"
                    } else {
                        "Too Many Requests"
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self { base, state, task }
    }
}

struct Request {
    method: String,
    path: String,
    body: Value,
    authorization: String,
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Request {
    let mut bytes = Vec::new();
    let mut buf = [0_u8; 4096];
    let (header_end, length) = loop {
        let n = stream.read(&mut buf).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&buf[..n]);
        let Some(pos) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
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
    };
    while bytes.len() < header_end + length {
        let n = stream.read(&mut buf).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&buf[..n]);
    }
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let mut first = headers.lines().next().unwrap().split_whitespace();
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let authorization = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default();
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    };
    Request {
        method,
        path,
        body,
        authorization,
    }
}

async fn respond(state: &Arc<Mutex<MockState>>, request: &Request) -> (u16, Value, bool) {
    let ok = |body| (200, body, false);
    if request.path == "/v1/cloud/auth/me" {
        return ok(json!({"accountId":"sim-account"}));
    }
    if request.path.starts_with("/v2/chat/sync") {
        let actor = request.authorization.trim_start_matches("Bearer account-");
        let mut state = state.lock().unwrap();
        let record = state.actors.get_mut(actor).unwrap();
        record.syncs += 1;
        let cursor = format!("{}", record.syncs);
        return ok(json!({"events":[],"next_cursor":cursor,"has_more":false}));
    }
    if request.path.starts_with("/v2/chat/conversations/") && request.path.ends_with("/messages") {
        let actor = request
            .authorization
            .trim_start_matches("Bearer account-")
            .to_owned();
        let client_message_id: Uuid = request.body["client_message_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        state.lock().unwrap().sends.push((actor, client_message_id));
        return ok(json!({"message":{"id":Uuid::new_v4()}}));
    }
    let Some(rest) = request.path.strip_prefix("/v1/sim/actors/") else {
        return (404, json!({"error":"not found"}), false);
    };
    let (actor, action) = rest.split_once('/').unwrap_or((rest, ""));
    let mut shared = state.lock().unwrap();
    if request.method == "POST" && action == "decide" {
        if let Some(status) = shared
            .actors
            .get(actor)
            .and_then(|record| record.decide_failure_status)
        {
            let record = shared.actors.get_mut(actor).unwrap();
            assert_eq!(
                request.body["revision"].as_i64(),
                Some(record.view.revision)
            );
            record.decides += 1;
            return (status, json!({"error":"stale revision"}), false);
        }
        let capacity_full = shared.permanently_full || shared.active_slots >= shared.max_slots;
        if capacity_full {
            let Some(record) = shared.actors.get_mut(actor) else {
                return (404, json!({"error":"unknown actor"}), false);
            };
            assert_eq!(
                request.body["revision"].as_i64(),
                Some(record.view.revision)
            );
            record.decides += 1;
            record.capacity_rejections += 1;
            return (
                429,
                json!({"error":"model capacity temporarily unavailable"}),
                false,
            );
        }
        shared.active_slots += 1;
        let Some(record) = shared.actors.get_mut(actor) else {
            shared.active_slots -= 1;
            return (404, json!({"error":"unknown actor"}), false);
        };
        assert_eq!(
            request.body["revision"].as_i64(),
            Some(record.view.revision)
        );
        record.decides += 1;
        record.view.revision += 1;
        record.view.model_calls += 1;
        record.view.state.needs_decision = false;
        record.view.state.pending = Some(PendingSend {
            client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, actor.as_bytes()),
            text: format!("hello from {actor}"),
        });
        return (200, serde_json::to_value(&record.view).unwrap(), true);
    }
    let Some(record) = shared.actors.get_mut(actor) else {
        return (404, json!({"error":"unknown actor"}), false);
    };
    match (request.method.as_str(), action) {
        ("GET", "status") => ok(json!({"status":"running"})),
        ("POST", "lease") => ok(json!(record.view)),
        ("POST", "heartbeat") => {
            record.heartbeats += 1;
            if record.operator_stopped {
                (409, json!({"error":"lease is no longer owned"}), false)
            } else {
                ok(json!({}))
            }
        }
        ("POST", "release") => ok(json!({})),
        ("POST", "checkpoint") => {
            assert_eq!(
                request.body["revision"].as_i64(),
                Some(record.view.revision)
            );
            record.view.state = serde_json::from_value(request.body["state"].clone()).unwrap();
            record.view.revision += 1;
            record.checkpoints += 1;
            ok(json!(record.view))
        }
        ("POST", "confirm") => {
            assert_eq!(
                request.body["revision"].as_i64(),
                Some(record.view.revision)
            );
            record.view.revision += 1;
            record.view.messages_sent += 1;
            record.view.state.pending = None;
            record.view.state.status = "stopped".into();
            ok(json!(record.view))
        }
        _ => (404, json!({"error":"not found"}), false),
    }
}

fn view(actor: &str, base: &str) -> ActorView {
    ActorView {
        config: ActorConfig {
            actor_id: actor.into(),
            account_id: "sim-account".into(),
            conversation_id: Uuid::new_v4(),
            objective: "Make one test send".into(),
            persona: "Synthetic test participant".into(),
            private_facts: Vec::new(),
            skill: "human-requester@1".into(),
            max_model_calls: 10,
            max_messages: 10,
            poll_seconds: 1,
            max_wait_seconds: 60,
        },
        state: ActorState::default(),
        revision: 0,
        generation: 1,
        model_calls: 0,
        messages_sent: 0,
        kordi_api_base: base.into(),
    }
}

pub(super) fn api(base: &str) -> ApiClient {
    ApiClient::new(base, "worker-test-token".into()).unwrap()
}

pub(super) fn credentials(actor: &str) -> AccountCredentials {
    AccountCredentials {
        token: Some(format!("account-{actor}")),
        login: None,
    }
}
