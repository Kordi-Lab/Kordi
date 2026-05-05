use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
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
    load_conversation_store, now_ms, relay_plaintext_message, DesktopBridgeHostConfig,
    DesktopBridgeManager, DesktopBridgeState, DesktopBridgeStore,
};

mod local_agent;

pub(super) const BRIDGE_STATE_EVENT: &str = "desktop-bridge-state";

#[derive(Default)]
pub(super) struct RealtimeBridgeRuntime {
    connections: HashMap<String, RealtimeBridgeConnection>,
    last_forced_refresh_at_ms: i64,
}

struct RealtimeBridgeConnection {
    fingerprint: String,
    sender: mpsc::UnboundedSender<RealtimeOutboundFrame>,
    task: tokio::task::JoinHandle<()>,
    last_confirmed_alive_ms: Arc<AtomicI64>,
}

struct RealtimeOutboundFrame {
    text: String,
    result: oneshot::Sender<Result<(), String>>,
}

const REALTIME_SEND_RESULT_TIMEOUT: Duration = Duration::from_secs(3);
const REALTIME_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const REALTIME_PONG_DEADLINE: Duration = Duration::from_secs(10);
const REALTIME_STALE_LIVENESS_GRACE: Duration = Duration::from_secs(5);
const REALTIME_FORCED_REFRESH_THROTTLE: Duration = Duration::from_secs(5);
const REALTIME_STALE_CONNECTION_ERROR: &str = "Realtime bridge connection is stale";

#[derive(Debug)]
struct RealtimeHeartbeat {
    pong_deadline: Duration,
    pending_ping_sent_at: Option<Instant>,
    next_nonce: u64,
}

impl RealtimeHeartbeat {
    fn new(pong_deadline: Duration) -> Self {
        Self {
            pong_deadline,
            pending_ping_sent_at: None,
            next_nonce: 0,
        }
    }

    fn record_ping_sent(&mut self, sent_at: Instant) {
        self.pending_ping_sent_at = Some(sent_at);
    }

    fn record_pong(&mut self) {
        self.pending_ping_sent_at = None;
    }

    fn missed_pong_deadline(&self, now: Instant) -> bool {
        self.pending_ping_sent_at
            .is_some_and(|sent_at| now.duration_since(sent_at) >= self.pong_deadline)
    }

    fn next_pong_deadline(&self) -> Option<Instant> {
        self.pending_ping_sent_at
            .map(|sent_at| sent_at + self.pong_deadline)
    }

    fn next_ping_payload(&mut self, sent_at: Instant) -> Vec<u8> {
        self.next_nonce = self.next_nonce.wrapping_add(1);
        self.record_ping_sent(sent_at);
        format!("kordi-bridge-realtime-ping-{}", self.next_nonce).into_bytes()
    }
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
                human_visibility_policy: host.human_visibility_policy.clone(),
                contact_approval_policy: host.contact_approval_policy.clone(),
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

async fn send_realtime_frame_and_wait_with_timeout(
    sender: mpsc::UnboundedSender<RealtimeOutboundFrame>,
    frame: String,
    timeout_after: Duration,
) -> Result<(), String> {
    let (result, waiter) = oneshot::channel();
    sender
        .send(RealtimeOutboundFrame {
            text: frame,
            result,
        })
        .map_err(|_| "Realtime bridge connection is unavailable".to_string())?;
    tokio::time::timeout(timeout_after, waiter)
        .await
        .map_err(|_| "Realtime bridge connection timed out".to_string())?
        .map_err(|_| "Realtime bridge connection is unavailable".to_string())?
}

async fn send_realtime_frame_and_wait(
    sender: mpsc::UnboundedSender<RealtimeOutboundFrame>,
    frame: String,
) -> Result<(), String> {
    send_realtime_frame_and_wait_with_timeout(sender, frame, REALTIME_SEND_RESULT_TIMEOUT).await
}

fn realtime_error_should_evict(error: &str) -> bool {
    error.contains("timed out")
        || error.contains("is unavailable")
        || error.contains(REALTIME_STALE_CONNECTION_ERROR)
}

fn realtime_stale_liveness_after() -> Duration {
    REALTIME_HEARTBEAT_INTERVAL + REALTIME_PONG_DEADLINE + REALTIME_STALE_LIVENESS_GRACE
}

fn realtime_connection_is_stale_for_durable_send(last_alive_ms: i64, now_ms: i64) -> bool {
    if last_alive_ms <= 0 {
        return true;
    }
    now_ms.saturating_sub(last_alive_ms) > realtime_stale_liveness_after().as_millis() as i64
}

fn mark_realtime_connection_alive(last_confirmed_alive_ms: &AtomicI64) {
    last_confirmed_alive_ms.store(now_ms(), Ordering::Relaxed);
}

fn realtime_forced_refresh_is_due(now_ms: i64, last_refresh_at_ms: i64) -> bool {
    last_refresh_at_ms <= 0
        || now_ms.saturating_sub(last_refresh_at_ms)
            >= REALTIME_FORCED_REFRESH_THROTTLE.as_millis() as i64
}

async fn evict_stale_realtime_connection(manager: &DesktopBridgeManager, node_id: &str) {
    let mut runtime = manager.realtime.lock().await;
    if let Some(existing) = runtime.connections.remove(node_id) {
        existing.task.abort();
    }
}

async fn evict_all_realtime_connections(manager: &DesktopBridgeManager) -> usize {
    let mut runtime = manager.realtime.lock().await;
    let now = now_ms();
    if !realtime_forced_refresh_is_due(now, runtime.last_forced_refresh_at_ms) {
        return 0;
    }
    runtime.last_forced_refresh_at_ms = now;
    let count = runtime.connections.len();
    for (_, existing) in runtime.connections.drain() {
        existing.task.abort();
    }
    count
}

async fn try_send_connected_realtime_payload(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
    durable: bool,
) -> Result<(), String> {
    let (sender, last_confirmed_alive_ms) = {
        let runtime = manager.realtime.lock().await;
        runtime
            .connections
            .get(&host.node_id)
            .map(|connection| {
                (
                    connection.sender.clone(),
                    connection.last_confirmed_alive_ms.clone(),
                )
            })
            .ok_or_else(|| "Realtime bridge connection is not ready yet".to_string())?
    };

    if durable
        && realtime_connection_is_stale_for_durable_send(
            last_confirmed_alive_ms.load(Ordering::Relaxed),
            now_ms(),
        )
    {
        evict_stale_realtime_connection(manager, &host.node_id).await;
        return Err(REALTIME_STALE_CONNECTION_ERROR.to_string());
    }

    let frame = encode_outbound_frame(host, target_node_id, project_id, payload, durable).await?;
    let result = send_realtime_frame_and_wait(sender, frame).await;
    if let Err(error) = &result {
        if realtime_error_should_evict(error) {
            evict_stale_realtime_connection(manager, &host.node_id).await;
        }
    }
    result
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

pub(super) async fn send_realtime_or_relay(
    manager: &DesktopBridgeManager,
    host: &DesktopBridgeHostConfig,
    target_node_id: &str,
    project_id: Option<&str>,
    payload: &Value,
) -> Result<(), String> {
    let durable = realtime_payload_is_durable(payload);
    let realtime_result = try_send_connected_realtime_payload(
        manager,
        host,
        target_node_id,
        project_id,
        payload,
        durable,
    )
    .await;
    match realtime_result {
        Ok(()) => Ok(()),
        Err(realtime_error) if !durable => Err(realtime_error),
        Err(realtime_error) => {
            match relay_plaintext_message(host, target_node_id, project_id, payload).await {
                Ok(()) => Ok(()),
                Err(relay_error) => {
                    Err(format!("realtime: {realtime_error}; relay: {relay_error}"))
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RealtimeSocketExit {
    ReceiverClosed,
    Reconnect,
}

struct RealtimeInboundContext<'a> {
    manager: &'a DesktopBridgeManager,
    app: &'a tauri::AppHandle,
    local_server: &'a Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: &'a LocalRealtimeTarget,
}

async fn handle_realtime_text_frame(context: Option<&RealtimeInboundContext<'_>>, text: String) {
    let Some(context) = context else {
        return;
    };
    let frame: IncomingDerpFrame = match serde_json::from_str(&text) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!(
                "bridge realtime frame parse error for {}:{}: {}",
                context.target.host.id, context.target.host.node_id, error
            );
            return;
        }
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(frame.data) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!(
                "bridge realtime frame decode error for {}:{}: {}",
                context.target.host.id, context.target.host.node_id, error
            );
            return;
        }
    };
    let payload: Value = match serde_json::from_slice(&bytes) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!(
                "bridge realtime payload parse error for {}:{} from {:?}: {}",
                context.target.host.id, context.target.host.node_id, frame.src, error
            );
            return;
        }
    };
    let _ = local_agent::handle_incoming_payload(
        context.manager,
        context.app,
        context.local_server,
        context.target,
        payload,
    )
    .await;
}

async fn drive_realtime_socket_loop<W, R, E>(
    writer: &mut W,
    reader: &mut R,
    receiver: &mut mpsc::UnboundedReceiver<RealtimeOutboundFrame>,
    last_confirmed_alive_ms: &Arc<AtomicI64>,
    heartbeat_interval_duration: Duration,
    pong_deadline_duration: Duration,
    inbound_context: Option<&RealtimeInboundContext<'_>>,
) -> RealtimeSocketExit
where
    W: Sink<Message> + Unpin,
    R: Stream<Item = Result<Message, E>> + Unpin,
{
    let mut heartbeat = RealtimeHeartbeat::new(pong_deadline_duration);
    let mut heartbeat_interval = tokio::time::interval_at(
        Instant::now() + heartbeat_interval_duration,
        heartbeat_interval_duration,
    );
    heartbeat_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let pong_deadline = heartbeat.next_pong_deadline();
        tokio::select! {
            outbound = receiver.recv() => {
                let Some(outbound) = outbound else {
                    return RealtimeSocketExit::ReceiverClosed;
                };
                let result = writer
                    .send(Message::Text(outbound.text))
                    .await
                    .map_err(|_| "Realtime bridge connection is unavailable".to_string());
                let should_reconnect = result.is_err();
                let _ = outbound.result.send(result);
                if should_reconnect {
                    return RealtimeSocketExit::Reconnect;
                }
            }
            _ = heartbeat_interval.tick() => {
                let sent_at = Instant::now();
                if heartbeat.missed_pong_deadline(sent_at) {
                    return RealtimeSocketExit::Reconnect;
                }
                if heartbeat.next_pong_deadline().is_some() {
                    continue;
                }
                let payload = heartbeat.next_ping_payload(sent_at);
                if writer.send(Message::Ping(payload)).await.is_err() {
                    return RealtimeSocketExit::Reconnect;
                }
            }
            _ = tokio::time::sleep_until(
                pong_deadline.unwrap_or_else(|| Instant::now() + heartbeat_interval_duration)
            ), if pong_deadline.is_some() => {
                return RealtimeSocketExit::Reconnect;
            }
            inbound = reader.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        mark_realtime_connection_alive(last_confirmed_alive_ms.as_ref());
                        handle_realtime_text_frame(inbound_context, text).await;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        mark_realtime_connection_alive(last_confirmed_alive_ms.as_ref());
                        if writer.send(Message::Pong(payload)).await.is_err() {
                            return RealtimeSocketExit::Reconnect;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        mark_realtime_connection_alive(last_confirmed_alive_ms.as_ref());
                        heartbeat.record_pong();
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        return RealtimeSocketExit::Reconnect;
                    }
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                        mark_realtime_connection_alive(last_confirmed_alive_ms.as_ref());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_error_should_evict_recognises_stale_signals() {
        assert!(realtime_error_should_evict(
            "Realtime bridge connection timed out"
        ));
        assert!(realtime_error_should_evict(
            "Realtime bridge connection is unavailable"
        ));
        assert!(realtime_error_should_evict(
            "Realtime bridge connection is stale"
        ));
        assert!(!realtime_error_should_evict(
            "Realtime bridge connection is not ready yet"
        ));
        assert!(!realtime_error_should_evict("HTTP 403 forbidden"));
    }

    #[test]
    fn delivery_events_and_heartbeats_are_not_durable_realtime_payloads() {
        let delivery = serde_json::json!({
            "messageType": "delivery_event",
            "payload": { "requestId": "bridge_req_1", "state": "read" },
        });
        let heartbeat = serde_json::json!({
            "messageType": "heartbeat",
            "payload": { "conversationId": "bridge:host:peer" },
        });
        let chat_message = serde_json::json!({
            "messageType": "raw",
            "requestId": "bridge_req_2",
            "payload": { "message": "hello" },
        });

        assert!(!realtime_payload_is_durable(&delivery));
        assert!(!realtime_payload_is_durable(&heartbeat));
        assert!(realtime_payload_is_durable(&chat_message));
    }

    #[test]
    fn heartbeat_deadline_fires_when_pong_is_missing() {
        let sent_at = tokio::time::Instant::now();
        let mut heartbeat = RealtimeHeartbeat::new(Duration::from_secs(10));

        heartbeat.record_ping_sent(sent_at);

        assert!(!heartbeat.missed_pong_deadline(sent_at + Duration::from_millis(9_999)));
        assert!(heartbeat.missed_pong_deadline(sent_at + Duration::from_secs(10)));
    }

    #[test]
    fn pong_clears_heartbeat_deadline() {
        let sent_at = tokio::time::Instant::now();
        let mut heartbeat = RealtimeHeartbeat::new(Duration::from_secs(10));

        heartbeat.record_ping_sent(sent_at);
        heartbeat.record_pong();

        assert!(!heartbeat.missed_pong_deadline(sent_at + Duration::from_secs(30)));
    }

    #[test]
    fn durable_send_treats_old_liveness_as_stale() {
        let now = 1_000_000_i64;
        let stale_at = now - realtime_stale_liveness_after().as_millis() as i64 - 1;
        let fresh_at = now - 1_000;

        assert!(realtime_connection_is_stale_for_durable_send(stale_at, now));
        assert!(!realtime_connection_is_stale_for_durable_send(
            fresh_at, now
        ));
    }

    #[test]
    fn forced_realtime_refresh_is_throttled() {
        let first_refresh_at = 10_000_i64;

        assert!(realtime_forced_refresh_is_due(first_refresh_at, 0));
        assert!(!realtime_forced_refresh_is_due(
            first_refresh_at + 1_000,
            first_refresh_at
        ));
        assert!(realtime_forced_refresh_is_due(
            first_refresh_at + REALTIME_FORCED_REFRESH_THROTTLE.as_millis() as i64,
            first_refresh_at
        ));
    }

    #[derive(Default)]
    struct RecordingSink {
        messages: Vec<Message>,
    }

    impl futures_util::Sink<Message> for RecordingSink {
        type Error = ();

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(
            mut self: std::pin::Pin<&mut Self>,
            item: Message,
        ) -> Result<(), Self::Error> {
            self.messages.push(item);
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn socket_loop_reconnects_when_ping_never_receives_pong() {
        let (_tx, mut receiver) = mpsc::unbounded_channel::<RealtimeOutboundFrame>();
        let mut writer = RecordingSink::default();
        let mut reader = futures_util::stream::pending::<Result<Message, ()>>();
        let last_confirmed_alive_ms = Arc::new(AtomicI64::new(now_ms()));

        let exit_result = tokio::time::timeout(
            Duration::from_millis(1_000),
            drive_realtime_socket_loop(
                &mut writer,
                &mut reader,
                &mut receiver,
                &last_confirmed_alive_ms,
                Duration::from_millis(25),
                Duration::from_millis(50),
                None,
            ),
        )
        .await;
        assert!(
            exit_result.is_ok(),
            "missed pong should reconnect before timeout; sent messages={}",
            writer.messages.len()
        );
        let exit = exit_result.unwrap();

        assert_eq!(exit, RealtimeSocketExit::Reconnect);
        assert!(writer
            .messages
            .iter()
            .any(|message| matches!(message, Message::Ping(_))));
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

    #[tokio::test]
    async fn realtime_send_times_out_when_writer_does_not_report_result() {
        let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeOutboundFrame>();
        let send_task = tokio::spawn(send_realtime_frame_and_wait_with_timeout(
            tx,
            "queued-frame".to_string(),
            Duration::from_millis(10),
        ));

        let outbound = rx.recv().await.expect("queued outbound frame");
        assert_eq!(outbound.text, "queued-frame");

        let result = send_task.await.expect("send task completed");
        assert_eq!(result.unwrap_err(), "Realtime bridge connection timed out");
        drop(outbound);
    }
}

async fn run_realtime_connection(
    manager: DesktopBridgeManager,
    app: tauri::AppHandle,
    local_server: Arc<tokio::sync::Mutex<super::LocalBridgeServerRuntime>>,
    target: LocalRealtimeTarget,
    last_confirmed_alive_ms: Arc<AtomicI64>,
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

        mark_realtime_connection_alive(&last_confirmed_alive_ms);
        let (mut writer, mut reader) = socket.split();
        let inbound_context = RealtimeInboundContext {
            manager: &manager,
            app: &app,
            local_server: &local_server,
            target: &target,
        };
        let exit = drive_realtime_socket_loop(
            &mut writer,
            &mut reader,
            &mut receiver,
            &last_confirmed_alive_ms,
            REALTIME_HEARTBEAT_INTERVAL,
            REALTIME_PONG_DEADLINE,
            Some(&inbound_context),
        )
        .await;
        if matches!(exit, RealtimeSocketExit::ReceiverClosed) {
            return;
        }

        eprintln!(
            "bridge realtime connection will reconnect for {}:{}",
            target.host.id, target.host.node_id
        );
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
        let last_confirmed_alive_ms = Arc::new(AtomicI64::new(now_ms()));
        let task = tokio::spawn(run_realtime_connection(
            manager.clone(),
            app.clone(),
            manager.local_server.clone(),
            target,
            last_confirmed_alive_ms.clone(),
            rx,
        ));
        runtime.connections.insert(
            node_id,
            RealtimeBridgeConnection {
                fingerprint,
                sender: tx,
                task,
                last_confirmed_alive_ms,
            },
        );
    }
}

pub(super) async fn refresh_realtime_connections(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeState, String> {
    evict_all_realtime_connections(manager).await;
    Ok(super::build_current_bridge_state(manager).await)
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

    let result =
        try_send_connected_realtime_payload(manager, host, target_node_id, None, payload, durable)
            .await;
    if result
        .as_ref()
        .is_err_and(|error| error.contains(REALTIME_STALE_CONNECTION_ERROR))
    {
        sync_realtime_connections(manager, &store).await;
        return try_send_connected_realtime_payload(
            manager,
            host,
            target_node_id,
            None,
            payload,
            durable,
        )
        .await;
    }

    result
}
