use std::collections::HashSet;

use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::{
    envelope::{contains_agent, history, is_history_message, parse, Envelope, Message},
    SKILL_PACK_ID,
};

fn newest_context_message(envelopes: &[Envelope]) -> Option<Message> {
    envelopes
        .iter()
        .find(|envelope| is_history_message(envelope))
        .and_then(|envelope| envelope.message.clone())
}

pub async fn run_still_eligible(pool: &PgPool, run_id: &str) -> Result<bool, sqlx_core::Error> {
    let metadata: Option<(String, String, String, String)> = query_as(
        "SELECT request_message_id, session_id, owner_account_id, target_agent_id
         FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND trigger_kind = 'proactive'",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((request_message_id, session_id, owner_account_id, target_agent_id)) = metadata else {
        return Ok(false);
    };
    let active: Option<(String, Option<String>)> = query_as(
        "SELECT agent_id, source_agent_id FROM cloud_agent_definitions
         WHERE agent_id = $1
           AND owner_account_id = $2
           AND status = 'active'
           AND access_scope = 'participant_conversations'
           AND is_system_managed = FALSE
           AND proactive_enabled = TRUE
           AND proactive_skill_pack = $3",
    )
    .bind(&target_agent_id)
    .bind(&owner_account_id)
    .bind(SKILL_PACK_ID)
    .fetch_optional(pool)
    .await?;
    let Some((_, source_agent_id)) = active else {
        return Ok(false);
    };
    let cooldown_cutoff = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
    let recent_intervention: Option<(String,)> = query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs
         WHERE run_id <> $1
           AND target_agent_id = $2
           AND session_id = $3
           AND trigger_kind = 'proactive'
           AND proactive_decision = 'intervention'
           AND completed_at >= $4
         LIMIT 1",
    )
    .bind(run_id)
    .bind(&target_agent_id)
    .bind(&session_id)
    .bind(&cooldown_cutoff)
    .fetch_optional(pool)
    .await?;
    if recent_intervention.is_some() {
        return Ok(false);
    }
    let rows = query_as::<_, (String,)>(
        "SELECT body FROM cloud_messages
         WHERE session_id = $1
         ORDER BY created_at DESC, message_id DESC
         LIMIT 160",
    )
    .bind(&session_id)
    .fetch_all(pool)
    .await?;
    let envelopes = rows
        .into_iter()
        .filter_map(|(body,)| parse(&body))
        .collect::<Vec<_>>();
    let latest_membership = envelopes.first();
    let latest_context = newest_context_message(&envelopes);
    Ok(latest_context
        .as_ref()
        .is_some_and(|message| message.id == request_message_id)
        && latest_membership.is_some_and(|envelope| {
            contains_agent(
                &envelope.participants,
                &owner_account_id,
                &target_agent_id,
                source_agent_id.as_deref(),
            )
        }))
}

pub async fn evidence_is_canonical(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
    agent_id: &str,
    evidence_message_ids: &[String],
) -> Result<bool, sqlx_core::Error> {
    if evidence_message_ids.is_empty() {
        return Ok(false);
    }
    let source_agent_id: Option<(Option<String>,)> = query_as(
        "SELECT source_agent_id FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    let source_agent_id = source_agent_id.and_then(|(value,)| value);
    let available = history(
        pool,
        session_id,
        owner_account_id,
        agent_id,
        source_agent_id.as_deref(),
    )
    .await?
    .into_iter()
    .map(|message| message.id)
    .collect::<HashSet<_>>();
    Ok(evidence_message_ids
        .iter()
        .all(|message_id| available.contains(message_id)))
}

pub async fn cancel_if_ineligible(
    pool: &PgPool,
    run_id: &str,
    trigger_kind: &str,
) -> Result<bool, sqlx_core::Error> {
    if trigger_kind != "proactive" || run_still_eligible(pool, run_id).await? {
        return Ok(false);
    }
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL,
             updated_at = $2, completed_at = $2
         WHERE run_id = $1
           AND trigger_kind = 'proactive'
           AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        super::envelope::{Envelope, Message, Participant},
        newest_context_message,
    };

    fn envelope(id: &str, text: &str) -> Envelope {
        let participant = Participant {
            account_id: "acct_human".to_string(),
            agent_ids: vec![],
        };
        Envelope {
            kind: "group-message".to_string(),
            group_id: "session:group:test".to_string(),
            actor: participant.clone(),
            participants: vec![participant],
            message: Some(Message {
                id: id.to_string(),
                sender_account_id: "acct_human".to_string(),
                text: text.to_string(),
                sender_kind: Some("human".to_string()),
                sender_display_name: Some("Human".to_string()),
                delivery_state: Some("complete".to_string()),
                fork_snapshot: None,
                message_action: None,
                target_cloud_agent_id: None,
                target_cloud_agent_owner_account_id: None,
            }),
        }
    }

    #[test]
    fn newest_context_message_uses_canonical_row_order_including_agents() {
        let mut agent_reply = envelope("msg_agent", "I already handled this");
        agent_reply.message.as_mut().unwrap().sender_kind = Some("agent".to_string());
        let newest_first = [
            agent_reply,
            envelope("msg_old", "This human message triggered it"),
        ];
        assert_eq!(
            newest_context_message(&newest_first)
                .map(|message| message.id)
                .as_deref(),
            Some("msg_agent")
        );
    }
}
