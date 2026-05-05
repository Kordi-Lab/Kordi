use kordi_tools::{ReachOutRequest, ReachOutResponse};
use serde::de::DeserializeOwned;
use tokio::time::{sleep, Duration};

use crate::chat::DesktopChatManager;

use super::constants::{
    is_agent_like_runtime, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
};
use super::conversation_commands::desktop_bridge_create_outreach_impl;
use super::mailbox::desktop_bridge_poll_mailbox_impl;
use super::{
    build_current_bridge_state, load_conversation_store, now_ms, save_conversation_store,
    DesktopBridgeCreateOutreachRequest, DesktopBridgeManager, DesktopBridgeSessionParticipant,
    DesktopBridgeSessionThreadMessage,
};

fn normalize_outreach_target(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn outreach_target_matches(peer: &super::DesktopBridgePeer, target: &str) -> bool {
    let normalized = normalize_outreach_target(target);
    if normalized.is_empty() {
        return false;
    }
    [
        Some(peer.node_id.as_str()),
        peer.display_name.as_deref(),
        peer.owner_name.as_deref(),
        peer.human_id.as_deref(),
        peer.agent_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|candidate| normalize_outreach_target(candidate) == normalized)
}

const RUNTIME_CONTEXT_PARTICIPANT_LIMIT: usize = 50;
const RUNTIME_CONTEXT_MESSAGE_LIMIT: usize = 16;
const RUNTIME_CONTEXT_MESSAGE_TEXT_LIMIT: usize = 700;
const RUNTIME_CONTEXT_SCALAR_LIMIT: usize = 240;

fn clean_runtime_scalar(value: &str, max_chars: usize) -> String {
    let cleaned = value.trim().replace(['\r', '\n'], " ");
    let char_count = cleaned.chars().count();
    if char_count <= max_chars {
        return cleaned;
    }
    if max_chars == 0 {
        return String::new();
    }
    let prefix_len = max_chars.saturating_sub(1);
    let mut truncated = cleaned.chars().take(prefix_len).collect::<String>();
    truncated.push('…');
    truncated
}

fn clean_runtime_optional_scalar(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| clean_runtime_scalar(&value, max_chars))
        .filter(|value| !value.is_empty())
}

fn sanitize_runtime_participant(
    mut participant: DesktopBridgeSessionParticipant,
) -> DesktopBridgeSessionParticipant {
    participant.identity_id =
        clean_runtime_optional_scalar(participant.identity_id, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.display_name =
        clean_runtime_scalar(&participant.display_name, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.kind =
        clean_runtime_optional_scalar(participant.kind, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.role =
        clean_runtime_optional_scalar(participant.role, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.owner_identity_id =
        clean_runtime_optional_scalar(participant.owner_identity_id, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.owner_display_name =
        clean_runtime_optional_scalar(participant.owner_display_name, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.bridge_node_id =
        clean_runtime_optional_scalar(participant.bridge_node_id, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.human_id =
        clean_runtime_optional_scalar(participant.human_id, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.agent_id =
        clean_runtime_optional_scalar(participant.agent_id, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant.runtime =
        clean_runtime_optional_scalar(participant.runtime, RUNTIME_CONTEXT_SCALAR_LIMIT);
    participant
}

fn sanitize_runtime_message(
    mut message: DesktopBridgeSessionThreadMessage,
) -> DesktopBridgeSessionThreadMessage {
    message.role = clean_runtime_scalar(&message.role, RUNTIME_CONTEXT_SCALAR_LIMIT);
    message.sender = clean_runtime_optional_scalar(message.sender, RUNTIME_CONTEXT_SCALAR_LIMIT);
    message.text = clean_runtime_scalar(&message.text, RUNTIME_CONTEXT_MESSAGE_TEXT_LIMIT);
    message.time_label =
        clean_runtime_optional_scalar(message.time_label, RUNTIME_CONTEXT_SCALAR_LIMIT);
    message
}

fn deserialize_runtime_context_array<T, F>(
    value: &Option<serde_json::Value>,
    label: &str,
    limit: usize,
    mut sanitize: F,
) -> Vec<T>
where
    T: DeserializeOwned,
    F: FnMut(T) -> T,
{
    let Some(value) = value.as_ref() else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        eprintln!("Ignoring malformed reach_out {label} runtime context: expected array");
        return Vec::new();
    };
    items
        .iter()
        .take(limit)
        .filter_map(|item| match serde_json::from_value::<T>(item.clone()) {
            Ok(item) => Some(sanitize(item)),
            Err(error) => {
                eprintln!("Ignoring malformed reach_out {label} runtime context entry: {error}");
                None
            }
        })
        .collect()
}

fn reach_out_parent_context_from_request(
    request: &ReachOutRequest,
) -> (
    Vec<DesktopBridgeSessionParticipant>,
    Vec<DesktopBridgeSessionThreadMessage>,
) {
    (
        deserialize_runtime_context_array(
            &request.parent_session_participants_json,
            "parentSessionParticipantsJson",
            RUNTIME_CONTEXT_PARTICIPANT_LIMIT,
            sanitize_runtime_participant,
        ),
        deserialize_runtime_context_array(
            &request.parent_session_messages_json,
            "parentSessionMessagesJson",
            RUNTIME_CONTEXT_MESSAGE_LIMIT,
            sanitize_runtime_message,
        ),
    )
}

fn infer_reach_out_kind(
    peer_runtime: &str,
    requested_kind: Option<&str>,
) -> Result<String, String> {
    match requested_kind.map(|value| value.trim().to_ascii_lowercase()) {
        Some(kind) if kind == "bridge-agent" => {
            if !is_agent_like_runtime(peer_runtime) {
                return Err("Selected outreach target is not a bridge agent".to_string());
            }
            Ok(kind)
        }
        Some(kind) if kind == "bridge-person" => Ok(kind),
        Some(_) => Err("reach_out targetKind must be bridge-agent or bridge-person".to_string()),
        None if is_agent_like_runtime(peer_runtime) => Ok("bridge-agent".to_string()),
        None => Ok("bridge-person".to_string()),
    }
}

fn find_outreach_response(
    conversation_id: &str,
    started_at_ms: i64,
    request_id: Option<&str>,
) -> Option<String> {
    let store = load_conversation_store();
    let conversation = store
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|message| {
            message.timestamp_ms >= started_at_ms
                && (message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
                    || message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND)
                && request_id.is_none_or(|request_id| {
                    message.request_id.as_deref() == Some(request_id)
                        || message.direction == BRIDGE_MESSAGE_DIRECTION_INBOUND
                })
                && !message.text.trim().is_empty()
        })
        .map(|message| message.text.clone())
}

fn latest_outreach_request_id(conversation_id: &str, started_at_ms: i64) -> Option<String> {
    let store = load_conversation_store();
    let conversation = store
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|message| {
            message.timestamp_ms >= started_at_ms
                && message.direction == BRIDGE_MESSAGE_DIRECTION_OUTBOUND
                && message.request_id.is_some()
        })
        .and_then(|message| message.request_id.clone())
}

pub(super) fn mark_outreach_status(
    conversation_id: &str,
    status: &str,
    completed: bool,
    error: Option<String>,
) -> Result<(), String> {
    let mut store = load_conversation_store();
    if let Some(conversation) = store
        .conversations
        .iter_mut()
        .find(|conversation| conversation.id == conversation_id)
    {
        if let Some(outreach) = conversation.outreach.as_mut() {
            outreach.status = status.to_string();
            outreach.updated_at_ms = now_ms();
            outreach.error = error;
            if completed {
                outreach.completed_at_ms = Some(now_ms());
            }
        }
    }
    save_conversation_store(&store)
}

pub(crate) async fn desktop_bridge_reach_out_impl(
    manager: &DesktopBridgeManager,
    chat_manager: &DesktopChatManager,
    request: ReachOutRequest,
) -> Result<ReachOutResponse, String> {
    let target = request.target.trim();
    let message = request.message.trim();
    if target.is_empty() {
        return Err("reach_out target is required".to_string());
    }
    if message.is_empty() {
        return Err("reach_out message is required".to_string());
    }

    let current_state = build_current_bridge_state(manager).await;
    let active_host_id = current_state.active_host_id.as_deref();
    let mut matches = current_state
        .hosts
        .iter()
        .flat_map(|host| host.visible_peers.iter().map(move |peer| (host, peer)))
        .filter(|(_, peer)| outreach_target_matches(peer, target))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(host, peer)| {
        let active_rank = if Some(host.id.as_str()) == active_host_id {
            0
        } else {
            1
        };
        let exact_rank = [
            Some(peer.node_id.as_str()),
            peer.display_name.as_deref(),
            peer.owner_name.as_deref(),
            peer.human_id.as_deref(),
            peer.agent_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|candidate| normalize_outreach_target(candidate) == normalize_outreach_target(target));
        (active_rank, if exact_rank { 0 } else { 1 })
    });
    let (host, peer) = matches
        .first()
        .ok_or_else(|| format!("No visible bridge target matched '{target}'"))?;
    let target_kind = infer_reach_out_kind(&peer.runtime, request.target_kind.as_deref())?;
    let started_at_ms = now_ms();

    let project_name = request.project_name.clone().or_else(|| {
        request
            .context
            .as_deref()
            .and_then(|context| {
                context
                    .lines()
                    .find_map(|line| line.strip_prefix("Project: "))
            })
            .map(ToString::to_string)
    });

    let (parent_session_participants, parent_session_messages) =
        reach_out_parent_context_from_request(&request);

    let state = desktop_bridge_create_outreach_impl(
        manager,
        DesktopBridgeCreateOutreachRequest {
            host_id: host.id.clone(),
            target_node_id: peer.node_id.clone(),
            target_kind: target_kind.clone(),
            request_text: message.to_string(),
            target_display_name: peer
                .display_name
                .clone()
                .or_else(|| peer.owner_name.clone()),
            target_owner_name: peer.owner_name.clone(),
            target_runtime: Some(peer.runtime.clone()),
            target_human_id: peer.human_id.clone(),
            target_agent_id: peer.agent_id.clone(),
            trigger_text: None,
            context_text: request.context.clone(),
            context_policy: Some(request.context_policy.clone()),
            parent_session_id: request.parent_session_id.clone(),
            parent_session_title: None,
            parent_session_kind: None,
            parent_group_space_id: None,
            parent_session_participants,
            parent_session_messages,
            initiator_identity: None,
            self_target_identity: None,
            permission_policy_hash: None,
            participant_graph_hash: None,
            parent_turn_id: request.parent_turn_id.clone(),
            parent_message_id: request.parent_message_id.clone(),
            bridge_request_id: None,
            delivery_state: None,
            project_id: request.project_id.clone(),
            project_name,
            attachment_paths: Vec::new(),
            attachment_names: Vec::new(),
        },
    )
    .await?;

    let conversation = state
        .conversations
        .iter()
        .find(|conversation| {
            conversation.host_id == host.id && conversation.peer_node_id == peer.node_id
        })
        .cloned()
        .ok_or_else(|| "Outreach conversation was not created".to_string())?;
    let conversation_id = conversation.id.clone();
    let request_id = latest_outreach_request_id(&conversation_id, started_at_ms);

    if !request.wait_for_response {
        return Ok(ReachOutResponse {
            conversation_id,
            target_kind,
            target_display_name: conversation.title,
            target_owner_name: conversation.peer_owner_name,
            response_text: None,
            status: "awaitingReply".to_string(),
            timed_out: false,
        });
    }

    let timeout_seconds = request.timeout_seconds.unwrap_or(120).clamp(5, 600);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let mut response_text =
        find_outreach_response(&conversation_id, started_at_ms, request_id.as_deref());
    while response_text.is_none() && std::time::Instant::now() < deadline {
        let _ = desktop_bridge_poll_mailbox_impl(manager, chat_manager).await;
        response_text =
            find_outreach_response(&conversation_id, started_at_ms, request_id.as_deref());
        if response_text.is_some() {
            break;
        }
        sleep(Duration::from_millis(1500)).await;
    }

    let timed_out = response_text.is_none();
    if timed_out {
        mark_outreach_status(&conversation_id, "awaitingReply", false, None)?;
    } else {
        mark_outreach_status(&conversation_id, "completed", true, None)?;
    }

    Ok(ReachOutResponse {
        conversation_id,
        target_kind,
        target_display_name: conversation.title,
        target_owner_name: conversation.peer_owner_name,
        response_text,
        status: if timed_out {
            "awaitingReply"
        } else {
            "completed"
        }
        .to_string(),
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const BOB_NODE_ID: &str = "bob-agent-node";
    const CHARLIE_NODE_ID: &str = "charlie-agent-node";
    const BOB_AGENT_ID: &str = "agent:bob-kordi";
    const CHARLIE_AGENT_ID: &str = "agent:charlie-kordi";

    struct MockBridgeServer {
        base_url: String,
        relay_bodies: Arc<Mutex<Vec<Value>>>,
        recipient_secret: x25519_dalek::StaticSecret,
    }

    fn http_body(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n");
            let Some(header_end) = header_end else {
                continue;
            };
            let header_text = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            let body_start = header_end + 4;
            if buffer.len() >= body_start + content_length {
                let request_line = header_text.lines().next()?.to_string();
                let mut parts = request_line.split_whitespace();
                let method = parts.next()?.to_string();
                let path = parts.next()?.to_string();
                return Some((
                    method,
                    path,
                    buffer[body_start..body_start + content_length].to_vec(),
                ));
            }
        }
        None
    }

    fn write_json_response(stream: &mut TcpStream, status: &str, body: Value) {
        let body = body.to_string();
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    }

    fn spawn_mock_bridge_server() -> MockBridgeServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock bridge server");
        let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let relay_bodies = Arc::new(Mutex::new(Vec::new()));
        let recipient_secret = x25519_dalek::StaticSecret::from([7_u8; 32]);
        let recipient_public = x25519_dalek::PublicKey::from(&recipient_secret);
        let recipient_public_hex = hex::encode(recipient_public.as_bytes());
        let relay_bodies_for_thread = relay_bodies.clone();

        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let Some((method, path, body)) = http_body(&mut stream) else {
                    continue;
                };
                match (method.as_str(), path.as_str()) {
                    ("GET", "/health") => {
                        write_json_response(&mut stream, "200 OK", json!({"ok": true}))
                    }
                    ("GET", "/v1/discovery") => write_json_response(
                        &mut stream,
                        "200 OK",
                        json!([
                            {
                                "nodeId": BOB_NODE_ID,
                                "displayName": "Bob's Kordi",
                                "ownerName": "Bob",
                                "runtime": "kordi-desktop",
                                "humanId": "human:bob",
                                "agentId": BOB_AGENT_ID,
                                "isDefaultAgent": true,
                                "discoveryMode": "open"
                            },
                            {
                                "nodeId": CHARLIE_NODE_ID,
                                "displayName": "Charlie's Kordi",
                                "ownerName": "Charlie",
                                "runtime": "kordi-desktop",
                                "humanId": "human:charlie",
                                "agentId": CHARLIE_AGENT_ID,
                                "isDefaultAgent": true,
                                "discoveryMode": "open"
                            }
                        ]),
                    ),
                    ("GET", "/v1/contacts") | ("GET", "/v1/projects") => {
                        write_json_response(&mut stream, "200 OK", json!([]))
                    }
                    ("GET", path) if path.starts_with("/v1/keys/") => {
                        let node_id = path.trim_start_matches("/v1/keys/");
                        write_json_response(
                            &mut stream,
                            "200 OK",
                            json!({
                                "nodeId": node_id,
                                "x25519Pubkey": recipient_public_hex,
                            }),
                        );
                    }
                    ("POST", "/v1/relay") => {
                        let body = serde_json::from_slice::<Value>(&body).expect("relay body json");
                        relay_bodies_for_thread
                            .lock()
                            .expect("relay bodies lock")
                            .push(body);
                        write_json_response(&mut stream, "200 OK", json!({"ok": true}));
                    }
                    _ => write_json_response(
                        &mut stream,
                        "404 Not Found",
                        json!({"error": "not found"}),
                    ),
                }
            }
        });

        MockBridgeServer {
            base_url,
            relay_bodies,
            recipient_secret,
        }
    }

    fn bridge_e2ee_key(shared: &[u8; 32], sender_node_id: &str, target_node_id: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"kordi-desktop-bridge-e2ee-v1");
        hasher.update(shared);
        hasher.update(sender_node_id.as_bytes());
        hasher.update([0]);
        hasher.update(target_node_id.as_bytes());
        hasher.finalize().into()
    }

    fn decrypt_relay_blob(server: &MockBridgeServer, relay_body: &Value) -> Value {
        let blob = relay_body["blob"].as_str().expect("relay blob");
        let envelope_bytes = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .expect("decode relay blob");
        let envelope =
            serde_json::from_slice::<Value>(&envelope_bytes).expect("relay envelope json");
        let sender_node_id = envelope["from"].as_str().expect("sender node id");
        let target_node_id = envelope["to"].as_str().expect("target node id");
        let sender_ed25519_pubkey = envelope["senderEd25519Pubkey"]
            .as_str()
            .expect("sender pubkey");
        let sender_ed25519_bytes: [u8; 32] = bs58::decode(sender_ed25519_pubkey)
            .into_vec()
            .expect("decode sender pubkey")
            .try_into()
            .expect("sender pubkey length");
        let sender_x25519 = crate::bridge::storage::ed25519_to_x25519_public(&sender_ed25519_bytes)
            .expect("sender x25519 pubkey");
        let sender_public = x25519_dalek::PublicKey::from(sender_x25519);
        let shared = server.recipient_secret.diffie_hellman(&sender_public);
        let key_bytes = bridge_e2ee_key(shared.as_bytes(), sender_node_id, target_node_id);
        let nonce = base64::engine::general_purpose::STANDARD
            .decode(envelope["nonce"].as_str().expect("nonce"))
            .expect("decode nonce");
        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(envelope["ciphertext"].as_str().expect("ciphertext"))
            .expect("decode ciphertext");
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key_bytes));
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .expect("decrypt relay payload");
        serde_json::from_slice(&plaintext).expect("relay payload json")
    }

    fn reach_out_request_with_runtime_context(
        participants_json: Option<serde_json::Value>,
        messages_json: Option<serde_json::Value>,
    ) -> ReachOutRequest {
        ReachOutRequest {
            target: "Bob's Kordi".to_string(),
            target_kind: Some("bridge-agent".to_string()),
            message: "Can you review this?".to_string(),
            context: None,
            context_policy: "recent-window".to_string(),
            include_project_context: true,
            wait_for_response: false,
            timeout_seconds: None,
            parent_session_id: Some("session:alice-bob".to_string()),
            parent_turn_id: None,
            parent_message_id: None,
            project_id: None,
            project_name: None,
            parent_session_participants_json: participants_json,
            parent_session_messages_json: messages_json,
        }
    }

    #[test]
    fn reach_out_runtime_context_deserializes_parent_participants_and_messages() {
        let request = reach_out_request_with_runtime_context(
            Some(json!([
                {
                    "identityId": "human:alice",
                    "displayName": "Alice",
                    "kind": "human",
                    "role": "requester"
                },
                {
                    "identityId": "agent:bob-kordi",
                    "displayName": "Bob's Kordi",
                    "kind": "agent",
                    "role": "target",
                    "ownerIdentityId": "human:bob",
                    "ownerDisplayName": "Bob"
                }
            ])),
            Some(json!([
                {
                    "role": "person",
                    "sender": "Alice",
                    "text": "@Bob's Kordi can you review this?",
                    "timeLabel": null,
                    "index": 1
                }
            ])),
        );

        let (participants, messages) = reach_out_parent_context_from_request(&request);

        assert_eq!(participants.len(), 2);
        assert_eq!(
            participants[1].identity_id.as_deref(),
            Some("agent:bob-kordi")
        );
        assert_eq!(
            participants[1].owner_identity_id.as_deref(),
            Some("human:bob")
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sender.as_deref(), Some("Alice"));
        assert_eq!(messages[0].text, "@Bob's Kordi can you review this?");
    }

    #[test]
    fn malformed_reach_out_runtime_context_falls_back_to_empty_vectors() {
        let request = reach_out_request_with_runtime_context(
            Some(json!({ "not": "an array" })),
            Some(json!([{"role": 3, "text": []}])),
        );

        let (participants, messages) = reach_out_parent_context_from_request(&request);

        assert!(participants.is_empty());
        assert!(messages.is_empty());
    }

    #[test]
    fn reach_out_runtime_context_caps_oversized_parent_arrays() {
        let participants_json = (0..60)
            .map(|index| {
                json!({
                    "identityId": format!("human:{index}"),
                    "displayName": format!("Participant {index}"),
                    "kind": "human",
                    "role": "participant"
                })
            })
            .collect::<Vec<_>>();
        let messages_json = (0..20)
            .map(|index| {
                json!({
                    "role": "person",
                    "sender": "Alice",
                    "text": format!("message {index}"),
                    "index": index
                })
            })
            .collect::<Vec<_>>();
        let request = reach_out_request_with_runtime_context(
            Some(json!(participants_json)),
            Some(json!(messages_json)),
        );

        let (participants, messages) = reach_out_parent_context_from_request(&request);

        assert_eq!(participants.len(), 50);
        assert_eq!(messages.len(), 16);
        assert_eq!(
            participants.last().unwrap().identity_id.as_deref(),
            Some("human:49")
        );
        assert_eq!(messages.last().unwrap().index, Some(15));
    }

    #[test]
    fn reach_out_runtime_context_truncates_oversized_scalar_fields() {
        let long_display_name = "Alice".repeat(80);
        let long_text = "🙂".repeat(800);
        let request = reach_out_request_with_runtime_context(
            Some(json!([{
                "identityId": "human:alice",
                "displayName": long_display_name,
                "kind": "human",
                "role": "participant"
            }])),
            Some(json!([{
                "role": "person",
                "sender": "Alice",
                "text": long_text,
                "timeLabel": "now",
                "index": 1
            }])),
        );

        let (participants, messages) = reach_out_parent_context_from_request(&request);

        assert_eq!(participants[0].display_name.chars().count(), 240);
        assert!(participants[0].display_name.ends_with('…'));
        assert_eq!(messages[0].text.chars().count(), 700);
        assert!(messages[0].text.ends_with('…'));
    }

    #[test]
    fn malformed_reach_out_runtime_context_entries_do_not_drop_valid_neighbors() {
        let request = reach_out_request_with_runtime_context(
            Some(json!([
                {
                    "identityId": "human:alice",
                    "displayName": "Alice",
                    "kind": "human",
                    "role": "requester"
                },
                {"displayName": 7, "kind": []},
                {
                    "identityId": "agent:bob-kordi",
                    "displayName": "Bob's Kordi",
                    "kind": "agent",
                    "role": "target"
                }
            ])),
            Some(json!([
                {"role": "person", "sender": "Alice", "text": "valid one", "index": 1},
                {"role": 3, "text": []},
                {"role": "agent", "sender": "Bob's Kordi", "text": "valid two", "index": 2}
            ])),
        );

        let (participants, messages) = reach_out_parent_context_from_request(&request);

        assert_eq!(participants.len(), 2);
        assert_eq!(participants[0].display_name, "Alice");
        assert_eq!(participants[1].display_name, "Bob's Kordi");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text, "valid one");
        assert_eq!(messages[1].text, "valid two");
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    struct CanonicalTestDbGuard {
        storage_root: std::path::PathBuf,
    }

    impl CanonicalTestDbGuard {
        fn new(storage_root: std::path::PathBuf) -> Self {
            crate::canonical_sessions::set_canonical_sessions_test_db_path(Some(
                storage_root.join("canonical-sessions.sqlite3"),
            ));
            Self { storage_root }
        }
    }

    impl Drop for CanonicalTestDbGuard {
        fn drop(&mut self) {
            crate::canonical_sessions::set_canonical_sessions_test_db_path(None);
            let _ = std::fs::remove_dir_all(&self.storage_root);
        }
    }

    fn upsert_runtime_identity(
        id: &str,
        display_name: &str,
        kind: &str,
        owner_identity_id: Option<&str>,
        source: &str,
    ) {
        crate::canonical_sessions::desktop_canonical_upsert_identity(
            crate::canonical_sessions::UpsertCanonicalIdentityRequest {
                id: Some(id.to_string()),
                kind: kind.to_string(),
                display_name: display_name.to_string(),
                owner_identity_id: owner_identity_id.map(ToString::to_string),
                source: Some(source.to_string()),
                source_host_id: None,
                bridge_node_id: source
                    .eq_ignore_ascii_case("bridge")
                    .then(|| format!("node-{}", id.replace(':', "-"))),
                human_id: kind
                    .eq_ignore_ascii_case("human")
                    .then(|| id.trim_start_matches("human:").to_string()),
                agent_id: kind
                    .eq_ignore_ascii_case("agent")
                    .then(|| id.trim_start_matches("agent:").to_string()),
                avatar_key: Some(id.to_string()),
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert runtime identity");
    }

    #[tokio::test]
    async fn reach_out_runtime_populates_parent_context_from_canonical_session() {
        let storage_root = std::env::temp_dir().join(format!(
            "kordi-reach-out-runtime-context-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _storage_env_lock = crate::bridge::STORAGE_ENV_TEST_LOCK
            .lock()
            .expect("storage env test lock");
        let _app_data_guard = EnvVarGuard::set("APP_DATA_DIR", &storage_root);
        let _storage_root_guard = EnvVarGuard::set("KORDI_STORAGE_ROOT", &storage_root);
        let _canonical_db_guard = CanonicalTestDbGuard::new(storage_root.clone());
        let server = spawn_mock_bridge_server();
        crate::bridge::save_bridge_store(&crate::bridge::DesktopBridgeStore {
            active_host_id: Some("host-runtime".to_string()),
            local_agent_routing: crate::bridge::DesktopBridgeAgentRouting::default(),
            hosts: vec![crate::bridge::DesktopBridgeHostConfig {
                id: "host-runtime".to_string(),
                coordination: server.base_url.clone(),
                node_id: "alice-node".to_string(),
                api_key: "secret".to_string(),
                display_name: Some("Alice's Kordi".to_string()),
                owner: Some("Alice".to_string()),
                human_id: Some("human:alice".to_string()),
                discovery_mode: "open".to_string(),
                active_agent_id: None,
                agents: Vec::new(),
                api_style: crate::bridge::constants::API_STYLE_SERVE.to_string(),
            }],
        })
        .expect("save bridge store");
        crate::bridge::save_conversation_store(
            &crate::bridge::DesktopBridgeConversationStore::default(),
        )
        .expect("save empty conversation store");

        upsert_runtime_identity("human:alice", "Alice", "human", None, "local");
        upsert_runtime_identity(
            "agent:alice-kordi",
            "Alice's Kordi",
            "agent",
            Some("human:alice"),
            "local",
        );
        upsert_runtime_identity("human:bob", "Bob", "human", None, "bridge");
        upsert_runtime_identity(
            "agent:bob-kordi",
            "Bob's Kordi",
            "agent",
            Some("human:bob"),
            "bridge",
        );
        let session_id = "session:runtime-parent";
        crate::canonical_sessions::desktop_canonical_open_or_create_session(
            crate::canonical_sessions::OpenCanonicalSessionRequest {
                id: Some(session_id.to_string()),
                kind: "group".to_string(),
                title: Some("Runtime parent".to_string()),
                status: Some("active".to_string()),
                created_by_identity_id: "human:alice".to_string(),
                primary_identity_id: Some("agent:alice-kordi".to_string()),
                project_id: None,
                project_name: None,
                relationship_identity_id: None,
                participant_identity_ids: vec![
                    "human:alice".to_string(),
                    "agent:alice-kordi".to_string(),
                    "human:bob".to_string(),
                    "agent:bob-kordi".to_string(),
                ],
                metadata: None,
            },
        )
        .expect("create runtime parent session");
        crate::canonical_sessions::desktop_canonical_append_message_fast(
            crate::canonical_sessions::AppendCanonicalMessageRequest {
                id: Some("message:runtime-parent-1".to_string()),
                session_id: session_id.to_string(),
                sender_identity_id: "human:alice".to_string(),
                sender_role: "person".to_string(),
                message_kind: "text".to_string(),
                content_text: "@Bob's Kordi can you review this?".to_string(),
                content: None,
                created_at_ms: Some(1_000),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: None,
                source_transport: None,
                source_event_id: None,
            },
        )
        .expect("append runtime parent message");

        let runtime = crate::chat::bridge_outreach::build_reach_out_runtime(
            DesktopBridgeManager::default(),
            DesktopChatManager::default(),
            storage_root.clone(),
            session_id.to_string(),
            "@Bob's Kordi can you review this?".to_string(),
            vec!["Kordi".to_string(), "Alice's Kordi".to_string()],
        );
        let response = (runtime.reach_out)(ReachOutRequest {
            target: "Bob's Kordi".to_string(),
            target_kind: Some("bridge-agent".to_string()),
            message: "Can you review this?".to_string(),
            context: None,
            context_policy: "session-message".to_string(),
            include_project_context: false,
            wait_for_response: false,
            timeout_seconds: None,
            parent_session_id: None,
            parent_turn_id: None,
            parent_message_id: None,
            project_id: None,
            project_name: None,
            parent_session_participants_json: None,
            parent_session_messages_json: None,
        })
        .await
        .expect("reach out through runtime closure");

        assert_eq!(response.target_display_name, "Bob's Kordi");
        assert_eq!(server.relay_bodies.lock().expect("relay bodies").len(), 1);
        let store = crate::bridge::load_conversation_store();
        let outreach = store.conversations[0]
            .outreach
            .as_ref()
            .expect("outreach metadata");
        assert_eq!(outreach.parent_session_id.as_deref(), Some(session_id));
        assert_eq!(outreach.parent_session_participants.len(), 4);
        assert!(outreach
            .parent_session_participants
            .iter()
            .any(|participant| {
                participant.identity_id.as_deref() == Some("agent:bob-kordi")
                    && participant.display_name == "Bob's Kordi"
            }));
        assert_eq!(outreach.parent_session_messages.len(), 1);
        assert_eq!(
            outreach.parent_session_messages[0].text,
            "@Bob's Kordi can you review this?"
        );
    }

    #[tokio::test]
    async fn reach_out_scopes_session_thread_to_explicit_agent_target_when_another_agent_is_visible(
    ) {
        let storage_root = std::env::temp_dir().join(format!(
            "kordi-reach-out-explicit-target-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _storage_env_guard = crate::bridge::STORAGE_ENV_TEST_LOCK
            .lock()
            .expect("storage env test lock");
        std::env::set_var("APP_DATA_DIR", &storage_root);
        std::env::set_var("KORDI_STORAGE_ROOT", &storage_root);
        let server = spawn_mock_bridge_server();
        crate::bridge::save_bridge_store(&crate::bridge::DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            local_agent_routing: crate::bridge::DesktopBridgeAgentRouting::default(),
            hosts: vec![crate::bridge::DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: server.base_url.clone(),
                node_id: "alice-node".to_string(),
                api_key: "secret".to_string(),
                display_name: Some("Alice's Kordi".to_string()),
                owner: Some("Alice".to_string()),
                human_id: Some("human:alice".to_string()),
                discovery_mode: "open".to_string(),
                active_agent_id: None,
                agents: Vec::new(),
                api_style: crate::bridge::constants::API_STYLE_SERVE.to_string(),
            }],
        })
        .expect("save bridge store");
        crate::bridge::save_conversation_store(
            &crate::bridge::DesktopBridgeConversationStore::default(),
        )
        .expect("save empty conversation store");

        let user_text = "@Bob's Kordi can you review this?";
        let request = ReachOutRequest {
            target: "Bob's Kordi".to_string(),
            target_kind: Some("bridge-agent".to_string()),
            message: "Can you review this?".to_string(),
            context: Some(format!("Current user message: {user_text}")),
            context_policy: "session-message".to_string(),
            include_project_context: false,
            wait_for_response: false,
            timeout_seconds: None,
            parent_session_id: Some("session:group:review".to_string()),
            parent_turn_id: None,
            parent_message_id: Some("msg-user-1".to_string()),
            project_id: None,
            project_name: None,
            parent_session_participants_json: Some(json!([
                {
                    "identityId": "human:alice",
                    "displayName": "Alice",
                    "kind": "human",
                    "role": "requester",
                    "bridgeNodeId": "alice-node",
                    "humanId": "human:alice",
                    "runtime": "person"
                },
                {
                    "identityId": BOB_AGENT_ID,
                    "displayName": "Bob's Kordi",
                    "kind": "agent",
                    "role": "target",
                    "ownerIdentityId": "human:bob",
                    "ownerDisplayName": "Bob",
                    "bridgeNodeId": BOB_NODE_ID,
                    "humanId": "human:bob",
                    "agentId": BOB_AGENT_ID,
                    "runtime": "kordi-desktop"
                },
                {
                    "identityId": CHARLIE_AGENT_ID,
                    "displayName": "Charlie's Kordi",
                    "kind": "agent",
                    "role": "participant",
                    "ownerIdentityId": "human:charlie",
                    "ownerDisplayName": "Charlie",
                    "bridgeNodeId": CHARLIE_NODE_ID,
                    "humanId": "human:charlie",
                    "agentId": CHARLIE_AGENT_ID,
                    "runtime": "kordi-desktop"
                }
            ])),
            parent_session_messages_json: Some(json!([
                {
                    "role": "person",
                    "sender": "Alice",
                    "text": user_text,
                    "timeLabel": null,
                    "index": 1
                }
            ])),
        };

        let response = desktop_bridge_reach_out_impl(
            &DesktopBridgeManager::default(),
            &DesktopChatManager::default(),
            request,
        )
        .await
        .expect("reach out to Bob's Kordi");

        assert_eq!(response.target_display_name, "Bob's Kordi");
        let store = crate::bridge::load_conversation_store();
        let conversation = store
            .conversations
            .iter()
            .find(|conversation| conversation.peer_node_id == BOB_NODE_ID)
            .expect("Bob conversation");
        assert!(
            store
                .conversations
                .iter()
                .all(|conversation| conversation.peer_node_id != CHARLIE_NODE_ID),
            "unmentioned Charlie target should not get an outreach conversation"
        );
        let outreach = conversation
            .outreach
            .as_ref()
            .expect("conversation outreach");
        assert_eq!(outreach.target_node_id, BOB_NODE_ID);
        assert_eq!(outreach.target_display_name, "Bob's Kordi");
        assert_eq!(outreach.target_agent_id.as_deref(), Some(BOB_AGENT_ID));
        assert_ne!(outreach.target_node_id, CHARLIE_NODE_ID);
        assert_ne!(outreach.target_display_name, "Charlie's Kordi");
        assert_ne!(outreach.target_agent_id.as_deref(), Some(CHARLIE_AGENT_ID));

        let outbound = conversation
            .messages
            .iter()
            .find(|message| {
                message.direction == crate::bridge::constants::BRIDGE_MESSAGE_DIRECTION_OUTBOUND
            })
            .expect("outbound outreach message");
        let message_outreach = outbound
            .outreach
            .as_ref()
            .expect("message outreach metadata");
        assert_eq!(message_outreach.target_node_id, BOB_NODE_ID);
        assert_eq!(message_outreach.target_display_name, "Bob's Kordi");
        assert_eq!(
            message_outreach.target_agent_id.as_deref(),
            Some(BOB_AGENT_ID)
        );

        let relay_bodies = server.relay_bodies.lock().expect("relay bodies");
        assert_eq!(relay_bodies.len(), 1);
        assert_eq!(relay_bodies[0]["targetNodeId"], BOB_NODE_ID);
        assert_ne!(relay_bodies[0]["targetNodeId"], CHARLIE_NODE_ID);
        let outbound_payload = decrypt_relay_blob(&server, &relay_bodies[0]);
        let session_thread = &outbound_payload["payload"]["sessionThread"];
        assert_eq!(session_thread["targetNodeId"], BOB_NODE_ID);
        assert_eq!(session_thread["targetDisplayName"], "Bob's Kordi");
        assert_eq!(session_thread["targetAgentId"], BOB_AGENT_ID);
        assert_ne!(session_thread["targetNodeId"], CHARLIE_NODE_ID);
        assert_ne!(session_thread["targetDisplayName"], "Charlie's Kordi");

        std::env::remove_var("APP_DATA_DIR");
        std::env::remove_var("KORDI_STORAGE_ROOT");
        let _ = std::fs::remove_dir_all(storage_root);
    }
}
