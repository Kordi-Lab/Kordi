use serde_json::Value;

use crate::chat::{run_bridge_agent_prompt, DesktopBridgeAgentModelRouting, DesktopChatManager};

use super::agent_jobs::{
    bridge_agent_queue_records_for_event, job_status_update_for_run_result, select_startable_jobs,
    AgentJobRunResult, QueuedBridgeAgentJob, RunningBridgeAgentJob,
};

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
    ack_mailbox_v2, append_conversation_message_to_storage, bridge_conversation_id,
    bridge_request_is_cancelled, decrypt_bridge_payload_for_host, fetch_mailbox,
    list_runnable_bridge_agent_jobs_from_storage, list_running_bridge_agent_jobs_from_storage,
    load_bridge_inbox_event_from_storage, load_bridge_store, load_conversation_store,
    mark_bridge_agent_job_retry_wait_in_storage, mark_bridge_agent_job_running_in_storage,
    mark_bridge_agent_job_terminal_in_storage, note_peer_heartbeat_in_storage,
    note_peer_typing_in_storage, now_ms, parse_mailbox_payload, poll_mailbox_v2,
    record_bridge_inbox_event_and_agent_job, relay_plaintext_message,
    update_message_delivery_state_in_storage, AckedMailboxEntry, BridgeAgentJobRecord,
    BridgeInboxEventRecord, DesktopBridgeHostConfig, DesktopBridgeManager, DesktopBridgeState,
    DesktopBridgeStore,
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

fn mailbox_value_for_acked_entry(entry: &AckedMailboxEntry) -> Value {
    serde_json::to_value(entry).unwrap_or_else(|_| {
        serde_json::json!({
            "messageId": entry.message_id,
            "from": entry.from,
            "blob": entry.blob,
            "projectId": entry.project_id,
            "timestamp": entry.timestamp,
        })
    })
}

async fn enqueue_agent_ask_for_durable_processing(
    target: &LocalBridgeMailboxTarget,
    event: &ParsedMailboxEvent,
    server_message_id: Option<&str>,
) -> Result<bool, String> {
    let text = mailbox_payload_text(&event.payload);
    let attachments = mailbox_payload_attachments(&event.payload)?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Ok(false);
    }

    let now = now_ms();
    let (inbox, job) =
        bridge_agent_queue_records_for_event(&target.host.id, event, server_message_id, now);
    record_bridge_inbox_event_and_agent_job(&inbox, &job)?;

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
            event,
            &peer_runtime,
        )),
        outreach_metadata_for_event(&target.host, event, &peer_runtime),
        BRIDGE_MESSAGE_DIRECTION_INBOUND,
        Some(sender_name),
        text,
        event.request_id.clone(),
        Some("processing".to_string()),
        attachments,
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
        peer_display_name,
        peer_owner_name,
        peer_runtime.clone(),
        event.project_id.clone(),
        None,
        Some(identity_snapshot_for_event(
            &target.host,
            event,
            &peer_runtime,
        )),
        outreach_metadata_for_event(&target.host, event, &peer_runtime),
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
        Some(response_sender_name),
        "processing...".to_string(),
        event.request_id.clone(),
        Some("queued".to_string()),
        Vec::new(),
        false,
    )?;

    if event_targets_group_session(event) {
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
            "payload": bridge_response_payload(event, "processing...", false),
        });
        let _ = relay_plaintext_message(
            &target.host,
            &event.from_node_id,
            event.project_id.as_deref(),
            &response,
        )
        .await;
    }
    fanout_group_agent_response(target, event, "processing...", false).await;

    Ok(true)
}

async fn process_acked_mailbox_entries(
    target: &LocalBridgeMailboxTarget,
    entries: Vec<AckedMailboxEntry>,
) -> Result<bool, String> {
    let mut storage_changed = false;
    let mut ack_ids = Vec::new();

    for entry in entries {
        let item = mailbox_value_for_acked_entry(&entry);
        let Some(event) = parse_mailbox_event(&target.host, &item) else {
            continue;
        };

        if target.should_process_agent_asks && event.message_type == BRIDGE_MESSAGE_TYPE_ASK {
            if enqueue_agent_ask_for_durable_processing(target, &event, Some(&entry.message_id))
                .await?
            {
                storage_changed = true;
            }
            ack_ids.push(entry.message_id);
            continue;
        }

        apply_bridge_event_to_storage(&target.host, event, true).await?;
        storage_changed = true;
        ack_ids.push(entry.message_id);
    }

    if !ack_ids.is_empty() {
        ack_mailbox_v2(&target.host.coordination, &target.host.api_key, &ack_ids).await?;
    }

    Ok(storage_changed)
}

fn queued_job_for_scheduler(job: &BridgeAgentJobRecord) -> QueuedBridgeAgentJob {
    QueuedBridgeAgentJob {
        id: job.id.clone(),
        requesting_user_key: job.requesting_user_key.clone(),
        chat_queue_key: job.chat_queue_key.clone(),
        created_at_ms: job.created_at_ms,
        next_retry_at_ms: job.next_retry_at_ms,
    }
}

fn running_job_for_scheduler(job: &BridgeAgentJobRecord) -> RunningBridgeAgentJob {
    RunningBridgeAgentJob {
        id: job.id.clone(),
        requesting_user_key: job.requesting_user_key.clone(),
        chat_queue_key: job.chat_queue_key.clone(),
    }
}

fn parse_persisted_inbox_event(record: &BridgeInboxEventRecord) -> Option<ParsedMailboxEvent> {
    serde_json::from_str::<Value>(&record.payload_json)
        .ok()
        .and_then(|value| parse_bridge_event_payload(&value))
}

fn local_agent_target_for_inbox(
    store: &DesktopBridgeStore,
    inbox: &BridgeInboxEventRecord,
) -> Option<LocalBridgeMailboxTarget> {
    mailbox_targets(store).into_iter().find(|target| {
        target.should_process_agent_asks
            && target.host.id == inbox.host_id
            && !target.host.node_id.trim().is_empty()
            && !target.host.api_key.trim().is_empty()
    })
}

fn is_retryable_agent_start_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("busy")
        || normalized.contains("temporarily")
        || normalized.contains("unavailable")
        || normalized.contains("database is locked")
        || normalized.contains("resource temporarily")
        || normalized.contains("not running")
}

fn retry_bridge_agent_job(job: &BridgeAgentJobRecord, error: String) -> Result<(), String> {
    let now = now_ms();
    let update = job_status_update_for_run_result(
        AgentJobRunResult::RetryableStartFailure(error),
        now,
        job.retry_count,
    );
    let retry_at = update
        .next_retry_at_ms
        .ok_or_else(|| "retryable Bridge agent job missing retry timestamp".to_string())?;
    mark_bridge_agent_job_retry_wait_in_storage(&job.id, retry_at, update.last_error.as_deref())
}

fn terminal_bridge_agent_job(
    job: &BridgeAgentJobRecord,
    result: AgentJobRunResult,
) -> Result<(), String> {
    let update = job_status_update_for_run_result(result, now_ms(), job.retry_count);
    let completed_at_ms = update
        .completed_at_ms
        .ok_or_else(|| "terminal Bridge agent job missing completion timestamp".to_string())?;
    mark_bridge_agent_job_terminal_in_storage(
        &job.id,
        &update.status,
        completed_at_ms,
        update.last_error.as_deref(),
    )
}

async fn execute_persisted_agent_job(
    chat_manager: DesktopChatManager,
    target: LocalBridgeMailboxTarget,
    event: ParsedMailboxEvent,
    job: BridgeAgentJobRecord,
) -> Result<(), String> {
    let attachments = mailbox_payload_attachments(&event.payload)?;
    let attachment_paths = attachments
        .iter()
        .filter_map(|attachment| attachment.local_path.clone())
        .collect::<Vec<_>>();
    let agent_prompt_text = mailbox_payload_agent_prompt_text(&event.payload);
    let peer_display_name = event.from_display_name.clone();
    let peer_owner_name = event.from_owner_name.clone();
    let peer_runtime = event
        .from_runtime
        .clone()
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let response_sender_name = sender_name_for_runtime(
        &target.sender_runtime,
        target.host.display_name.as_deref(),
        target.host.owner.as_deref(),
        &target.host.node_id,
    );

    let agent_result = run_bridge_agent_prompt(
        &chat_manager,
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
            peer_display_name,
            peer_owner_name,
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
            Some(response_sender_name),
            "Cancelled".to_string(),
            event.request_id.clone(),
            Some("cancelled".to_string()),
            Vec::new(),
            false,
        )?;
        mark_bridge_agent_job_terminal_in_storage(&job.id, "cancelled", now_ms(), None)?;
        return Ok(());
    }

    match agent_result {
        Ok(final_snapshot) if final_snapshot.succeeded => {
            let assistant_text =
                sanitize_agent_response_for_event(&event, &final_snapshot.assistant_text);
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
                fanout_group_agent_response(&target, &event, &assistant_text, true).await;
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
            terminal_bridge_agent_job(&job, AgentJobRunResult::Responded)?;
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
                update_message_delivery_state_in_storage(request_id, "processing_failed")?;
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
            terminal_bridge_agent_job(&job, AgentJobRunResult::TerminalFailure(error))?;
        }
        Err(error) if is_retryable_agent_start_error(&error) => {
            retry_bridge_agent_job(&job, error)?;
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
                update_message_delivery_state_in_storage(request_id, "processing_failed")?;
            }
            terminal_bridge_agent_job(&job, AgentJobRunResult::TerminalFailure(error))?;
        }
    }

    Ok(())
}

pub(in crate::bridge) async fn run_queued_agent_jobs_once(
    chat_manager: &DesktopChatManager,
    store: &DesktopBridgeStore,
) -> Result<bool, String> {
    let now = now_ms();
    let queued_records = list_runnable_bridge_agent_jobs_from_storage(now, 128)?;
    if queued_records.is_empty() {
        return Ok(false);
    }
    let running_records = list_running_bridge_agent_jobs_from_storage()?;
    let queued = queued_records
        .iter()
        .map(queued_job_for_scheduler)
        .collect::<Vec<_>>();
    let running = running_records
        .iter()
        .map(running_job_for_scheduler)
        .collect::<Vec<_>>();
    let selected = select_startable_jobs(&queued, &running, now);
    if selected.is_empty() {
        return Ok(false);
    }

    let mut changed_any = false;
    for job_id in selected {
        let Some(job) = queued_records.iter().find(|job| job.id == job_id).cloned() else {
            continue;
        };
        let Some(inbox) = load_bridge_inbox_event_from_storage(&job.inbox_event_id)? else {
            terminal_bridge_agent_job(
                &job,
                AgentJobRunResult::TerminalFailure(
                    "Missing durable Bridge inbox event".to_string(),
                ),
            )?;
            changed_any = true;
            continue;
        };
        let Some(event) = parse_persisted_inbox_event(&inbox) else {
            terminal_bridge_agent_job(
                &job,
                AgentJobRunResult::TerminalFailure(
                    "Invalid durable Bridge inbox event".to_string(),
                ),
            )?;
            changed_any = true;
            continue;
        };
        let Some(target) = local_agent_target_for_inbox(store, &inbox) else {
            retry_bridge_agent_job(&job, "Bridge agent target is not available".to_string())?;
            changed_any = true;
            continue;
        };

        mark_bridge_agent_job_running_in_storage(&job.id, now_ms())?;
        let chat_manager = chat_manager.clone();
        let job_for_error = job.clone();
        tokio::spawn(async move {
            if let Err(error) = execute_persisted_agent_job(chat_manager, target, event, job).await
            {
                eprintln!("Bridge agent job failed: {error}");
                let _ = terminal_bridge_agent_job(
                    &job_for_error,
                    AgentJobRunResult::TerminalFailure(error),
                );
            }
        });
        changed_any = true;
    }

    Ok(changed_any)
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
        if let Ok(entries) = poll_mailbox_v2(
            &target.host.coordination,
            &target.host.api_key,
            None,
            Some(100),
        )
        .await
        {
            if entries.is_empty() {
                continue;
            }
            if process_acked_mailbox_entries(&target, entries).await? {
                storage_changed = true;
            }
            continue;
        }

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
                if enqueue_agent_ask_for_durable_processing(&target, &event, None).await? {
                    storage_changed = true;
                }
                continue;
            }

            apply_bridge_event_to_storage(&target.host, event, true).await?;
            storage_changed = true;
        }
    }

    if run_queued_agent_jobs_once(chat_manager, &store).await? {
        storage_changed = true;
    }

    rebuild_state_after_mailbox_poll(manager, store, load_conversation_store(), storage_changed)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::constants::BRIDGE_MESSAGE_TYPE_RAW;
    use crate::bridge::DesktopBridgeAgentConfig;

    fn test_mailbox_target() -> LocalBridgeMailboxTarget {
        LocalBridgeMailboxTarget {
            host: DesktopBridgeHostConfig {
                id: "bridge-host".to_string(),
                coordination: "https://bridge.test".to_string(),
                node_id: "local-agent-node".to_string(),
                api_key: "api-key".to_string(),
                display_name: Some("Local Kordi".to_string()),
                owner: Some("Local".to_string()),
                human_id: Some("human-local".to_string()),
                discovery_mode: "open".to_string(),
                active_agent_id: Some("agent-local".to_string()),
                agents: vec![],
                api_style: "serve".to_string(),
            },
            sender_runtime: "kordi-desktop".to_string(),
            sender_agent_id: Some("agent-local".to_string()),
            owner_node_id: Some("owner-node".to_string()),
            model_routing: None,
            should_process_agent_asks: true,
        }
    }

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
    fn mailbox_agent_ask_queue_records_use_server_message_and_chat_keys() {
        let target = test_mailbox_target();
        let event = parsed_event(BRIDGE_MESSAGE_TYPE_ASK, Some("person"), None);

        let (inbox, job) = bridge_agent_queue_records_for_event(
            &target.host.id,
            &event,
            Some("server-msg-1"),
            1_000,
        );
        assert_eq!(inbox.server_message_id.as_deref(), Some("server-msg-1"));
        assert_eq!(inbox.host_id, "bridge-host");
        assert_eq!(inbox.from_node_id, "peer-node");
        assert_eq!(inbox.request_id.as_deref(), Some("bridge_req_1"));
        assert_eq!(inbox.message_type, BRIDGE_MESSAGE_TYPE_ASK);
        assert_eq!(inbox.chat_queue_key, "session:session-1");
        assert_eq!(inbox.requesting_user_key, "human:human-peer");
        assert_eq!(inbox.status, "received");

        assert_eq!(job.inbox_event_id, inbox.id);
        assert_eq!(job.request_id.as_deref(), Some("bridge_req_1"));
        assert_eq!(job.chat_queue_key, "session:session-1");
        assert_eq!(job.requesting_user_key, "human:human-peer");
        assert_eq!(job.status, "queued");
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
