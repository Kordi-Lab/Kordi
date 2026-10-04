use super::super::envelopes::{
    cloud_agent_response_text, cloud_group_request_envelope_for_run, direct_message_envelope,
    parse_cloud_group_envelope,
};
use super::*;
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub(super) fn response(
    scope: &ContextScope,
    messages: Vec<Value>,
    has_more: bool,
    next: Option<i64>,
) -> Value {
    json!({"sessionId":scope.session_id,"session":{"sessionId":scope.session_id,"title":scope.title,"kind":scope.kind,"participants":[]},
        "window":{"aroundMessageId":null,"hasMoreBefore":has_more,"hasMoreAfter":false},
        "messages":messages,"hasMore":has_more,"nextBeforeSequence":next})
}

pub(super) async fn read(
    pool: &PgPool,
    scope: &ContextScope,
    args: &Value,
    search: bool,
) -> RunResult<Value> {
    let mode = args["mode"].as_str().unwrap_or("index");
    if !search && !matches!(mode, "index" | "messages" | "participants") {
        return Err(RunError::NotFound);
    }
    if !search && mode == "participants" {
        let mut envelope = cloud_group_request_envelope_for_run(
            pool,
            &scope.session_id,
            &scope.request_message_id,
        )
        .await?
        .ok_or(RunError::NotFound)?;
        let members:Vec<(String,)>=query_as("SELECT account_id FROM cloud_chat_conversation_members WHERE conversation_id=$1 AND membership_state='active'").bind(scope.conversation_id).fetch_all(pool).await?;
        envelope
            .participants
            .retain(|p| members.iter().any(|(id,)| id == &p.account_id));
        let agent = envelope
            .message
            .as_ref()
            .and_then(|m| m.target_cloud_agent_id.clone())
            .unwrap_or_else(|| format!("cloud-agent:{}", scope.owner));
        let mut value = response(scope, vec![], false, None);
        value["directory"] = json!(super::super::group_mentions::mention_instruction(
            &envelope,
            &scope.owner,
            &agent
        ));
        return Ok(value);
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
    let selected = !search && mode == "messages";
    if selected && ids.is_empty() {
        return Err(RunError::NotFound);
    }
    let limit = args["limit"]
        .as_u64()
        .unwrap_or(if search { 8 } else { 30 })
        .clamp(1, 80) as usize;
    let viewers = vec![scope.owner.clone(), scope.requester.clone()];
    let mut before = args["beforeSequence"].as_i64().unwrap_or(i64::MAX);
    if let Some(around) = args["aroundMessageId"].as_str() {
        let row:Option<(i64,)>=query_as("SELECT conversation_sequence FROM cloud_chat_messages m WHERE conversation_id=$1 AND message_id::text=$2 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($3))")
            .bind(scope.conversation_id).bind(around).bind(&viewers).fetch_optional(pool).await?;
        before = row
            .ok_or(RunError::NotFound)?
            .0
            .saturating_add((limit / 2) as i64 + 1);
    }
    let scan_limit = if search { 256 } else { limit as i64 + 1 };
    let rows:Vec<(String,String,Value,i64,String)>=query_as(
        "SELECT message_id::text,sender_account_id,content,conversation_sequence,created_at::text
         FROM cloud_chat_messages m WHERE conversation_id=$1 AND deleted_at IS NULL AND conversation_sequence<$2
         AND (NOT $3 OR message_id::text=ANY($4))
         AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($5))
         ORDER BY conversation_sequence DESC LIMIT $6"
    ).bind(scope.conversation_id).bind(before).bind(selected).bind(&ids).bind(&viewers).bind(scan_limit).fetch_all(pool).await?;
    let candidate_ids = rows.iter().map(|r| r.0.clone()).collect::<Vec<_>>();
    let refs = super::media::references(
        pool,
        &scope.session_id,
        &candidate_ids,
        &scope.owner,
        &scope.requester,
    )
    .await?;
    let rows = rows
        .into_iter()
        .map(|(id, sender, body, sequence, created_at)| {
            let body = crate::chat_sync::voice::body_for_agent(&body);
            (id, sender, body, sequence, created_at)
        })
        .collect::<Vec<_>>();
    let speakers = SpeakerDirectory::load(pool, &rows).await?;
    let mut messages = Vec::new();
    let mut next = None;
    let mut exhausted = rows.len() < scan_limit as usize;
    for (id, sender, body, sequence, created_at) in rows {
        if messages.len() >= limit {
            exhausted = false;
            break;
        }
        next = Some(sequence);
        let Some((sender, kind, text)) = visible_message(&speakers, &sender, &body) else {
            continue;
        };
        if search && !text.to_lowercase().contains(&query) {
            continue;
        }
        let include = selected || (search && args["includeMessages"].as_bool().unwrap_or(false));
        let offset = if selected {
            args["offset"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize
        } else {
            0
        };
        let next_offset = (include && text.chars().count().saturating_sub(offset) > 1200)
            .then(|| offset.saturating_add(1200));
        let attachments = refs
            .iter()
            .filter(|r| r.message_id == id)
            .collect::<Vec<_>>();
        messages.push(json!({"messageId":id,"sender":sender,"kind":kind,"role":kind,"sequenceNum":sequence,"timeLabel":created_at,"text":include.then(||text.chars().skip(offset).take(1200).collect::<String>()),"nextOffset":next_offset,"attachments":attachments}));
    }
    messages.reverse();
    let has_more = !selected && !exhausted;
    let mut value = response(
        scope,
        messages,
        has_more,
        if has_more { next } else { None },
    );
    if search {
        let snippets=value["messages"].as_array().unwrap().iter().filter_map(|m|m["text"].as_str().map(|text|json!({"messageId":m["messageId"],"sender":m["sender"],"text":text,"timeLabel":null}))).collect::<Vec<_>>();
        value["sessions"] = if value["messages"].as_array().unwrap().is_empty() {
            json!([])
        } else {
            json!([{"sessionId":scope.session_id,"title":scope.title,"kind":scope.kind,"participants":[],"updatedAtLabel":null,"reason":"Matching authorized conversation messages","snippets":snippets}])
        };
    }
    Ok(value)
}
/// Display names for stored senders and their agents, read from server
/// records so retrieved history never trusts envelope presentation fields.
#[derive(Default)]
struct SpeakerDirectory {
    accounts: HashMap<String, (Option<String>, Option<String>)>,
    agents: HashMap<(String, String), String>,
}

impl SpeakerDirectory {
    async fn load(
        pool: &PgPool,
        rows: &[(String, String, String, i64, String)],
    ) -> RunResult<Self> {
        let senders = rows
            .iter()
            .map(|row| row.1.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let agent_ids = rows
            .iter()
            .filter_map(|row| parse_cloud_group_envelope(&row.2)?.message?.sender_agent_id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let accounts: Vec<(String, Option<String>, Option<String>)> = query_as(
            "SELECT account.account_id, account.display_name, agent.display_name \
             FROM cloud_accounts account \
             LEFT JOIN cloud_default_agent_profiles agent \
               ON agent.owner_account_id = account.account_id \
             WHERE account.account_id = ANY($1)",
        )
        .bind(&senders)
        .fetch_all(pool)
        .await?;
        let agents: Vec<(String, String, String)> = if agent_ids.is_empty() {
            Vec::new()
        } else {
            query_as(
                "SELECT owner_account_id, agent_id, name FROM cloud_agent_definitions \
                 WHERE owner_account_id = ANY($1) AND agent_id = ANY($2)",
            )
            .bind(&senders)
            .bind(&agent_ids)
            .fetch_all(pool)
            .await?
        };
        Ok(Self {
            accounts: accounts
                .into_iter()
                .map(|(account_id, name, agent_name)| (account_id, (name, agent_name)))
                .collect(),
            agents: agents
                .into_iter()
                .map(|(owner, agent_id, name)| ((owner, agent_id), name))
                .collect(),
        })
    }

    fn human(&self, account_id: &str) -> String {
        self.accounts
            .get(account_id)
            .and_then(|(name, _)| name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(account_id)
            .to_string()
    }

    /// Returns the agent label only when the agent belongs to the stored sender.
    fn agent(&self, account_id: &str, agent_id: Option<&str>) -> Option<String> {
        let agent_id = agent_id.map(str::trim).filter(|value| !value.is_empty());
        let default_agent = agent_id.is_none_or(|agent_id| {
            agent_id == format!("cloud-agent:{account_id}")
                || agent_id == "cloud-local-agent"
                || agent_id == format!("cloud-self:{account_id}")
        });
        let name = if default_agent {
            self.accounts
                .get(account_id)
                .and_then(|(_, agent_name)| agent_name.clone())
                .unwrap_or_else(|| "Kordi".to_string())
        } else {
            self.agents
                .get(&(account_id.to_string(), agent_id?.to_string()))?
                .clone()
        };
        Some(format!("{name} (agent of {})", self.human(account_id)))
    }
}

/// Labels a retrieved message from its stored sender. An envelope can mark an
/// agent message only for an agent owned by that same stored sender.
fn visible_message(
    speakers: &SpeakerDirectory,
    sender: &str,
    body: &str,
) -> Option<(String, String, String)> {
    if let Some(envelope) = parse_cloud_group_envelope(body) {
        let message = envelope.message?;
        if message.delivery_state.as_deref() == Some("processing") {
            return None;
        }
        let agent = (message.sender_kind.as_deref() == Some("agent")
            && message.sender_account_id == sender)
            .then(|| speakers.agent(sender, message.sender_agent_id.as_deref()))
            .flatten();
        return Some(match agent {
            Some(label) => (label, "agent".to_string(), message.text),
            None => (speakers.human(sender), "human".to_string(), message.text),
        });
    }
    if let Some(text) = cloud_agent_response_text(body) {
        let label = speakers
            .agent(sender, None)
            .unwrap_or_else(|| speakers.human(sender));
        return Some((label, "agent".to_string(), text));
    }
    if let Some(envelope) = direct_message_envelope(body) {
        return Some((
            speakers.human(sender),
            "human".to_string(),
            envelope["text"].as_str()?.to_string(),
        ));
    }
    // Unknown encoded control payloads are not conversation evidence.
    if body.starts_with("kordi-") {
        return None;
    }
    Some((
        speakers.human(sender),
        "human".to_string(),
        body.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn speakers() -> SpeakerDirectory {
        SpeakerDirectory {
            accounts: HashMap::from([
                (
                    "sender".to_string(),
                    (Some("Sender".to_string()), Some("Sender Kordi".to_string())),
                ),
                (
                    "owner".to_string(),
                    (Some("Owner".to_string()), Some("Owner Kordi".to_string())),
                ),
            ]),
            agents: HashMap::from([(
                ("owner".to_string(), "cloud_agent_research".to_string()),
                "Research".to_string(),
            )]),
        }
    }

    fn group_body(message: Value) -> String {
        let envelope = json!({
            "kind": "group-message", "groupId": "group-a", "groupTitle": null,
            "createdByAccountId": "owner", "actor": {"accountId": "owner", "displayName": "Owner"},
            "participants": [{"accountId": "unrelated", "displayName": "Unrelated Member"}],
            "message": message
        });
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    #[test]
    fn retrieval_exposes_message_text_without_control_payloads_or_the_roster() {
        let speakers = speakers();
        assert!(visible_message(&speakers, "sender", "kordi-private-control:payload").is_none());
        let mut message = json!({"id": "message-a", "senderAccountId": "sender",
            "senderDisplayName": "Sender", "senderKind": "human", "text": "Relevant evidence",
            "createdAtMs": 1});
        assert_eq!(
            visible_message(&speakers, "sender", &group_body(message.clone())),
            Some((
                "Sender".to_string(),
                "human".to_string(),
                "Relevant evidence".to_string()
            ))
        );
        message["deliveryState"] = json!("processing");
        assert!(visible_message(&speakers, "sender", &group_body(message)).is_none());
    }

    #[test]
    fn retrieval_labels_speakers_from_the_stored_sender() {
        let speakers = speakers();
        // An envelope stored from "sender" that names the owner's agent.
        let names_owner_agent = group_body(json!({"id": "m1", "senderAccountId": "owner",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Owner", "text": "hello", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "sender", &names_owner_agent),
            Some((
                "Sender".to_string(),
                "human".to_string(),
                "hello".to_string()
            ))
        );
        // An envelope naming a custom agent that the stored sender does not own.
        let unowned_agent = group_body(json!({"id": "m2", "senderAccountId": "sender",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Research", "text": "hi", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "sender", &unowned_agent),
            Some(("Sender".to_string(), "human".to_string(), "hi".to_string()))
        );
        let owned_agent = group_body(json!({"id": "m3", "senderAccountId": "owner",
            "senderKind": "agent", "senderAgentId": "cloud_agent_research",
            "senderDisplayName": "Anything", "text": "done", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "owner", &owned_agent),
            Some((
                "Research (agent of Owner)".to_string(),
                "agent".to_string(),
                "done".to_string()
            ))
        );
        let default_agent = group_body(json!({"id": "m4", "senderAccountId": "owner",
            "senderKind": "agent", "text": "ok", "createdAtMs": 1}));
        assert_eq!(
            visible_message(&speakers, "owner", &default_agent),
            Some((
                "Owner Kordi (agent of Owner)".to_string(),
                "agent".to_string(),
                "ok".to_string()
            ))
        );
        assert_eq!(
            visible_message(&speakers, "unknown", "plain"),
            Some((
                "unknown".to_string(),
                "human".to_string(),
                "plain".to_string()
            ))
        );
    }
}
