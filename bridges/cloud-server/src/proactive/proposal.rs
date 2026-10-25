//! A proposal as the server code reads it, and the account hint that tells
//! the owner's devices it changed. Nothing is posted as a message: the
//! owner's client shows the offer inside the group conversation from the
//! proposals route, refreshed by `proactive.proposal_changed`.

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

/// The hint appended for the owner on creation and on every status change.
pub(crate) const HINT: &str = "proactive.proposal_changed";

/// A proposal with the names the run and the push need.
#[derive(Debug, Clone)]
pub(crate) struct Proposal {
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
}

type ProposalRow = (
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
);

pub(crate) async fn load(
    pool: &PgPool,
    proposal_id: &str,
) -> Result<Option<Proposal>, sqlx_core::Error> {
    // The definition's name, else the default agent's.
    let row: Option<ProposalRow> = query_as(concat!(
        "SELECT p.proposal_id, p.agent_id, COALESCE(agent.name, ",
        super::agents::default_name_sql!("owner", "profile"),
        "), p.owner_account_id, p.conversation_id,
                p.session_id, COALESCE(c.group_title, c.shared_title), p.trigger_message_id,
                p.problem, p.offer, p.plan, p.status
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
    Ok(row.map(|row| Proposal {
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
    }))
}

/// Appends the hint for each proposal's owner inside `tx`, so the hint and
/// the change commit together. The payload carries the fields the proposals
/// route returns, so a device can update without a round trip.
pub(crate) async fn hint(
    tx: &mut Transaction<'_, Postgres>,
    proposal_ids: &[String],
) -> Result<(), sqlx_core::Error> {
    if proposal_ids.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String, Value)> = query_as(
        "SELECT p.owner_account_id, jsonb_build_object(
             'proposalId', p.proposal_id, 'agentId', p.agent_id,
             'conversationId', p.conversation_id::text, 'sessionId', p.session_id,
             'status', p.status, 'problem', p.problem, 'offer', p.offer, 'plan', p.plan,
             'expiresAt', to_char(p.expires_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
             'runId', p.run_id,
             'replyMessageId', CASE WHEN p.status = 'done' THEN run.response_message_id END)
         FROM cloud_agent_proactive_proposals p
         LEFT JOIN cloud_agent_fallback_runs run ON run.run_id = p.run_id
         WHERE p.proposal_id = ANY($1)
         ORDER BY p.proposal_id",
    )
    .bind(proposal_ids)
    .fetch_all(&mut **tx)
    .await?;
    for (owner, payload) in rows {
        crate::chat_sync::store::append_account_hint(tx, &owner, HINT, &payload)
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    }
    Ok(())
}

/// Expires the pending proposals whose time ran out (all of them, or one
/// owner's) and hints each change. Returns the expired ids.
pub(crate) async fn expire_due(
    tx: &mut Transaction<'_, Postgres>,
    owner_account_id: Option<&str>,
) -> Result<Vec<String>, sqlx_core::Error> {
    let expired: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_proactive_proposals SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= now()
           AND ($1::text IS NULL OR owner_account_id = $1)
         RETURNING proposal_id",
    )
    .bind(owner_account_id)
    .fetch_all(&mut **tx)
    .await?;
    let expired: Vec<String> = expired.into_iter().map(|(id,)| id).collect();
    hint(tx, &expired).await?;
    Ok(expired)
}
