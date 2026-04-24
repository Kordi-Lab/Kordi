use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::chat::{start_bridge_agent_prompt_stream, DesktopChatManager};

use super::constants::{
    API_STYLE_SERVE, BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_TYPE_ASK,
    BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_RESPONSE,
};
use super::conversation_commands::{
    apply_bridge_event, mailbox_payload_text, parse_bridge_event_payload, sender_name_for_runtime,
    ParsedMailboxEvent,
};
use super::local_server::current_local_server_status_for_runtime;
use super::{
    append_conversation_message, build_conversation_only_bridge_state, load_conversation_store,
    relay_plaintext_message, save_conversation_store, update_message_delivery_state,
    DesktopBridgeHostConfig, DesktopBridgeManager, DesktopBridgeStore,
};

pub(super) const BRIDGE_STATE_EVENT: &str = "desktop-bridge-state";

#[derive(Default)]
pub(super) struct RealtimeBridgeRuntime {
    connections: HashMap<String, RealtimeBridgeConnection>,
}

struct RealtimeBridgeConnection {
    fingerprint: String,
    sender: mpsc::UnboundedSender<String>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct LocalRealtimeTarget {
    host: DesktopBridgeHostConfig,
    sender_runtime: String,
    sender_agent_id: Option<String>,
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
                    should_process_agent_asks: true,
                },
            );
        }
    }

    targets
}

fn encode_outbound_frame(target_node_id: &str, payload: &Value) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(payload).map_err(|err| err.to_string())?);
    Ok(serde_json::json!({
        "dst": target_node_id,
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
    app.emit(BRIDGE_STATE_EVENT, state)
        .map_err(|err| err.to_string())
}

async fn save_and_emit_bridge_state(
    app: &tauri::AppHandle,
    local_server: &tokio::sync::Mutex<super::LocalBridgeServerRuntime>,
    conversations: &super::DesktopBridgeConversationStore,
) -> Result<(), String> {
    save_conversation_store(conversations)?;
    emit_bridge_state(app, local_server).await
}

async fn try_send_connected_realtime_payload(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let frame = encode_outbound_frame(target_node_id, payload)?;
    let runtime = manager.realtime.lock().await;
    let connection = runtime
        .connections
        .get(&host.node_id)
        .ok_or_else(|| "Realtime bridge connection is not ready yet".to_string())?;
    connection
        .sender
        .send(frame)
        .map_err(|_| "Realtime bridge connection is unavailable".to_string())
}

async fn send_realtime_or_relay(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
) {
    if try_send_connected_realtime_payload(manager, host, target_node_id, payload)
        .await
        .is_err()
    {
        let _ = relay_plaintext_message(
            &host.coordination,
            &host.api_key,
            target_node_id,
            project_id,
            payload,
        )
        .await;
    }
}

fn append_local_agent_inbound_message(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    text: String,
) -> super::DesktopBridgeConversationStore {
    let mut conversations = load_conversation_store();
    let peer_display_name = event.from_display_name.clone();
    let peer_owner_name = event.from_owner_name.clone();
    let peer_runtime = event
        .from_runtime
        .clone()
        .unwrap_or_else(|| super::constants::DEFAULT_BRIDGE_RUNTIME.to_string());
    let sender_name = sender_name_for_runtime(
        &peer_runtime,
        peer_display_name.as_deref(),
        peer_owner_name.as_deref(),
        &event.from_node_id,
    );

    append_conversation_message(
        &mut conversations,
        &target.host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        event.project_id.clone(),
        None,
        BRIDGE_MESSAGE_DIRECTION_INBOUND,
        Some(sender_name),
        text,
        event.request_id.clone(),
        Some("processing".to_string()),
        true,
    );

    conversations
}

fn append_local_agent_outbound_response(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    response_text: String,
    delivery_state: &str,
    mark_complete: bool,
) -> super::DesktopBridgeConversationStore {
    let mut conversations = load_conversation_store();
    if mark_complete {
        if let Some(request_id) = event.request_id.as_deref() {
            update_message_delivery_state(&mut conversations, request_id, BRIDGE_DELIVERY_STATE_RESPONDED);
        }
    }
    let peer_display_name = event.from_display_name.clone();
    let peer_owner_name = event.from_owner_name.clone();
    let peer_runtime = event
        .from_runtime
        .clone()
        .unwrap_or_else(|| super::constants::DEFAULT_BRIDGE_RUNTIME.to_string());
    let sender_name = sender_name_for_runtime(
        &target.sender_runtime,
        target.host.display_name.as_deref(),
        target.host.owner.as_deref(),
        &target.host.node_id,
    );

    append_conversation_message(
        &mut conversations,
        &target.host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        event.project_id.clone(),
        None,
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
        Some(sender_name),
        response_text,
        event.request_id.clone(),
        Some(delivery_state.to_string()),
        false,
    );

    conversations
}

fn spawn_local_agent_response(
    manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
    app: tauri::AppHandle,
    local_server: std::sync::Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: LocalRealtimeTarget,
    event: ParsedMailboxEvent,
    text: String,
) {
    tokio::spawn(async move {
        let mut stream = match start_bridge_agent_prompt_stream(
            &chat_manager,
            &target.host.node_id,
            &event.from_node_id,
            text,
        )
        .await
        {
            Ok(stream) => stream,
            Err(error) => {
                if let Some(request_id) = event.request_id.as_deref() {
                    let mut conversations = load_conversation_store();
                    update_message_delivery_state(&mut conversations, request_id, "processing_failed");
                    let _ = save_and_emit_bridge_state(&app, &local_server, &conversations).await;
                    let failed = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &failed,
                    )
                    .await;
                }
                return;
            }
        };

        let mut last_sent_text = String::new();
        while let Some(snapshot) = stream.updates.recv().await {
            if snapshot.assistant_text == last_sent_text && !snapshot.completed {
                continue;
            }

            if snapshot.assistant_text.trim().is_empty() {
                if snapshot.completed {
                    break;
                }
                continue;
            }

            let is_final = snapshot.completed && snapshot.succeeded;
            last_sent_text = snapshot.assistant_text.clone();
            let conversations = append_local_agent_outbound_response(
                &target,
                &event,
                snapshot.assistant_text.clone(),
                if is_final {
                    BRIDGE_DELIVERY_STATE_RESPONDED
                } else {
                    "processing"
                },
                is_final,
            );
            let _ = save_and_emit_bridge_state(&app, &local_server, &conversations).await;

            let response = serde_json::json!({
                "from": target.host.node_id,
                "fromDisplayName": target.host.display_name,
                "fromOwnerName": target.host.owner,
                "fromRuntime": target.sender_runtime,
                "fromHumanId": target.host.human_id,
                "fromAgentId": target.sender_agent_id,
                "projectId": event.project_id,
                "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
                "requestId": event.request_id,
                "payload": { "message": snapshot.assistant_text, "done": is_final },
            });
            send_realtime_or_relay(
                &manager,
                &target.host,
                &event.from_node_id,
                event.project_id.as_deref(),
                &response,
            )
            .await;

            if is_final {
                if let Some(request_id) = event.request_id.as_deref() {
                    let responded = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_RESPONDED },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &responded,
                    )
                    .await;
                }
                break;
            }
        }

        match stream.completion.await {
            Ok(Ok(final_snapshot)) if final_snapshot.succeeded => {}
            Ok(Ok(final_snapshot)) => {
                if let Some(request_id) = event.request_id.as_deref() {
                    let error = final_snapshot.error.unwrap_or_else(|| final_snapshot.message.clone());
                    let mut conversations = load_conversation_store();
                    update_message_delivery_state(&mut conversations, request_id, "processing_failed");
                    let _ = save_and_emit_bridge_state(&app, &local_server, &conversations).await;

                    let failed = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &failed,
                    )
                    .await;
                }
            }
            Ok(Err(error)) => {
                if let Some(request_id) = event.request_id.as_deref() {
                    let mut conversations = load_conversation_store();
                    update_message_delivery_state(&mut conversations, request_id, "processing_failed");
                    let _ = save_and_emit_bridge_state(&app, &local_server, &conversations).await;

                    let failed = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &failed,
                    )
                    .await;
                }
            }
            Err(error) => {
                if let Some(request_id) = event.request_id.as_deref() {
                    let mut conversations = load_conversation_store();
                    update_message_delivery_state(&mut conversations, request_id, "processing_failed");
                    let _ = save_and_emit_bridge_state(&app, &local_server, &conversations).await;

                    let failed = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error.to_string() },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &failed,
                    )
                    .await;
                }
            }
        }
    });
}

async fn handle_incoming_payload(
    manager: &DesktopBridgeManager,
    app: &tauri::AppHandle,
    local_server: &std::sync::Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: &LocalRealtimeTarget,
    payload: Value,
) -> Result<(), String> {
    let Some(event) = parse_bridge_event_payload(&payload) else {
        return Ok(());
    };

    if target.should_process_agent_asks && event.message_type == BRIDGE_MESSAGE_TYPE_ASK {
        let text = mailbox_payload_text(&event.payload);
        if text.trim().is_empty() {
            return Ok(());
        }

        let conversations = append_local_agent_inbound_message(target, &event, text.clone());
        save_and_emit_bridge_state(app, local_server, &conversations).await?;

        if let Some(request_id) = event.request_id.as_deref() {
            let processing = serde_json::json!({
                "from": target.host.node_id,
                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                "payload": { "requestId": request_id, "state": "processing" },
            });
            send_realtime_or_relay(
                manager,
                &target.host,
                &event.from_node_id,
                event.project_id.as_deref(),
                &processing,
            )
            .await;
        }

        let chat_manager = app.state::<DesktopChatManager>().inner().clone();
        spawn_local_agent_response(
            manager.clone(),
            chat_manager,
            app.clone(),
            local_server.clone(),
            target.clone(),
            event,
            text,
        );
        return Ok(());
    }

    let mut conversations = load_conversation_store();
    apply_bridge_event(&target.host, &mut conversations, event, false).await;
    save_and_emit_bridge_state(app, local_server, &conversations).await?;

    Ok(())
}

async fn run_realtime_connection(
    manager: DesktopBridgeManager,
    app: tauri::AppHandle,
    local_server: std::sync::Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: LocalRealtimeTarget,
    mut receiver: mpsc::UnboundedReceiver<String>,
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
                    if writer.send(Message::Text(outbound)).await.is_err() {
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
                            let _ = handle_incoming_payload(&manager, &app, &local_server, &target, payload).await;
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

pub(super) async fn set_bridge_app_handle(
    manager: &DesktopBridgeManager,
    app: tauri::AppHandle,
) {
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
) -> Result<(), String> {
    if !is_realtime_host(host) {
        return Err("Realtime bridge chat is not available for this host".to_string());
    }

    let store = super::load_bridge_store();
    sync_realtime_connections(manager, &store).await;

    try_send_connected_realtime_payload(manager, host, target_node_id, payload).await
}
