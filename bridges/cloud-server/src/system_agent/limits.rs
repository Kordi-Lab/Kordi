//! Resource pool admission for System agent passes.
//!
//! A pass is admitted against the pool of the conversation's organization
//! before its run is queued. When the pool's daily limit is used up, or its
//! emergency stop is on, the System agent stays silent: nothing is queued,
//! the messages and due reminders it would have answered are marked as seen,
//! and nothing is replayed when the next day starts.

use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::cards::mark_card_seen;
use super::config::SystemAgentConfig;
use super::input::Candidate;
use crate::resource_pools::usage::{self, Admission};
use crate::resource_pools::{Feature, ResourcePool};

/// The pool that serves a conversation and the organization it belongs to.
pub(super) async fn pool_for<'a>(
    tx: &mut Transaction<'_, Postgres>,
    config: &'a SystemAgentConfig,
    candidate: &Candidate,
) -> Result<(&'a ResourcePool, Option<String>), sqlx_core::Error> {
    let organization_id: Option<String> = query_scalar(
        "SELECT organization_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(candidate.conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    let pool = config.resource_pools().resolve(organization_id.as_deref());
    Ok((pool, organization_id))
}

/// Admits one pass of `run_id` in `tx`, counted for the conversation.
pub(super) async fn admit(
    tx: &mut Transaction<'_, Postgres>,
    pool: &ResourcePool,
    organization_id: Option<&str>,
    run_id: &str,
    candidate: &Candidate,
) -> Result<Admission, sqlx_core::Error> {
    let scope = candidate.conversation_id.to_string();
    usage::reserve(
        tx,
        &usage::Request {
            run_id,
            pool,
            feature: Feature::SystemAgent,
            scope_id: &scope,
            organization_id,
        },
    )
    .await
}

/// Drops a pass the pool would not admit, without a message or a backlog:
/// the cursor moves past the new messages, offered reminders count as fired
/// and the open card as seen, as if the pass had run and stayed silent.
pub(super) async fn stay_silent(
    pool: &PgPool,
    candidate: &Candidate,
    input: &Value,
) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let changed = query(
        "UPDATE cloud_pip_conversation_state
         SET seen_sequence = $2, hooks_fired = hooks_fired || $3::jsonb, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(candidate.conversation_id)
    .bind(candidate.latest_sequence)
    .bind(super::store::offered_reminders(input))
    .execute(&mut *tx)
    .await?;
    let card = &input["openCard"];
    if let (true, Some(event_id), Some(revision)) = (
        changed.rows_affected() > 0,
        card["eventId"].as_str(),
        card["revision"].as_i64(),
    ) {
        mark_card_seen(&mut *tx, candidate.conversation_id, event_id, revision).await?;
    }
    tx.commit().await
}
