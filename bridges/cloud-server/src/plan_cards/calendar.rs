//! A confirmed plan on each attending member's Kordi calendar.
//!
//! The digest calendar is per account; the plan writes one event per member
//! whose answer is yes, keyed by the card so later changes update the same
//! entry, and removes it again for a decline or a cancellation.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::models::{PlanCardRow, PlanCardRsvp, PlanCardState};

fn calendar_event_id(event_id: &str) -> String {
    format!("plan:{event_id}")
}

pub async fn sync_plan(pool: &PgPool, row: &PlanCardRow) -> Result<(), sqlx_core::Error> {
    let calendar_id = calendar_event_id(&row.event_id);
    let attending = row.state == PlanCardState::Confirmed && row.start_at.is_some();
    let title: Option<(Option<String>, Option<String>)> =
        match Uuid::parse_str(&row.conversation_id) {
            Ok(conversation_id) => {
                query_as(
                    "SELECT shared_title, group_title FROM cloud_chat_conversations \
                     WHERE conversation_id = $1",
                )
                .bind(conversation_id)
                .fetch_optional(pool)
                .await?
            }
            Err(_) => None,
        };
    let group = title
        .and_then(|(shared, group)| group.or(shared))
        .filter(|value| !value.trim().is_empty());
    let mut description = match group {
        Some(group) => format!("Planned with Pip in {group}."),
        None => "Planned with Pip.".to_string(),
    };
    if let Some(location) = row
        .location
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        description.push_str(&format!(" Where: {location}."));
    }
    let start = row
        .start_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    let end_at = row
        .end_at
        .clone()
        .or_else(|| start.map(|start| (start + chrono::Duration::hours(2)).to_rfc3339()));
    let reminder_at = start.map(|start| (start - chrono::Duration::hours(1)).to_rfc3339());

    for participant in &row.participants {
        let keep = attending && participant.rsvp == PlanCardRsvp::Yes;
        if keep {
            let payload = json!({
                "id": calendar_id,
                "title": row.title,
                "startAt": row.start_at,
                "endAt": end_at,
                "reminderAt": reminder_at,
                "allDay": false,
                "sourceIds": [],
                "description": description,
                "externalUid": null,
            });
            query(
                "INSERT INTO cloud_calendar_events (account_id, event_id, payload) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (account_id, event_id) DO UPDATE \
                 SET payload = EXCLUDED.payload, revision = cloud_calendar_events.revision + 1, \
                     updated_at = now() \
                 WHERE cloud_calendar_events.payload IS DISTINCT FROM EXCLUDED.payload",
            )
            .bind(&participant.account_id)
            .bind(&calendar_id)
            .bind(payload)
            .execute(pool)
            .await?;
        } else {
            query("DELETE FROM cloud_calendar_events WHERE account_id = $1 AND event_id = $2")
                .bind(&participant.account_id)
                .bind(&calendar_id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}
