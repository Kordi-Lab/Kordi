//! Storing a PiP suggestion: one waiting suggestion per member answer or vote,
//! and one per plan decision, each replacing the one it supersedes.

use serde_json::Value;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::agent_actions::{self, MANAGER_KINDS};

/// How long a PiP suggestion waits for a person.
const SUGGESTION_HOURS: i32 = 24;

pub(super) fn strip_nulls(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

/// A suggestion about to be stored.
pub(super) struct NewSuggestion {
    pub(super) kind: &'static str,
    pub(super) approver: Option<String>,
    pub(super) subject_key: String,
    pub(super) subject: Value,
}

impl NewSuggestion {
    pub(super) fn member(
        kind: &'static str,
        approver: &str,
        subject_key: String,
        subject: Value,
    ) -> Self {
        Self {
            kind,
            approver: Some(approver.to_string()),
            subject_key,
            subject,
        }
    }

    pub(super) fn manager(kind: &'static str, event_id: &str, subject: Value) -> Self {
        Self {
            kind,
            approver: None,
            subject_key: format!("event:{event_id}:{}", kind.trim_start_matches("plan_")),
            subject,
        }
    }
}

/// Stores a suggestion, replacing an older one for the same thing: the same
/// member's answer or vote, or any pending plan decision for the event. An
/// identical suggestion that is still waiting is kept as it is.
pub(super) async fn insert(
    pool: &PgPool,
    conversation_id: Uuid,
    event_id: &str,
    proposed_by: &str,
    suggestion: NewSuggestion,
) -> Result<Uuid, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("plan_card_suggestion:{event_id}"))
        .execute(&mut *tx)
        .await?;
    let kinds: Vec<&str> = if suggestion.approver.is_some() {
        vec![suggestion.kind]
    } else {
        MANAGER_KINDS.to_vec()
    };
    let same: Option<(Uuid,)> = query_as(
        "SELECT action_id FROM cloud_agent_pending_actions
         WHERE kind = $1 AND event_id = $2 AND approver_account_id IS NOT DISTINCT FROM $3
           AND status = 'pending' AND expires_at > now() AND subject = $4",
    )
    .bind(suggestion.kind)
    .bind(event_id)
    .bind(&suggestion.approver)
    .bind(&suggestion.subject)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((action_id,)) = same {
        tx.commit().await?;
        return Ok(action_id);
    }
    let replaced: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_agent_pending_actions
         SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'superseded' END
         WHERE kind = ANY($1) AND event_id = $2 AND status = 'pending'
           AND approver_account_id IS NOT DISTINCT FROM $3
         RETURNING action_id",
    )
    .bind(&kinds)
    .bind(event_id)
    .bind(&suggestion.approver)
    .fetch_all(&mut *tx)
    .await?;
    agent_actions::publish_all(&mut tx, &replaced).await?;
    let (action_id,): (Uuid,) = query_as(
        "INSERT INTO cloud_agent_pending_actions (
             action_id, kind, conversation_id, session_id, approver_account_id,
             proposed_by_account_id, event_id, subject, subject_key, expires_at
         )
         SELECT $1, $2, c.conversation_id, COALESCE(c.legacy_session_id, c.conversation_id::text),
                $3, $4, $5, $6, $7, now() + make_interval(hours => $8)
         FROM cloud_chat_conversations c WHERE c.conversation_id = $9
         RETURNING action_id",
    )
    .bind(Uuid::new_v4())
    .bind(suggestion.kind)
    .bind(&suggestion.approver)
    .bind(proposed_by)
    .bind(event_id)
    .bind(&suggestion.subject)
    .bind(&suggestion.subject_key)
    .bind(SUGGESTION_HOURS)
    .bind(conversation_id)
    .fetch_one(&mut *tx)
    .await?;
    agent_actions::publish(&mut tx, action_id).await?;
    tx.commit().await?;
    Ok(action_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manager_suggestions_share_one_key_per_kind() {
        let suggestion = NewSuggestion::manager("plan_reopen", "plan_9", json!({}));
        assert_eq!(suggestion.subject_key, "event:plan_9:reopen");
        assert!(suggestion.approver.is_none());
        assert_eq!(strip_nulls(json!({"a": null, "b": 1})), json!({"b": 1}));
    }
}
