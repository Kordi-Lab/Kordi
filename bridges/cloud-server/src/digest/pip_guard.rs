//! Keeps the digest from competing with PiP over group plans.
//!
//! PiP writes a confirmed plan to each attendee's calendar with an id that
//! starts with `plan:` and keeps it in step with the plan card. The digest may
//! read those events but never proposes changing them, and it does not
//! propose a new event for an arrangement PiP is already tracking in a group.

use std::collections::BTreeSet;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::models::{Input, Output};

pub fn is_pip_event(event_id: &str) -> bool {
    event_id.starts_with("plan:")
}

pub(super) async fn drop_pip_conflicts(
    pool: &PgPool,
    input: &Input,
    output: &mut Output,
) -> Result<(), sqlx_core::Error> {
    output
        .calendar_candidates
        .retain(|item| !item.existing_event_id.as_deref().is_some_and(is_pip_event));

    let conversation_of = |source_id: &str| {
        input
            .sources
            .iter()
            .find(|source| source.id == source_id)
            .map(|source| (source.conversation_id.clone(), source.created_at.clone()))
    };
    let mut conversations: BTreeSet<Uuid> = BTreeSet::new();
    for item in &output.calendar_candidates {
        if item.calendar_action.as_deref().unwrap_or("create") != "create" {
            continue;
        }
        for source_id in &item.source_ids {
            if let Some(id) =
                conversation_of(source_id).and_then(|(id, _)| Uuid::parse_str(&id).ok())
            {
                conversations.insert(id);
            }
        }
    }
    if conversations.is_empty() {
        return Ok(());
    }
    // Conversations where PiP holds a live plan, with when that plan started.
    let planned: Vec<(Uuid, chrono::DateTime<chrono::Utc>)> = query_as(
        "SELECT conversation_id, MIN(created_at) FROM cloud_plan_cards
         WHERE conversation_id = ANY($1) AND state <> 'canceled'
         GROUP BY conversation_id",
    )
    .bind(conversations.into_iter().collect::<Vec<_>>())
    .fetch_all(pool)
    .await?;
    if planned.is_empty() {
        return Ok(());
    }
    output.calendar_candidates.retain(|item| {
        if item.calendar_action.as_deref().unwrap_or("create") != "create"
            || item.source_ids.is_empty()
        {
            return true;
        }
        // Drop the suggestion when every source is a message in a chat where
        // PiP picked the plan up within a day of it.
        !item.source_ids.iter().all(|source_id| {
            conversation_of(source_id).is_some_and(|(conversation_id, created_at)| {
                let sent = chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|value| value.with_timezone(&chrono::Utc))
                    .ok();
                planned.iter().any(|(id, plan_started)| {
                    id.to_string() == conversation_id
                        && sent.is_none_or(|sent| *plan_started + chrono::Duration::days(1) >= sent)
                })
            })
        })
    });
    Ok(())
}
