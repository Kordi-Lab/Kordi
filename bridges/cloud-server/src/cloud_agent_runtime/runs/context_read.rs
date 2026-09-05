//! Bounded, run-authorized retrieval. Conversation data never grants new access.

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{
    cloud_agent_response_text, cloud_group_request_envelope_for_run, direct_message_envelope,
    parse_cloud_group_envelope,
};
use super::{ClaimRunRequest, RunError, RunResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextReadRequest {
    runner_id: String,
    tool: String,
    arguments: Value,
}

pub(crate) async fn read_context(
    pool: &PgPool,
    run_id: &str,
    input: ContextReadRequest,
) -> RunResult<Value> {
    let run: Option<(String, String, String, String)> = query_as(
        "SELECT session_id, request_message_id, owner_account_id, requester_account_id
         FROM cloud_agent_fallback_runs WHERE run_id = $1 AND claimed_by = $2
         AND status IN ('leased', 'running') AND lease_expires_at > $3",
    )
    .bind(run_id)
    .bind(input.runner_id.trim())
    .bind(chrono::Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await?;
    let (session_id, request_message_id, owner, requester) = run.ok_or(RunError::NotFound)?;
    let args = &input.arguments;
    let search = input.tool == "search_sessions";
    if !search && (input.tool != "read_session" || args["sessionId"].as_str() != Some(&session_id))
    {
        return Err(RunError::NotFound);
    }
    let claim = ClaimRunRequest {
        session_id: session_id.clone(),
        request_message_id: request_message_id.clone(),
        owner_account_id: owner.clone(),
        requester_account_id: requester.clone(),
        prompt: String::new(),
        runtime_route: None,
        idempotency_key: String::new(),
    };
    if !super::authorization::validate_shared_cloud_agent_claim(pool, &claim).await? {
        return Err(RunError::NotFound);
    }
    // Both the requesting person and executing owner must still belong to this conversation.
    let conversation: Option<(uuid::Uuid,)> = query_as(
        "SELECT c.conversation_id FROM cloud_chat_conversations c
         WHERE c.legacy_session_id = $1
         AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id = c.conversation_id AND m.account_id = $2 AND m.membership_state = 'active')
         AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members m WHERE m.conversation_id = c.conversation_id AND m.account_id = $3 AND m.membership_state = 'active')",
    ).bind(&session_id).bind(&owner).bind(&requester).fetch_optional(pool).await?;
    let (conversation_id,) = conversation.ok_or(RunError::NotFound)?;
    let mode = args["mode"].as_str().unwrap_or("index");
    if !search && !matches!(mode, "index" | "messages" | "participants") {
        return Err(RunError::NotFound);
    }
    if !search && mode == "participants" {
        let mut envelope =
            cloud_group_request_envelope_for_run(pool, &session_id, &request_message_id)
                .await?
                .ok_or(RunError::NotFound)?;
        let members: Vec<(String,)> = query_as(
            "SELECT account_id FROM cloud_chat_conversation_members WHERE conversation_id = $1 AND membership_state = 'active'",
        ).bind(conversation_id).fetch_all(pool).await?;
        envelope
            .participants
            .retain(|participant| members.iter().any(|(id,)| id == &participant.account_id));
        let agent_id = envelope
            .message
            .as_ref()
            .and_then(|message| message.target_cloud_agent_id.clone())
            .unwrap_or_else(|| format!("cloud-agent:{owner}"));
        return Ok(
            json!({"sessionId": session_id, "directory": super::group_mentions::mention_instruction(&envelope, &owner, &agent_id)}),
        );
    }
    let query = args["query"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if search && (query.is_empty() || query.chars().count() > 200) {
        return Err(RunError::NotFound);
    }
    let ids = args["messageIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .take(80)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !search && mode == "messages" && ids.is_empty() {
        return Err(RunError::NotFound);
    }
    let limit = args["limit"]
        .as_u64()
        .unwrap_or(if search { 8 } else { 30 })
        .clamp(1, 80) as usize;
    let mut before = args["beforeSequence"].as_i64().unwrap_or(i64::MAX);
    if let Some(around) = args["aroundMessageId"].as_str() {
        let row: Option<(i64,)> = query_as("SELECT conversation_sequence FROM cloud_chat_messages WHERE conversation_id = $1 AND message_id::text = $2 AND deleted_at IS NULL")
            .bind(conversation_id).bind(around).fetch_optional(pool).await?;
        before = row
            .ok_or(RunError::NotFound)?
            .0
            .saturating_add((limit / 2) as i64 + 1);
    }
    let selected = !search && mode == "messages";
    // ponytail: encoded legacy messages require decoding; page through 256 candidates
    // per search instead of adding a second search index before it is measured.
    let scan_limit = if search { 256 } else { limit as i64 + 1 };
    let rows: Vec<(String, String, String, i64)> = query_as(
        "SELECT message_id::text, sender_account_id, content #>> '{blocks,0,text}', conversation_sequence
         FROM cloud_chat_messages WHERE conversation_id = $1 AND deleted_at IS NULL
         AND conversation_sequence < $2 AND content #>> '{blocks,0,text}' IS NOT NULL
         AND (NOT $3 OR message_id::text = ANY($4)) ORDER BY conversation_sequence DESC LIMIT $5",
    ).bind(conversation_id).bind(before).bind(selected).bind(&ids).bind(scan_limit).fetch_all(pool).await?;
    let mut messages = Vec::new();
    let mut next = None;
    let mut exhausted = rows.len() < scan_limit as usize;
    for (id, sender, body, sequence) in rows {
        next = Some(sequence);
        let Some((sender, kind, text)) = visible_message(&sender, &body) else {
            continue;
        };
        if search && !text.to_lowercase().contains(&query) {
            continue;
        }
        let include_text =
            selected || (search && args["includeMessages"].as_bool().unwrap_or(false));
        let offset = if selected {
            args["offset"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize
        } else {
            0
        };
        let next_offset = (include_text && text.chars().count().saturating_sub(offset) > 1200)
            .then(|| offset.saturating_add(1200));
        messages.push(json!({"messageId": id, "sender": sender, "kind": kind, "sequenceNum": sequence,
            "text": include_text.then(|| text.chars().skip(offset).take(1200).collect::<String>()), "nextOffset": next_offset}));
        if messages.len() >= limit {
            exhausted = false;
            break;
        }
    }
    messages.reverse();
    Ok(json!({"sessionId": session_id, "messages": messages,
        "hasMore": !selected && !exhausted, "nextBeforeSequence": (!selected && !exhausted).then_some(next).flatten()}))
}

fn visible_message(sender: &str, body: &str) -> Option<(String, String, String)> {
    if let Some(envelope) = parse_cloud_group_envelope(body) {
        let message = envelope.message?;
        if message.delivery_state.as_deref() == Some("processing") {
            return None;
        }
        return Some((
            message
                .sender_display_name
                .unwrap_or(message.sender_account_id),
            message.sender_kind.unwrap_or_else(|| "human".to_string()),
            message.text,
        ));
    }
    if let Some(text) = cloud_agent_response_text(body) {
        return Some((sender.to_string(), "agent".to_string(), text));
    }
    if let Some(envelope) = direct_message_envelope(body) {
        return Some((
            sender.to_string(),
            "human".to_string(),
            envelope["text"].as_str()?.to_string(),
        ));
    }
    // Unknown encoded control payloads are not conversation evidence.
    if body.starts_with("kordi-") {
        return None;
    }
    Some((sender.to_string(), "human".to_string(), body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    #[test]
    fn retrieval_exposes_message_text_without_control_payloads_or_the_roster() {
        assert!(visible_message("sender", "kordi-private-control:payload").is_none());
        let mut envelope = json!({
            "kind": "group-message", "groupId": "group-a", "groupTitle": null,
            "createdByAccountId": "owner", "actor": {"accountId": "owner", "displayName": "Owner"},
            "participants": [{"accountId": "unrelated", "displayName": "Unrelated Member"}],
            "message": {"id": "message-a", "senderAccountId": "sender", "senderDisplayName": "Sender",
                "senderKind": "human", "text": "Relevant evidence", "createdAtMs": 1}
        });
        let body = format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        assert_eq!(
            visible_message("sender", &body),
            Some((
                "Sender".to_string(),
                "human".to_string(),
                "Relevant evidence".to_string()
            ))
        );
        envelope["message"]["deliveryState"] = json!("processing");
        let body = format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        assert!(visible_message("sender", &body).is_none());
    }
}
