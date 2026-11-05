//! Resource pool admission for System agent passes.
//!
//! A pass is admitted against the pool of the conversation's organization
//! before its run is queued. When the pool's daily limit is used up, or its
//! emergency stop is on, the System agent does not answer: nothing is
//! queued, the messages and due reminders it would have answered are marked
//! as seen, and nothing is replayed when the next day starts. The first
//! refused pass of a window posts one System notice saying why and when the
//! System agent is back (see `resource_pools::notices`).

use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::cards::mark_card_seen;
use super::config::SystemAgentConfig;
use super::input::Candidate;
use crate::resource_pools::notices::{self, Paused};
use crate::resource_pools::snapshot::{self, Reached};
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

/// A pass the conversation's pool refused, and why.
pub(super) struct Refused<'a> {
    pub config: &'a SystemAgentConfig,
    pub resource_pool: &'a ResourcePool,
    pub organization_id: Option<&'a str>,
    pub admission: Admission,
}

/// The limit that refused a pass: the stop switch, or the first used-up
/// limit in the order admission checks them.
async fn reached(
    pool: &PgPool,
    candidate: &Candidate,
    refused: &Refused<'_>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Reached, sqlx_core::Error> {
    if refused.admission == Admission::Stopped {
        return Ok(Reached::Stopped);
    }
    let scope = candidate.conversation_id.to_string();
    let snapshots = snapshot::load(
        pool,
        refused.resource_pool,
        Some((Feature::SystemAgent, &scope)),
        now,
    )
    .await?;
    Ok(match snapshot::first_reached(&snapshots) {
        Reached::None => Reached::DailyLimit,
        reached => reached,
    })
}

/// Drops a pass the pool would not admit, without a backlog: the cursor
/// moves past the new messages, offered reminders count as fired and the
/// open card as seen, as if the pass had run and stayed silent. The first
/// refused pass of the window also posts the paused line.
pub(super) async fn stay_silent(
    pool: &PgPool,
    candidate: &Candidate,
    input: &Value,
    refused: &Refused<'_>,
) -> Result<(), sqlx_core::Error> {
    let now = chrono::Utc::now();
    let reached = reached(pool, candidate, refused, now).await?;
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
    if changed.rows_affected() > 0 {
        for (event_id, revision) in woken_cards(input) {
            mark_card_seen(&mut *tx, candidate.conversation_id, &event_id, revision).await?;
        }
        // The line comes after the cursor: the System agent's own messages
        // never wake it, so the line starts no pass of its own.
        let paused = Paused {
            conversation_id: candidate.conversation_id,
            pool_id: refused.resource_pool.id(),
            organization_id: refused.organization_id,
            reached,
            sender_account_id: &refused.config.account_id,
            now,
        };
        notices::post_paused_line(&mut tx, &paused).await?;
    }
    tx.commit().await
}

/// Every card the pass was woken for or shown, with the revision it saw: the
/// open card and each `card_changed` hook.
fn woken_cards(input: &Value) -> Vec<(String, i64)> {
    let hooks = input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|hook| hook["name"] == "card_changed");
    let mut cards: Vec<(String, i64)> = std::iter::once(&input["openCard"])
        .chain(hooks)
        .filter_map(|card| {
            Some((
                card["eventId"].as_str()?.to_string(),
                card["revision"].as_i64()?,
            ))
        })
        .collect();
    cards.sort();
    cards.dedup();
    cards
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn every_woken_card_is_marked() {
        let input = json!({
            "openCard": {"eventId": "plan_a", "revision": 4},
            "hooks": [
                {"name": "new_messages", "sinceSequence": 3},
                {"name": "card_changed", "eventId": "plan_a", "revision": 4},
                {"name": "card_changed", "eventId": "plan_b", "revision": 2},
                {"name": "t_minus_2h", "key": "t_minus_2h:plan_c", "eventId": "plan_c"},
            ],
        });
        assert_eq!(
            super::woken_cards(&input),
            vec![("plan_a".to_string(), 4), ("plan_b".to_string(), 2)]
        );
        assert!(super::woken_cards(&json!({"hooks": []})).is_empty());
    }
}
