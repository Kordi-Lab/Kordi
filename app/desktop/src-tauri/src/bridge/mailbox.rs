use serde_json::Value;

use crate::chat::{run_bridge_agent_prompt, DesktopBridgeAgentModelRouting, DesktopChatManager};

use super::constants::{
    is_agent_like_runtime, BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_TYPE_ASK,
    BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT,
    BRIDGE_MESSAGE_TYPE_RESPONSE, BRIDGE_MESSAGE_TYPE_TYPING, DEFAULT_BRIDGE_RUNTIME,
};
use super::conversation_actions::rebuild_state_after_mailbox_poll;
use super::events::{
    identity_snapshot_for_event, mailbox_payload_agent_prompt_text, mailbox_payload_attachments,
    mailbox_payload_text, outreach_metadata_for_event, parse_bridge_event_payload,
    sanitize_agent_response_for_event, sender_name_for_runtime, ParsedMailboxEvent,
};
use super::outreach::mark_outreach_status;
use super::{
    append_conversation_message_to_storage, bridge_conversation_id, bridge_request_is_cancelled,
    decrypt_bridge_payload_for_host, fetch_mailbox, load_bridge_store, load_conversation_store,
    note_peer_heartbeat_in_storage, note_peer_typing_in_storage, parse_mailbox_payload,
    relay_plaintext_message, update_message_delivery_state_in_storage, DesktopBridgeHostConfig,
    DesktopBridgeManager, DesktopBridgeState, DesktopBridgeStore,
};

#[derive(Clone)]
struct LocalBridgeMailboxTarget {
    host: DesktopBridgeHostConfig,
    sender_runtime: String,
    sender_agent_id: Option<String>,
    owner_node_id: Option<String>,
    model_routing: Option<DesktopBridgeAgentModelRouting>,
    should_process_agent_asks: bool,
}

pub(super) fn parse_mailbox_event(
    host: &DesktopBridgeHostConfig,
    item: &Value,
) -> Option<ParsedMailboxEvent> {
    let blob = item
        .get("blob")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if blob.trim().is_empty() {
        return None;
    }

    let mut parsed = decrypt_bridge_payload_for_host(host, parse_mailbox_payload(blob)?).ok()?;
    if parsed.get("from").is_none() {
        if let Some(from) = item.get("from") {
            parsed["from"] = from.clone();
        }
    }
    parse_bridge_event_payload(&parsed)
}

fn bridge_response_is_done(event: &ParsedMailboxEvent) -> bool {
    event
        .payload
        .get("done")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn is_processing_placeholder_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("processing")
        || trimmed.eq_ignore_ascii_case("processing...")
        || trimmed.eq_ignore_ascii_case("processing…")
}

fn should_buffer_partial_agent_response(event: &ParsedMailboxEvent) -> bool {
    if bridge_response_is_done(event) {
        return false;
    }
    if !is_agent_like_runtime(event.from_runtime.as_deref().unwrap_or_default()) {
        return false;
    }

    let text = mailbox_payload_text(&event.payload);
    let normalized = text.trim();
    if event_targets_group_session(event) && is_processing_placeholder_text(normalized) {
        return false;
    }
    if normalized.is_empty() {
        return true;
    }

    let word_count = normalized.split_whitespace().take(5).count();
    normalized.chars().count() < 24 && word_count <= 3
}

fn event_session_thread(event: &ParsedMailboxEvent) -> Option<&Value> {
    event.payload.get("sessionThread")
}

fn event_session_thread_target_kind(event: &ParsedMailboxEvent) -> Option<&str> {
    event_session_thread(event)
        .and_then(|thread| thread.get("targetKind"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn event_session_thread_has_parent_turn(event: &ParsedMailboxEvent) -> bool {
    event_session_thread(event)
        .and_then(|thread| thread.get("parentTurnId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn event_targets_group_session(event: &ParsedMailboxEvent) -> bool {
    let Some(thread) = event_session_thread(event) else {
        return false;
    };
    thread
        .get("parentSessionKind")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || thread
            .get("parentGroupSpaceId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

fn group_session_thread_relay_targets(
    event: &ParsedMailboxEvent,
    local_node_id: &str,
    local_owner_node_id: Option<&str>,
    requester_node_id: &str,
) -> Vec<String> {
    if !event_targets_group_session(event) {
        return Vec::new();
    }
    let local_node_id = local_node_id.trim();
    let local_owner_node_id = local_owner_node_id.map(str::trim).unwrap_or("");
    let requester_node_id = requester_node_id.trim();
    let mut targets = Vec::new();
    if let Some(participants) = event_session_thread(event)
        .and_then(|thread| thread.get("participants"))
        .and_then(|value| value.as_array())
    {
        for participant in participants {
            let Some(node_id) = participant
                .get("bridgeNodeId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if node_id == local_node_id
                || node_id == local_owner_node_id
                || node_id == requester_node_id
            {
                continue;
            }
            if !targets.iter().any(|existing| existing == node_id) {
                targets.push(node_id.to_string());
            }
        }
    }
    targets
}

fn bridge_response_payload(event: &ParsedMailboxEvent, message: &str, done: bool) -> Value {
    let mut payload = serde_json::json!({ "message": message, "done": done });
    if let Some(thread) = event_session_thread(event) {
        payload["sessionThread"] = thread.clone();
    }
    payload
}

async fn fanout_group_agent_response(
    target: &LocalBridgeMailboxTarget,
    event: &ParsedMailboxEvent,
    message: &str,
    done: bool,
) {
    let relay_targets = group_session_thread_relay_targets(
        event,
        target.host.node_id.as_str(),
        target.owner_node_id.as_deref(),
        event.from_node_id.as_str(),
    );
    if relay_targets.is_empty() {
        return;
    }
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
        "payload": bridge_response_payload(event, message, done),
    });
    for relay_target in relay_targets {
        let _ = relay_plaintext_message(
            &target.host,
            &relay_target,
            event.project_id.as_deref(),
            &response,
        )
        .await;
    }
}

fn storage_peer_runtime_for_inbound_event(
    event: &ParsedMailboxEvent,
    fallback: Option<&str>,
) -> String {
    if event_session_thread_target_kind(event)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("bridge-person"))
    {
        return "person".to_string();
    }

    event
        .from_runtime
        .clone()
        .or_else(|| fallback.map(ToString::to_string))
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string())
}

fn sender_runtime_for_inbound_event(
    event: &ParsedMailboxEvent,
    storage_peer_runtime: &str,
) -> String {
    event
        .from_runtime
        .clone()
        .unwrap_or_else(|| storage_peer_runtime.to_string())
}

fn direction_for_inbound_event(event: &ParsedMailboxEvent) -> &'static str {
    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE
        || event_session_thread_has_parent_turn(event)
    {
        BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
    } else {
        BRIDGE_MESSAGE_DIRECTION_INBOUND
    }
}

fn mailbox_targets(store: &DesktopBridgeStore) -> Vec<LocalBridgeMailboxTarget> {
    let mut targets: Vec<LocalBridgeMailboxTarget> = Vec::new();

    let mut upsert_target = |target: LocalBridgeMailboxTarget| {
        if let Some(existing) = targets
            .iter_mut()
            .find(|existing| existing.host.node_id == target.host.node_id)
        {
            if target.should_process_agent_asks || !existing.should_process_agent_asks {
                *existing = target;
            }
            return;
        }
        targets.push(target);
    };

    for host in &store.hosts {
        if !host.node_id.trim().is_empty() && !host.api_key.trim().is_empty() {
            upsert_target(LocalBridgeMailboxTarget {
                host: host.clone(),
                sender_runtime: "person".to_string(),
                sender_agent_id: None,
                owner_node_id: Some(host.node_id.clone()),
                model_routing: None,
                should_process_agent_asks: false,
            });
        }

        for agent in &host.agents {
            if agent.node_id.trim().is_empty() || agent.api_key.trim().is_empty() {
                continue;
            }
            upsert_target(LocalBridgeMailboxTarget {
                host: DesktopBridgeHostConfig {
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
                },
                sender_runtime: agent.runtime.clone(),
                sender_agent_id: Some(agent.id.clone()),
                owner_node_id: Some(host.node_id.clone()),
                model_routing: Some(DesktopBridgeAgentModelRouting {
                    default_model: agent.default_model.clone(),
                    default_auth_provider: agent.default_auth_provider.clone(),
                    default_auth_choice: agent.default_auth_choice.clone(),
                    fallback_model: agent.fallback_model.clone(),
                    fallback_auth_provider: agent.fallback_auth_provider.clone(),
                    fallback_auth_choice: agent.fallback_auth_choice.clone(),
                    thinking: agent.thinking.clone(),
                }),
                should_process_agent_asks: true,
            });
        }
    }

    targets
}

async fn acknowledge_inbound_delivery(host: &DesktopBridgeHostConfig, event: &ParsedMailboxEvent) {
    if let Some(request_id) = event.request_id.as_deref() {
        let ack = serde_json::json!({
            "from": host.node_id,
            "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
            "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_DELIVERED },
        });
        let _ =
            relay_plaintext_message(host, &event.from_node_id, event.project_id.as_deref(), &ack)
                .await;
    }
}

fn append_inbound_event_message_to_storage(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
) -> Result<Option<String>, String> {
    let text = mailbox_payload_text(&event.payload);
    let attachments = mailbox_payload_attachments(&event.payload)?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Ok(None);
    }

    let conversations = load_conversation_store();
    let base_conversation_id =
        bridge_conversation_id(&host.id, &event.from_node_id, event.project_id.as_deref());
    let base_existing = conversations
        .conversations
        .iter()
        .find(|conversation| conversation.id == base_conversation_id);
    let peer_runtime = storage_peer_runtime_for_inbound_event(
        event,
        base_existing.map(|conversation| conversation.peer_runtime.as_str()),
    );
    let person_conversation_id = format!("{base_conversation_id}:person");
    let existing = if peer_runtime.trim().eq_ignore_ascii_case("person") {
        conversations
            .conversations
            .iter()
            .find(|conversation| conversation.id == person_conversation_id)
            .or(base_existing)
    } else {
        base_existing
    };
    let peer_owner_name = event
        .from_owner_name
        .clone()
        .or_else(|| existing.and_then(|conversation| conversation.peer_owner_name.clone()));
    let peer_display_name = if peer_runtime.trim().eq_ignore_ascii_case("person") {
        peer_owner_name
            .clone()
            .or_else(|| existing.and_then(|conversation| conversation.peer_display_name.clone()))
            .or_else(|| event.from_display_name.clone())
    } else {
        event
            .from_display_name
            .clone()
            .or_else(|| existing.and_then(|conversation| conversation.peer_display_name.clone()))
    };
    let sender_runtime = sender_runtime_for_inbound_event(event, &peer_runtime);
    let sender_name = sender_name_for_runtime(
        &sender_runtime,
        event
            .from_display_name
            .as_deref()
            .or(peer_display_name.as_deref()),
        peer_owner_name.as_deref(),
        &event.from_node_id,
    );
    let identity_snapshot = identity_snapshot_for_event(host, event, &peer_runtime);
    let outreach = outreach_metadata_for_event(host, event, &peer_runtime);

    let payload_delivery_state = event
        .payload
        .get("deliveryState")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);

    append_conversation_message_to_storage(
        &host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        event.project_id.clone(),
        None,
        Some(identity_snapshot),
        outreach,
        direction_for_inbound_event(event),
        Some(sender_name),
        text.clone(),
        event.request_id.clone(),
        if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
            Some(if bridge_response_is_done(event) {
                BRIDGE_DELIVERY_STATE_RESPONDED.to_string()
            } else {
                "processing".to_string()
            })
        } else {
            payload_delivery_state
        },
        attachments,
        true,
    )?;
    Ok(Some(text))
}

pub(super) async fn apply_bridge_event_to_storage(
    host: &DesktopBridgeHostConfig,
    event: ParsedMailboxEvent,
    acknowledge_delivery: bool,
) -> Result<(), String> {
    if event.message_type == BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT {
        if let Some(target_request_id) = event
            .payload
            .get("requestId")
            .and_then(|value| value.as_str())
        {
            let state = event
                .payload
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or(BRIDGE_DELIVERY_STATE_DELIVERED);
            update_message_delivery_state_in_storage(target_request_id, state)?;
        }
        return Ok(());
    }

    match event.message_type.as_str() {
        BRIDGE_MESSAGE_TYPE_TYPING => {
            note_peer_typing_in_storage(
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            )?;
            return Ok(());
        }
        BRIDGE_MESSAGE_TYPE_HEARTBEAT => {
            note_peer_heartbeat_in_storage(
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            )?;
            return Ok(());
        }
        _ => {}
    }

    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE
        && should_buffer_partial_agent_response(&event)
    {
        note_peer_typing_in_storage(
            &host.id,
            &event.from_node_id,
            event.project_id.clone(),
            None,
        )?;
        return Ok(());
    }

    if append_inbound_event_message_to_storage(host, &event)?.is_none() {
        return Ok(());
    }

    let completes_outreach =
        event.message_type != BRIDGE_MESSAGE_TYPE_RESPONSE || bridge_response_is_done(&event);
    if completes_outreach {
        let conversation_id =
            bridge_conversation_id(&host.id, &event.from_node_id, event.project_id.as_deref());
        let _ = mark_outreach_status(&conversation_id, "completed", true, None);
    }

    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
        if bridge_response_is_done(&event) {
            if let Some(request_id) = event.request_id.as_deref() {
                update_message_delivery_state_in_storage(
                    request_id,
                    BRIDGE_DELIVERY_STATE_RESPONDED,
                )?;
            }
        }
    } else if acknowledge_delivery {
        acknowledge_inbound_delivery(host, &event).await;
    }
    Ok(())
}

pub(super) async fn desktop_bridge_poll_mailbox_impl(
    manager: &DesktopBridgeManager,
    chat_manager: &DesktopChatManager,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();
    let mut storage_changed = false;

    for target in mailbox_targets(&store) {
        let mailbox = match fetch_mailbox(&target.host.coordination, &target.host.api_key).await {
            Ok(mailbox) => mailbox,
            Err(_) => continue,
        };
        if mailbox.is_empty() {
            continue;
        }

        for item in mailbox {
            let Some(event) = parse_mailbox_event(&target.host, &item) else {
                continue;
            };

            if target.should_process_agent_asks && event.message_type == BRIDGE_MESSAGE_TYPE_ASK {
                let text = mailbox_payload_text(&event.payload);
                let attachments = mailbox_payload_attachments(&event.payload)?;
                let attachment_paths = attachments
                    .iter()
                    .filter_map(|attachment| attachment.local_path.clone())
                    .collect::<Vec<_>>();
                let agent_prompt_text = mailbox_payload_agent_prompt_text(&event.payload);
                if text.trim().is_empty() && attachments.is_empty() {
                    continue;
                }

                let peer_display_name = event.from_display_name.clone();
                let peer_owner_name = event.from_owner_name.clone();
                let peer_runtime = event
                    .from_runtime
                    .clone()
                    .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
                let sender_name = sender_name_for_runtime(
                    &peer_runtime,
                    peer_display_name.as_deref(),
                    peer_owner_name.as_deref(),
                    &event.from_node_id,
                );

                append_conversation_message_to_storage(
                    &target.host.id,
                    &event.from_node_id,
                    peer_display_name.clone(),
                    peer_owner_name.clone(),
                    peer_runtime.clone(),
                    event.project_id.clone(),
                    None,
                    Some(identity_snapshot_for_event(
                        &target.host,
                        &event,
                        &peer_runtime,
                    )),
                    outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                    BRIDGE_MESSAGE_DIRECTION_INBOUND,
                    Some(sender_name),
                    text.clone(),
                    event.request_id.clone(),
                    Some("processing".to_string()),
                    attachments.clone(),
                    true,
                )?;

                if let Some(request_id) = event.request_id.as_deref() {
                    let processing = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing" },
                    });
                    let _ = relay_plaintext_message(
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &processing,
                    )
                    .await;
                }

                let response_sender_name = sender_name_for_runtime(
                    &target.sender_runtime,
                    target.host.display_name.as_deref(),
                    target.host.owner.as_deref(),
                    &target.host.node_id,
                );
                append_conversation_message_to_storage(
                    &target.host.id,
                    &event.from_node_id,
                    peer_display_name.clone(),
                    peer_owner_name.clone(),
                    peer_runtime.clone(),
                    event.project_id.clone(),
                    None,
                    Some(identity_snapshot_for_event(
                        &target.host,
                        &event,
                        &peer_runtime,
                    )),
                    outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                    Some(response_sender_name.clone()),
                    "processing...".to_string(),
                    event.request_id.clone(),
                    Some("processing".to_string()),
                    Vec::new(),
                    false,
                )?;
                storage_changed = true;
                if event_targets_group_session(&event) {
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
                        "payload": bridge_response_payload(&event, "processing...", false),
                    });
                    let _ = relay_plaintext_message(
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &response,
                    )
                    .await;
                }
                fanout_group_agent_response(&target, &event, "processing...", false).await;

                let agent_result = run_bridge_agent_prompt(
                    chat_manager,
                    &target.host.node_id,
                    &event.from_node_id,
                    agent_prompt_text,
                    attachment_paths,
                    target.model_routing.clone(),
                )
                .await;

                if event
                    .request_id
                    .as_deref()
                    .is_some_and(bridge_request_is_cancelled)
                {
                    append_conversation_message_to_storage(
                        &target.host.id,
                        &event.from_node_id,
                        peer_display_name.clone(),
                        peer_owner_name.clone(),
                        peer_runtime.clone(),
                        event.project_id.clone(),
                        None,
                        Some(identity_snapshot_for_event(
                            &target.host,
                            &event,
                            &peer_runtime,
                        )),
                        outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                        BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                        Some(response_sender_name.clone()),
                        "Cancelled".to_string(),
                        event.request_id.clone(),
                        Some("cancelled".to_string()),
                        Vec::new(),
                        false,
                    )?;
                    continue;
                }

                match agent_result {
                    Ok(final_snapshot) if final_snapshot.succeeded => {
                        let assistant_text = sanitize_agent_response_for_event(
                            &event,
                            &final_snapshot.assistant_text,
                        );
                        if !assistant_text.trim().is_empty() {
                            append_conversation_message_to_storage(
                                &target.host.id,
                                &event.from_node_id,
                                peer_display_name.clone(),
                                peer_owner_name.clone(),
                                peer_runtime.clone(),
                                event.project_id.clone(),
                                None,
                                Some(identity_snapshot_for_event(
                                    &target.host,
                                    &event,
                                    &peer_runtime,
                                )),
                                outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                                BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                                Some(response_sender_name.clone()),
                                assistant_text.clone(),
                                event.request_id.clone(),
                                Some(BRIDGE_DELIVERY_STATE_RESPONDED.to_string()),
                                Vec::new(),
                                false,
                            )?;
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
                                "payload": bridge_response_payload(&event, &assistant_text, true),
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &response,
                            )
                            .await;
                            fanout_group_agent_response(&target, &event, &assistant_text, true)
                                .await;
                        }
                        if let Some(request_id) = event.request_id.as_deref() {
                            update_message_delivery_state_in_storage(
                                request_id,
                                BRIDGE_DELIVERY_STATE_RESPONDED,
                            )?;
                            let responded = serde_json::json!({
                                "from": target.host.node_id,
                                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_RESPONDED },
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &responded,
                            )
                            .await;
                        }
                    }
                    Ok(final_snapshot) => {
                        let error = final_snapshot
                            .error
                            .unwrap_or_else(|| final_snapshot.message.clone());
                        append_conversation_message_to_storage(
                            &target.host.id,
                            &event.from_node_id,
                            peer_display_name.clone(),
                            peer_owner_name.clone(),
                            peer_runtime.clone(),
                            event.project_id.clone(),
                            None,
                            Some(identity_snapshot_for_event(
                                &target.host,
                                &event,
                                &peer_runtime,
                            )),
                            outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                            Some(response_sender_name.clone()),
                            format!("Failed: {error}"),
                            event.request_id.clone(),
                            Some("processing_failed".to_string()),
                            Vec::new(),
                            false,
                        )?;
                        if let Some(request_id) = event.request_id.as_deref() {
                            update_message_delivery_state_in_storage(
                                request_id,
                                "processing_failed",
                            )?;
                            let failed = serde_json::json!({
                                "from": target.host.node_id,
                                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &failed,
                            )
                            .await;
                        }
                    }
                    Err(error) => {
                        append_conversation_message_to_storage(
                            &target.host.id,
                            &event.from_node_id,
                            peer_display_name.clone(),
                            peer_owner_name.clone(),
                            peer_runtime.clone(),
                            event.project_id.clone(),
                            None,
                            Some(identity_snapshot_for_event(
                                &target.host,
                                &event,
                                &peer_runtime,
                            )),
                            outreach_metadata_for_event(&target.host, &event, &peer_runtime),
                            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                            Some(response_sender_name.clone()),
                            format!("Failed: {error}"),
                            event.request_id.clone(),
                            Some("processing_failed".to_string()),
                            Vec::new(),
                            false,
                        )?;
                        if let Some(request_id) = event.request_id.as_deref() {
                            update_message_delivery_state_in_storage(
                                request_id,
                                "processing_failed",
                            )?;
                            let failed = serde_json::json!({
                                "from": target.host.node_id,
                                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &failed,
                            )
                            .await;
                        }
                    }
                }

                continue;
            }

            apply_bridge_event_to_storage(&target.host, event, true).await?;
            storage_changed = true;
        }
    }

    rebuild_state_after_mailbox_poll(manager, store, load_conversation_store(), storage_changed)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::constants::BRIDGE_MESSAGE_TYPE_RAW;
    use crate::bridge::DesktopBridgeAgentConfig;

    fn parsed_event(
        message_type: &str,
        from_runtime: Option<&str>,
        parent_turn_id: Option<&str>,
    ) -> ParsedMailboxEvent {
        let mut session_thread = serde_json::json!({
            "parentSessionId": "session-1",
            "targetKind": "bridge-person",
            "targetDisplayName": "Peer",
        });
        if let Some(parent_turn_id) = parent_turn_id {
            session_thread["parentTurnId"] = serde_json::json!(parent_turn_id);
        }

        ParsedMailboxEvent {
            from_node_id: "peer-node".to_string(),
            from_display_name: Some("Peer's Kordi".to_string()),
            from_owner_name: Some("Peer".to_string()),
            from_runtime: from_runtime.map(ToString::to_string),
            from_human_id: Some("human-peer".to_string()),
            from_agent_id: Some("agent-peer".to_string()),
            message_type: message_type.to_string(),
            payload: serde_json::json!({
                "message": "agent reply",
                "sessionThread": session_thread,
            }),
            request_id: Some("bridge_req_1".to_string()),
            project_id: None,
        }
    }

    #[test]
    fn session_relay_parent_turn_stays_in_person_thread_as_agent_response() {
        let event = parsed_event(
            BRIDGE_MESSAGE_TYPE_RAW,
            Some("kordi-desktop"),
            Some("turn-1"),
        );

        assert_eq!(
            storage_peer_runtime_for_inbound_event(&event, None),
            "person"
        );
        assert_eq!(
            sender_runtime_for_inbound_event(&event, "person"),
            "kordi-desktop"
        );
        assert_eq!(
            direction_for_inbound_event(&event),
            BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        );
    }

    #[test]
    fn session_relay_human_message_stays_in_person_thread_as_human_message() {
        let event = parsed_event(BRIDGE_MESSAGE_TYPE_RAW, Some("person"), None);

        assert_eq!(
            storage_peer_runtime_for_inbound_event(&event, None),
            "person"
        );
        assert_eq!(sender_runtime_for_inbound_event(&event, "person"), "person");
        assert_eq!(
            direction_for_inbound_event(&event),
            BRIDGE_MESSAGE_DIRECTION_INBOUND
        );
    }

    #[test]
    fn response_events_remain_agent_responses() {
        let event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);

        assert_eq!(
            direction_for_inbound_event(&event),
            BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        );
    }

    #[test]
    fn response_outreach_metadata_uses_session_thread_context_policy() {
        let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);
        event.payload["sessionThread"]["contextPolicy"] = serde_json::json!("session-message");
        event.payload["sessionThread"]["targetKind"] = serde_json::json!("bridge-agent");
        event.payload["sessionThread"]["targetDisplayName"] = serde_json::json!("Peer's Kordi");

        let host = DesktopBridgeHostConfig {
            id: "bridge-host".to_string(),
            coordination: "https://bridge.test".to_string(),
            node_id: "local-node".to_string(),
            api_key: "api-key".to_string(),
            display_name: Some("Local Kordi".to_string()),
            owner: Some("Local".to_string()),
            human_id: Some("human-local".to_string()),
            discovery_mode: "open".to_string(),
            active_agent_id: Some("agent-local".to_string()),
            agents: vec![DesktopBridgeAgentConfig {
                id: "agent-local".to_string(),
                label: "Local Kordi".to_string(),
                node_id: "local-node".to_string(),
                api_key: "agent-key".to_string(),
                runtime: "kordi-desktop".to_string(),
                is_default: true,
                default_model: None,
                default_auth_provider: None,
                default_auth_choice: None,
                fallback_model: None,
                fallback_auth_provider: None,
                fallback_auth_choice: None,
                thinking: None,
            }],
            api_style: "serve".to_string(),
        };

        let outreach =
            outreach_metadata_for_event(&host, &event, "kordi-desktop").expect("outreach metadata");

        assert_eq!(outreach.context_policy.as_deref(), Some("session-message"));
    }

    #[test]
    fn group_processing_response_is_not_buffered_as_typing_only() {
        let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);
        event.payload["message"] = serde_json::json!("processing...");
        event.payload["done"] = serde_json::json!(false);
        event.payload["sessionThread"]["parentSessionKind"] = serde_json::json!("group");
        event.payload["sessionThread"]["parentGroupSpaceId"] =
            serde_json::json!("session:group:root");

        assert!(!should_buffer_partial_agent_response(&event));
    }

    #[test]
    fn mailbox_group_agent_response_targets_other_group_members() {
        let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_ASK, Some("person"), None);
        event.payload["sessionThread"]["parentSessionKind"] = serde_json::json!("group");
        event.payload["sessionThread"]["parentGroupSpaceId"] =
            serde_json::json!("session:group:root");
        event.payload["sessionThread"]["participants"] = serde_json::json!([
            { "displayName": "Requester", "bridgeNodeId": "peer-node" },
            { "displayName": "Agent owner", "bridgeNodeId": "node-me" },
            { "displayName": "Other", "bridgeNodeId": "node-other" }
        ]);

        assert_eq!(
            group_session_thread_relay_targets(&event, "node-agent", Some("node-me"), "peer-node"),
            vec!["node-other".to_string()]
        );
    }
}
