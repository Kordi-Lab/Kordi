use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;

use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use super::constants::{
    API_STYLE_SERVE, BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT,
    BRIDGE_MESSAGE_TYPE_TYPING,
};
use super::local_server::current_local_server_status_for_runtime;
use super::{
    build_conversation_only_bridge_state, encrypt_bridge_payload_for_target,
    load_conversation_store, relay_plaintext_message, DesktopBridgeHostConfig,
    DesktopBridgeManager, DesktopBridgeStore,
};

mod local_agent;

pub(super) const BRIDGE_STATE_EVENT: &str = "desktop-bridge-state";

#[derive(Default)]
pub(super) struct RealtimeBridgeRuntime {
    connections: HashMap<String, RealtimeBridgeConnection>,
}

struct RealtimeBridgeConnection {
    fingerprint: String,
    sender: mpsc::UnboundedSender<RealtimeOutboundFrame>,
    task: tokio::task::JoinHandle<()>,
}

struct RealtimeOutboundFrame {
    text: String,
    result: oneshot::Sender<Result<(), String>>,
}

#[derive(Clone)]
struct LocalRealtimeTarget {
    host: DesktopBridgeHostConfig,
    sender_runtime: String,
    sender_agent_id: Option<String>,
    owner_node_id: Option<String>,
    should_process_agent_asks: bool,
}

#[derive(Deserialize)]
struct IncomingDerpFrame {
    src: Option<String>,
    data: String,
}

fn websocket_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}/ws/derp")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}/ws/derp")
    } else {
        format!("wss://{trimmed}/ws/derp")
    }
}

fn host_fingerprint(host: &DesktopBridgeHostConfig) -> String {
    format!("{}|{}|{}", host.coordination, host.node_id, host.api_key)
}

fn is_realtime_host(host: &DesktopBridgeHostConfig) -> bool {
    host.api_style == API_STYLE_SERVE
        && !host.api_key.trim().is_empty()
        && !host.node_id.trim().is_empty()
}

fn local_realtime_targets(store: &DesktopBridgeStore) -> HashMap<String, LocalRealtimeTarget> {
    let mut targets = HashMap::new();

    for host in &store.hosts {
        if is_realtime_host(host) {
            targets.insert(
                host.node_id.clone(),
                LocalRealtimeTarget {
                    host: host.clone(),
                    sender_runtime: "person".to_string(),
                    sender_agent_id: None,
                    owner_node_id: Some(host.node_id.clone()),
                    should_process_agent_asks: false,
                },
            );
        }

        for agent in &host.agents {
            let agent_host = DesktopBridgeHostConfig {
                id: host.id.clone(),
                coordination: host.coordination.clone(),
                node_id: agent.node_id.clone(),
                api_key: agent.api_key.clone(),
                display_name: Some(agent.label.clone()),
                owner: host.owner.clone(),
                human_id: host.human_id.clone(),
                discovery_mode: host.discovery_mode.clone(),
                active_agent_id: Some(agent.id.clone()),
                agents: vec![agent.clone()],
                api_style: host.api_style.clone(),
            };
            if !is_realtime_host(&agent_host) {
                continue;
            }
            targets.insert(
                agent_host.node_id.clone(),
                LocalRealtimeTarget {
                    host: agent_host,
                    sender_runtime: agent.runtime.clone(),
                    sender_agent_id: Some(agent.id.clone()),
                    owner_node_id: Some(host.node_id.clone()),
                    should_process_agent_asks: true,
                },
            );
        }
    }

    targets
}

async fn encode_outbound_frame(
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
    durable: bool,
) -> Result<String, String> {
    let encrypted_payload =
        encrypt_bridge_payload_for_target(host, target_node_id, project_id, payload).await?;
    let data = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&encrypted_payload).map_err(|err| err.to_string())?);
    Ok(serde_json::json!({
        "dst": target_node_id,
        "durable": durable,
        "data": data,
    })
    .to_string())
}

async fn emit_bridge_state(
    app: &tauri::AppHandle,
    local_server: &tokio::sync::Mutex<super::LocalBridgeServerRuntime>,
) -> Result<(), String> {
    let store = super::load_bridge_store();
    let conversations = load_conversation_store();
    let local_server = current_local_server_status_for_runtime(local_server).await;
    let state = build_conversation_only_bridge_state(store, conversations, local_server);
    if let Err(error) = crate::canonical_sessions::sync_bridge_state_sessions(&state) {
        eprintln!("Unable to sync bridge sessions into canonical sessions: {error}");
    }
    app.emit(BRIDGE_STATE_EVENT, state)
        .map_err(|err| err.to_string())
}

async fn emit_after_storage_write(
    app: &tauri::AppHandle,
    local_server: &tokio::sync::Mutex<super::LocalBridgeServerRuntime>,
    result: Result<super::DesktopBridgeConversationStore, String>,
) -> Result<(), String> {
    result?;
    emit_bridge_state(app, local_server).await
}

async fn send_realtime_frame_and_wait(
    sender: mpsc::UnboundedSender<RealtimeOutboundFrame>,
    frame: String,
) -> Result<(), String> {
    let (result, waiter) = oneshot::channel();
    sender
        .send(RealtimeOutboundFrame {
            text: frame,
            result,
        })
        .map_err(|_| "Realtime bridge connection is unavailable".to_string())?;
    waiter
        .await
        .map_err(|_| "Realtime bridge connection is unavailable".to_string())?
}

async fn try_send_connected_realtime_payload(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
    durable: bool,
) -> Result<(), String> {
    let frame = encode_outbound_frame(host, target_node_id, project_id, payload, durable).await?;
    let sender = {
        let runtime = manager.realtime.lock().await;
        runtime
            .connections
            .get(&host.node_id)
            .map(|connection| connection.sender.clone())
            .ok_or_else(|| "Realtime bridge connection is not ready yet".to_string())?
    };
    send_realtime_frame_and_wait(sender, frame).await
}

fn realtime_payload_is_durable(payload: &Value) -> bool {
    let message_type = payload
        .get("messageType")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    !matches!(
        message_type,
        BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT
            | BRIDGE_MESSAGE_TYPE_TYPING
            | BRIDGE_MESSAGE_TYPE_HEARTBEAT
    )
}

async fn send_realtime_or_relay(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
) {
    let durable = realtime_payload_is_durable(payload);
    if try_send_connected_realtime_payload(
        manager,
        host,
        target_node_id,
        project_id,
        payload,
        durable,
    )
    .await
    .is_err()
        && durable
    {
        let _ = relay_plaintext_message(host, target_node_id, project_id, payload).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_events_are_not_durable_realtime_payloads() {
        let delivery = serde_json::json!({
            "messageType": "delivery_event",
            "payload": { "requestId": "bridge_req_1", "state": "read" },
        });
        let chat_message = serde_json::json!({
            "messageType": "raw",
            "requestId": "bridge_req_2",
            "payload": { "message": "hello" },
        });

        assert!(!realtime_payload_is_durable(&delivery));
        assert!(realtime_payload_is_durable(&chat_message));
    }

    #[tokio::test]
    async fn realtime_send_waits_for_writer_failure_before_reporting_success() {
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeOutboundFrame>();
        let send_task = tokio::spawn(send_realtime_frame_and_wait(tx, "queued-frame".to_string()));

        let outbound = rx.recv().await.expect("queued outbound frame");
        assert_eq!(outbound.text, "queued-frame");
        let _ = outbound.result.send(Err("writer send failed".to_string()));

        let result = send_task.await.expect("send task completed");
        assert_eq!(result.unwrap_err(), "writer send failed");
    }
}

async fn run_realtime_connection(
    manager: DesktopBridgeManager,
    app: tauri::AppHandle,
    local_server: std::sync::Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: LocalRealtimeTarget,
    mut receiver: mpsc::UnboundedReceiver<RealtimeOutboundFrame>,
) {
    let ws_url = websocket_url(&target.host.coordination);

    loop {
        let mut request = match ws_url.clone().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                eprintln!(
                    "bridge realtime request error for {}:{}: {}",
                    target.host.id, target.host.node_id, error
                );
                return;
            }
        };
        if let Ok(header_value) = format!("Bearer {}", target.host.api_key).parse() {
            request.headers_mut().insert("Authorization", header_value);
        }

        let (socket, _) = match connect_async(request).await {
            Ok(result) => result,
            Err(error) => {
                eprintln!(
                    "bridge realtime connect error for {}:{}: {}",
                    target.host.id, target.host.node_id, error
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let (mut writer, mut reader) = socket.split();
        loop {
            tokio::select! {
                outbound = receiver.recv() => {
                    let Some(outbound) = outbound else {
                        return;
                    };
                    let result = writer
                        .send(Message::Text(outbound.text))
                        .await
                        .map_err(|_| "Realtime bridge connection is unavailable".to_string());
                    let should_reconnect = result.is_err();
                    let _ = outbound.result.send(result);
                    if should_reconnect {
                        break;
                    }
                }
                inbound = reader.next() => {
                    match inbound {
                        Some(Ok(Message::Text(text))) => {
                            let frame: IncomingDerpFrame = match serde_json::from_str(&text) {
                                Ok(frame) => frame,
                                Err(error) => {
                                    eprintln!("bridge realtime frame parse error for {}:{}: {}", target.host.id, target.host.node_id, error);
                                    continue;
                                }
                            };
                            let bytes = match base64::engine::general_purpose::STANDARD.decode(frame.data) {
                                Ok(bytes) => bytes,
                                Err(error) => {
                                    eprintln!("bridge realtime frame decode error for {}:{}: {}", target.host.id, target.host.node_id, error);
                                    continue;
                                }
                            };
                            let payload: Value = match serde_json::from_slice(&bytes) {
                                Ok(payload) => payload,
                                Err(error) => {
                                    eprintln!("bridge realtime payload parse error for {}:{} from {:?}: {}", target.host.id, target.host.node_id, frame.src, error);
                                    continue;
                                }
                            };
                            let _ = local_agent::handle_incoming_payload(&manager, &app, &local_server, &target, payload).await;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if writer.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(Message::Pong(_))) | Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {}
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

pub(super) async fn set_bridge_app_handle(manager: &DesktopBridgeManager, app: tauri::AppHandle) {
    *manager.app_handle.write().await = Some(app);
}

pub(super) async fn sync_realtime_connections(
    manager: &DesktopBridgeManager,
    store: &DesktopBridgeStore,
) {
    let Some(app) = manager.app_handle.read().await.clone() else {
        return;
    };

    let desired_targets = local_realtime_targets(store);

    let mut runtime = manager.realtime.lock().await;
    runtime.connections.retain(|node_id, connection| {
        let keep = desired_targets.contains_key(node_id);
        if !keep {
            connection.task.abort();
        }
        keep
    });

    for (node_id, target) in desired_targets {
        let fingerprint = host_fingerprint(&target.host);
        let reuse_existing = runtime
            .connections
            .get(&node_id)
            .map(|connection| {
                connection.fingerprint == fingerprint && !connection.sender.is_closed()
            })
            .unwrap_or(false);
        if reuse_existing {
            continue;
        }

        if let Some(existing) = runtime.connections.remove(&node_id) {
            existing.task.abort();
        }

        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_realtime_connection(
            manager.clone(),
            app.clone(),
            manager.local_server.clone(),
            target,
            rx,
        ));
        runtime.connections.insert(
            node_id,
            RealtimeBridgeConnection {
                fingerprint,
                sender: tx,
                task,
            },
        );
    }
}

pub(super) async fn send_realtime_payload(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    payload: &Value,
    durable: bool,
) -> Result<(), String> {
    if !is_realtime_host(host) {
        return Err("Realtime bridge chat is not available for this host".to_string());
    }

    let store = super::load_bridge_store();
    sync_realtime_connections(manager, &store).await;

    try_send_connected_realtime_payload(manager, host, target_node_id, None, payload, durable).await
}
