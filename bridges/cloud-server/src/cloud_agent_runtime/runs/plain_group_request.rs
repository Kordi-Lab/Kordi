//! A group request envelope rebuilt from the conversation, for a run whose
//! request message is plain text rather than a `kordi-cloud-group:` envelope
//! (a message posted through the HTTP API). Without it the reply would be a
//! bare agent response that names no agent. Used for runs allowed from a
//! proactive offer, which answer a collaborator's message as the agent.

use chrono::{DateTime, Utc};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{
    parse_cloud_group_envelope, CloudGroupEnvelope, CloudGroupMessage, CloudGroupParticipant,
};

/// (account, display name, avatar url, agent display name, agent avatar url)
type MemberRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn participant(row: MemberRow) -> CloudGroupParticipant {
    let (account_id, display_name, avatar_url, agent_name, agent_avatar_url) = row;
    CloudGroupParticipant {
        agent_id: Some(format!("cloud-agent:{account_id}")),
        account_id,
        display_name: display_name.unwrap_or_else(|| "Member".to_string()),
        avatar_url,
        agent_display_name: Some(agent_name.unwrap_or_else(|| "Kordi".to_string())),
        agent_avatar_url,
        role: Some("person".to_string()),
    }
}

/// The envelope a client would have sent with `request_message_id`, when
/// that message is plain text in the group behind `session_id`. `None` for
/// any other session, an unknown message, or one that is already an
/// envelope.
pub(super) async fn plain_group_request_envelope(
    pool: &PgPool,
    session_id: &str,
    request_message_id: &str,
) -> Result<Option<CloudGroupEnvelope>, sqlx_core::Error> {
    if !session_id.trim().starts_with("session:group:") {
        return Ok(None);
    }
    type MessageRow = (
        uuid::Uuid,
        String,
        Option<String>,
        String,
        serde_json::Value,
        DateTime<Utc>,
    );
    let message: Option<MessageRow> = query_as(
        "SELECT c.conversation_id, c.created_by_account_id,
                COALESCE(c.group_title, c.shared_title), m.sender_account_id, m.content,
                m.created_at
         FROM cloud_chat_conversations c
         JOIN cloud_chat_messages m ON m.conversation_id = c.conversation_id
         WHERE c.legacy_session_id = $1 AND c.kind = 'group'
           AND m.message_id::text = $2 AND m.deleted_at IS NULL",
    )
    .bind(session_id)
    .bind(request_message_id)
    .fetch_optional(pool)
    .await?;
    let Some((conversation_id, created_by, title, sender, content, created_at)) = message else {
        return Ok(None);
    };
    let text = crate::chat_sync::voice::body_for_agent(&content);
    if parse_cloud_group_envelope(&text).is_some() || text.trim().is_empty() {
        return Ok(None);
    }
    let members: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url,
                profile.display_name, profile.avatar_url
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         LEFT JOIN cloud_default_agent_profiles profile
           ON profile.owner_account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.joined_at ASC, member.account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    let participants: Vec<CloudGroupParticipant> = members.into_iter().map(participant).collect();
    let Some(actor) = participants
        .iter()
        .find(|member| member.account_id == sender)
        .cloned()
    else {
        return Ok(None);
    };
    Ok(Some(CloudGroupEnvelope {
        kind: "group-message".to_string(),
        group_id: session_id.trim().to_string(),
        group_space_id: None,
        group_title: title,
        created_by_account_id: created_by,
        actor,
        participants,
        message: Some(CloudGroupMessage {
            mentions: None,
            fork_snapshot: None,
            id: request_message_id.to_string(),
            sender_account_id: sender,
            text,
            created_at_ms: created_at.timestamp_millis(),
            sender_kind: Some("human".to_string()),
            sender_agent_id: None,
            sender_owner_account_id: None,
            sender_owner_name: None,
            sender_display_name: None,
            delivery_state: None,
            reply_to_message_id: None,
            request_id: None,
            message_action: None,
            target_cloud_agent_id: None,
            target_cloud_agent_name: None,
            target_cloud_agent_owner_account_id: None,
            target_cloud_agent_owner_name: None,
            agent_mention_depth: None,
        }),
    }))
}
