//! PiP outranks the digest on group plans.
//!
//! PiP writes a confirmed plan to each attendee's calendar with an id that
//! starts with `plan:` and keeps it in step with the plan card. The digest may
//! read those events, but it never proposes changing them and never proposes
//! a second event for a plan PiP tracks. The rule is applied when a digest
//! is produced, and again the moment PiP confirms a plan, so a suggestion
//! saved earlier does not linger until the member's next digest run.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::models::{Input, Item, Output};

pub fn is_pip_event(event_id: &str) -> bool {
    event_id.starts_with("plan:")
}

/// A plan PiP tracks, as far as matching a digest suggestion needs.
#[derive(Clone, Debug)]
pub struct TrackedPlan {
    pub conversation_id: Option<String>,
    pub title: String,
    pub start_at: Option<DateTime<Utc>>,
}

const STOP_WORDS: &[&str] = &[
    "with", "from", "this", "that", "next", "week", "night", "morning", "evening", "plan",
    "meeting", "event", "the", "and", "for",
];

fn title_words(title: &str) -> BTreeSet<String> {
    title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() >= 4 && !STOP_WORDS.contains(word))
        .map(str::to_string)
        .collect()
}

fn parse_instant(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

/// Whether a create suggestion is the same arrangement as a plan PiP tracks:
/// it comes from the plan's chat near the plan's time (or at no stated time),
/// or from that chat with a shared meaningful title word while the plan's own
/// time is still open, or it starts within 90 minutes of the plan and shares
/// a meaningful title word. A plan with no time never blocks everything else
/// from its chat.
fn duplicates(
    item_conversations: &BTreeSet<String>,
    item_title: &str,
    item_start: Option<DateTime<Utc>>,
    plan: &TrackedPlan,
) -> bool {
    let near = |hours: i64| match (item_start, plan.start_at) {
        (Some(item), Some(plan)) => (item - plan).num_minutes().abs() <= hours * 60,
        (None, Some(_)) => true,
        (_, None) => false,
    };
    let shares_title_word = || !title_words(item_title).is_disjoint(&title_words(&plan.title));
    let same_chat = plan
        .conversation_id
        .as_ref()
        .is_some_and(|id| item_conversations.contains(id));
    if same_chat && (near(12) || (plan.start_at.is_none() && shares_title_word())) {
        return true;
    }
    let close_in_time = matches!((item_start, plan.start_at), (Some(item), Some(plan)) if (item - plan).num_minutes().abs() <= 90);
    close_in_time && shares_title_word()
}

fn keep_candidate(
    item: &Item,
    conversations_of: &dyn Fn(&str) -> Option<String>,
    plans: &[TrackedPlan],
) -> bool {
    if item.existing_event_id.as_deref().is_some_and(is_pip_event) {
        return false;
    }
    if item.calendar_action.as_deref().unwrap_or("create") != "create" {
        return true;
    }
    let conversations: BTreeSet<String> = item
        .source_ids
        .iter()
        .filter_map(|id| conversations_of(id))
        .collect();
    let start = parse_instant(item.start_at.as_deref());
    !plans
        .iter()
        .any(|plan| duplicates(&conversations, &item.title, start, plan))
}

async fn live_plans(
    pool: &PgPool,
    conversations: &[Uuid],
) -> Result<Vec<TrackedPlan>, sqlx_core::Error> {
    if conversations.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(Uuid, String, Option<DateTime<Utc>>)> = query_as(concat!(
        "SELECT card.conversation_id, card.title, card.start_at FROM cloud_plan_cards card
         WHERE card.conversation_id = ANY($1) AND ",
        crate::plan_cards::live_plan_card_sql!()
    ))
    .bind(conversations)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(conversation_id, title, start_at)| TrackedPlan {
            conversation_id: Some(conversation_id.to_string()),
            title,
            start_at,
        })
        .collect())
}

/// Applied when a digest is produced.
pub(super) async fn drop_pip_conflicts(
    pool: &PgPool,
    input: &Input,
    output: &mut Output,
) -> Result<(), sqlx_core::Error> {
    let conversation_of = |source_id: &str| {
        input
            .sources
            .iter()
            .find(|source| source.id == source_id)
            .map(|source| source.conversation_id.clone())
    };
    let conversations: Vec<Uuid> = output
        .calendar_candidates
        .iter()
        .flat_map(|item| item.source_ids.iter())
        .filter_map(|id| conversation_of(id))
        .filter_map(|id| Uuid::parse_str(&id).ok())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut plans = live_plans(pool, &conversations).await?;
    // Confirmed plans already on this person's calendar, from any chat.
    plans.extend(
        input
            .calendar_events
            .iter()
            .filter(|event| is_pip_event(&event.id))
            .map(|event| TrackedPlan {
                conversation_id: None,
                title: event.title.clone(),
                start_at: parse_instant(Some(&event.start_at)),
            }),
    );
    output
        .calendar_candidates
        .retain(|item| keep_candidate(item, &conversation_of, &plans));
    Ok(())
}

/// Applied the moment PiP confirms or changes a plan: removes competing
/// calendar suggestions from the saved digests of the plan's members.
pub async fn clear_saved_conflicts(
    pool: &PgPool,
    account_ids: &[String],
    plan: &TrackedPlan,
) -> Result<(), sqlx_core::Error> {
    if account_ids.is_empty() {
        return Ok(());
    }
    let digests: Vec<(String, Value, Value, i64)> = query_as(
        "SELECT account_id, snapshot_json, COALESCE(snapshot_input_json, '{}'), revision
         FROM cloud_account_digests
         WHERE account_id = ANY($1) AND snapshot_json IS NOT NULL",
    )
    .bind(account_ids)
    .fetch_all(pool)
    .await?;
    for (account_id, snapshot, input, revision) in digests {
        let Ok(mut output) = serde_json::from_value::<Output>(snapshot) else {
            continue;
        };
        let sources = input
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let conversation_of = |source_id: &str| {
            sources
                .iter()
                .find(|source| source.get("id").and_then(Value::as_str) == Some(source_id))
                .and_then(|source| source.get("conversationId").and_then(Value::as_str))
                .map(str::to_string)
        };
        let before = output.calendar_candidates.len();
        output
            .calendar_candidates
            .retain(|item| keep_candidate(item, &conversation_of, std::slice::from_ref(plan)));
        if output.calendar_candidates.len() == before {
            continue;
        }
        let Ok(updated) = serde_json::to_value(&output) else {
            continue;
        };
        // Only the snapshot this was read from is rewritten: a digest saved in
        // the meantime was produced with PiP's plans already applied.
        let mut tx = pool.begin().await?;
        let written = query(
            "UPDATE cloud_account_digests
             SET snapshot_json = $2, revision = revision + 1, updated_at = now()
             WHERE account_id = $1 AND revision = $3",
        )
        .bind(&account_id)
        .bind(updated)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
        if written.rows_affected() > 0 {
            crate::chat_sync::store::append_account_hint(
                &mut tx,
                &account_id,
                "digest.updated",
                &serde_json::json!({"updated": true}),
            )
            .await
            .map_err(|_| sqlx_core::Error::Protocol("Could not publish digest update.".into()))?;
        }
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> Option<DateTime<Utc>> {
        parse_instant(Some(value))
    }

    #[test]
    fn same_chat_near_the_plan_is_a_duplicate() {
        let plan = TrackedPlan {
            conversation_id: Some("chat".into()),
            title: "Movie night".into(),
            start_at: at("2026-09-19T17:00:00Z"),
        };
        let chats = BTreeSet::from(["chat".to_string()]);
        assert!(duplicates(
            &chats,
            "Cinema",
            at("2026-09-19T18:00:00Z"),
            &plan
        ));
        assert!(duplicates(&chats, "Cinema", None, &plan));
        assert!(!duplicates(
            &chats,
            "Cinema",
            at("2026-09-25T18:00:00Z"),
            &plan
        ));
    }

    #[test]
    fn a_plan_with_no_time_only_matches_its_own_arrangement() {
        let plan = TrackedPlan {
            conversation_id: Some("chat".into()),
            title: "Board games night".into(),
            start_at: None,
        };
        let chats = BTreeSet::from(["chat".to_string()]);
        assert!(duplicates(
            &chats,
            "Board games",
            at("2026-09-19T18:00:00Z"),
            &plan
        ));
        assert!(!duplicates(
            &chats,
            "Dentist",
            at("2026-09-19T18:00:00Z"),
            &plan
        ));
        assert!(!duplicates(&chats, "Dentist", None, &plan));
    }

    #[test]
    fn another_chat_needs_close_time_and_a_shared_title_word() {
        let plan = TrackedPlan {
            conversation_id: None,
            title: "Board games at Jordan's".into(),
            start_at: at("2026-09-18T17:00:00Z"),
        };
        let none = BTreeSet::new();
        assert!(duplicates(
            &none,
            "Board games",
            at("2026-09-18T17:30:00Z"),
            &plan
        ));
        assert!(!duplicates(
            &none,
            "Dentist",
            at("2026-09-18T17:30:00Z"),
            &plan
        ));
        assert!(!duplicates(
            &none,
            "Board games",
            at("2026-09-18T21:00:00Z"),
            &plan
        ));
    }
}
