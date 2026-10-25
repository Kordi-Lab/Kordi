//! The owner's card: a message from the agent in the owner's own
//! conversation with it, with a `proactive_offer` block and a one-line text
//! fallback. Status changes refresh the same message in place.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::cloud_agent_runtime::runs::encode_cloud_agent_response_body;

pub(super) const BLOCK_TYPE: &str = "proactive_offer";

/// A proposal with what its card shows.
#[derive(Debug, Clone)]
pub(crate) struct CardProposal {
    pub proposal_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub owner_account_id: String,
    pub conversation_id: Uuid,
    pub session_id: String,
    pub conversation_title: Option<String>,
    pub trigger_message_id: String,
    pub problem: String,
    pub offer: String,
    pub plan: String,
    pub status: String,
    pub run_id: Option<String>,
    pub card_message_id: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
}

type CardRow = (
    String,
    String,
    String,
    String,
    Uuid,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

pub(crate) async fn load(
    pool: &PgPool,
    proposal_id: &str,
) -> Result<Option<CardProposal>, sqlx_core::Error> {
    // The definition's name, else the default agent's.
    let row: Option<CardRow> = query_as(concat!(
        "SELECT p.proposal_id, p.agent_id, COALESCE(agent.name, ",
        super::agents::default_name_sql!("owner", "profile"),
        "), p.owner_account_id, p.conversation_id,
                p.session_id, COALESCE(c.group_title, c.shared_title), p.trigger_message_id,
                p.problem, p.offer, p.plan, p.status, p.run_id, p.card_message_id,
                p.decided_at, p.expires_at
         FROM cloud_agent_proactive_proposals p
         JOIN cloud_accounts owner ON owner.account_id = p.owner_account_id
         LEFT JOIN cloud_default_agent_profiles profile
           ON profile.owner_account_id = p.owner_account_id
         LEFT JOIN cloud_agent_definitions agent ON agent.agent_id = p.agent_id
         LEFT JOIN cloud_chat_conversations c ON c.conversation_id = p.conversation_id
         WHERE p.proposal_id = $1
           AND (agent.agent_id IS NOT NULL OR p.agent_id = 'cloud-agent:' || p.owner_account_id)"
    ))
    .bind(proposal_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| CardProposal {
        proposal_id: row.0,
        agent_id: row.1,
        agent_name: row.2,
        owner_account_id: row.3,
        conversation_id: row.4,
        session_id: row.5,
        conversation_title: row.6,
        trigger_message_id: row.7,
        problem: row.8,
        offer: row.9,
        plan: row.10,
        status: row.11,
        run_id: row.12,
        card_message_id: row.13,
        decided_at: row.14,
        expires_at: row.15,
    }))
}

fn rfc3339(value: &DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn block(proposal: &CardProposal) -> Value {
    json!({
        "type": BLOCK_TYPE,
        "proposalId": proposal.proposal_id,
        "agentId": proposal.agent_id,
        "agentName": proposal.agent_name,
        "conversationId": proposal.conversation_id.to_string(),
        "sessionId": proposal.session_id,
        "conversationTitle": proposal.conversation_title,
        "triggerMessageId": proposal.trigger_message_id,
        "problem": proposal.problem,
        "offer": proposal.offer,
        "plan": proposal.plan,
        "status": proposal.status,
        "expiresAt": rfc3339(&proposal.expires_at),
        "runId": proposal.run_id,
        "decidedAt": proposal.decided_at.as_ref().map(rfc3339),
    })
}

/// The one line clients that do not know the block show.
pub(crate) fn fallback_text(proposal: &CardProposal) -> String {
    let agent = &proposal.agent_name;
    let group = proposal
        .conversation_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("a group");
    match proposal.status.as_str() {
        "pending" => format!(
            "{agent} can help in {group}: {}. Allow or decline on your Mac.",
            proposal.offer.trim().trim_end_matches(['.', '!', '?'])
        ),
        "approved" | "running" => format!("{agent} is helping in {group}."),
        "done" => format!("{agent} answered in {group}."),
        "failed" => format!("{agent} could not finish in {group}."),
        "declined" => format!("You declined {agent}'s offer in {group}."),
        _ => format!("{agent}'s offer in {group} expired."),
    }
}

fn content(proposal: &CardProposal) -> Value {
    json!({
        "schema": 1,
        "blocks": [
            {
                "type": "text",
                "text": encode_cloud_agent_response_body(
                    &proposal.proposal_id,
                    &fallback_text(proposal),
                ),
            },
            block(proposal),
        ],
        "legacy_attachments": [],
    })
}

/// The owner's conversation with the agent: the latest one-person agent
/// conversation in which the owner ran this agent (mention and scheduled runs
/// of the default agent carry its synthetic id too), else one created for it.
pub(crate) async fn agent_conversation(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Uuid, sqlx_core::Error> {
    let existing: Option<(Uuid,)> = query_as(
        "SELECT c.conversation_id
         FROM cloud_agent_fallback_runs run
         JOIN cloud_chat_conversations c ON c.legacy_session_id = run.session_id
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = c.conversation_id AND member.account_id = $1
          AND member.membership_state = 'active'
         WHERE run.owner_account_id = $1 AND run.execution_agent_id = $2
           AND NOT starts_with(run.run_id, 'proactive_')
           AND c.kind = 'ai' AND c.created_by_account_id = $1
           AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members other
                           WHERE other.conversation_id = c.conversation_id
                             AND other.account_id <> $1)
         ORDER BY run.created_at DESC LIMIT 1",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    if let Some((conversation_id,)) = existing {
        return Ok(conversation_id);
    }
    let operation = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("proactive-conversation:{agent_id}").as_bytes(),
    );
    // The default agent's chat has the shape of the desktop's own agent chats
    // (`session:self-agent:<uuid>`), so it shows as the normal agent chat.
    let client_session_id = match super::agents::default_owner(agent_id) {
        Some(_) => format!("session:self-agent:{operation}"),
        None => format!("session:self-agent:proactive:{agent_id}"),
    };
    let request = CreateConversationRequest {
        client_operation_id: operation,
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id,
        member_account_ids: vec![owner_account_id.to_string()],
    };
    let conversation =
        crate::chat_sync::store::create_conversation(pool, owner_account_id, request)
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(conversation.value.id)
}

/// Posts the card for a new proposal and records its message id.
pub(crate) async fn post(pool: &PgPool, proposal_id: &str) -> Result<(), sqlx_core::Error> {
    let Some(proposal) = load(pool, proposal_id).await? else {
        return Ok(());
    };
    if proposal.card_message_id.is_some() {
        return refresh(pool, proposal_id).await;
    }
    let conversation_id =
        agent_conversation(pool, &proposal.owner_account_id, &proposal.agent_id).await?;
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("{proposal_id}:card").as_bytes(),
        ),
        kind: "text".to_string(),
        content: content(&proposal),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let outcome = crate::chat_sync::store::send_message(
        pool,
        &proposal.owner_account_id,
        conversation_id,
        request,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    query(
        "UPDATE cloud_agent_proactive_proposals SET card_message_id = $2
         WHERE proposal_id = $1 AND card_message_id IS NULL",
    )
    .bind(proposal_id)
    .bind(outcome.value.id.to_string())
    .execute(pool)
    .await?;
    // A decision may have landed while the card was being posted.
    refresh(pool, proposal_id).await
}

/// Rewrites the card message so every device re-renders the same card.
pub(crate) async fn refresh(pool: &PgPool, proposal_id: &str) -> Result<(), sqlx_core::Error> {
    let Some(proposal) = load(pool, proposal_id).await? else {
        return Ok(());
    };
    let Some(message_id) = proposal
        .card_message_id
        .as_deref()
        .and_then(|id| Uuid::parse_str(id).ok())
    else {
        return Ok(());
    };
    let fresh = content(&proposal);
    let result = crate::chat_sync::store::refresh_server_message_content(
        pool,
        &proposal.owner_account_id,
        message_id,
        |mut current| {
            current["blocks"] = fresh["blocks"].clone();
            Some(current)
        },
    )
    .await;
    match result {
        Ok(_) | Err(crate::chat_sync::store::StoreError::NotFound) => Ok(()),
        Err(error) => Err(sqlx_core::Error::Protocol(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(status: &str) -> CardProposal {
        CardProposal {
            proposal_id: "pro_1".into(),
            agent_id: "cloud_agent_1".into(),
            agent_name: "Scout".into(),
            owner_account_id: "acct_owner".into(),
            conversation_id: Uuid::nil(),
            session_id: "session:group:g1".into(),
            conversation_title: Some("Launch".into()),
            trigger_message_id: "m1".into(),
            problem: "CI fails".into(),
            offer: "Riya, I can look at the failing step.".into(),
            plan: "Read the log".into(),
            status: status.into(),
            run_id: None,
            card_message_id: None,
            decided_at: None,
            expires_at: DateTime::parse_from_rfc3339("2026-10-25T10:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    #[test]
    fn the_block_has_the_documented_shape() {
        let block = block(&proposal("pending"));
        let mut keys: Vec<&str> = block
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agentId",
                "agentName",
                "conversationId",
                "conversationTitle",
                "decidedAt",
                "expiresAt",
                "offer",
                "plan",
                "problem",
                "proposalId",
                "runId",
                "sessionId",
                "status",
                "triggerMessageId",
                "type"
            ]
        );
        assert_eq!(block["type"], "proactive_offer");
        assert_eq!(block["expiresAt"], "2026-10-25T10:00:00.000Z");
        assert!(block["runId"].is_null() && block["decidedAt"].is_null());
    }

    #[test]
    fn the_fallback_is_one_line_per_status() {
        assert_eq!(
            fallback_text(&proposal("pending")),
            "Scout can help in Launch: Riya, I can look at the failing step. Allow or decline on your Mac."
        );
        assert_eq!(
            fallback_text(&proposal("running")),
            "Scout is helping in Launch."
        );
        assert_eq!(
            fallback_text(&proposal("expired")),
            "Scout's offer in Launch expired."
        );
    }
}
