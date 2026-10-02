//! Applying an approved suggestion as the person who approved it, and
//! retiring suggestions that a person's own card action settled.

use std::collections::BTreeSet;

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::super::models::PlanCardRow;
use super::super::routes::{dispatch_row, Actor};
use super::super::shown::ShownPlan;
use super::super::wire::Request;
use crate::cloud_agent_runtime::agent_actions::{self, ActionRow, MANAGER_KINDS};

/// Why an approved suggestion could not be applied.
pub(crate) enum ApplyError {
    /// The plan moved on (another revision, state, or participant list).
    PlanChanged,
    /// The decider may no longer make this decision.
    Forbidden,
    Failed(Response),
}

fn text(subject: &Value, key: &str) -> Option<String> {
    subject[key].as_str().map(str::to_string)
}

/// The card change an approved suggestion stands for, made by the decider.
pub(crate) fn approval_request(kind: &str, subject: &Value, decider: &str) -> Option<Request> {
    let event_id = text(subject, "eventId")?;
    let revision = || subject["revision"].as_i64();
    Some(match kind {
        // An answer or vote applies only to the plan the suggestion showed.
        "plan_rsvp" => Request::Rsvp {
            event_id,
            revision: None,
            participant_id: decider.to_string(),
            rsvp: text(subject, "rsvp")?,
            note: text(subject, "note"),
            shown: Some(ShownPlan::from_subject(kind, subject)?),
        },
        "plan_vote" => Request::Vote {
            event_id,
            revision: None,
            participant_id: decider.to_string(),
            option_id: text(subject, "optionId")?,
            shown: Some(ShownPlan::from_subject(kind, subject)?),
        },
        "plan_confirm" => Request::Confirm {
            event_id,
            revision: revision()?,
            confirmed_by: decider.to_string(),
            option_id: text(subject, "optionId"),
        },
        "plan_cancel" => Request::Cancel {
            event_id,
            revision: revision()?,
            canceled_by: decider.to_string(),
            reason: text(subject, "reason"),
        },
        "plan_reopen" => Request::Reopen {
            event_id,
            revision: revision()?,
            reason: text(subject, "reason")?,
        },
        _ => return None,
    })
}

/// Applies an approved suggestion as the decider, with every check a member's
/// own card action gets.
pub(crate) async fn apply_approval(
    pool: &PgPool,
    row: &ActionRow,
    decider: &str,
) -> Result<PlanCardRow, ApplyError> {
    let Some(request) = approval_request(&row.kind, &row.subject, decider) else {
        return Err(ApplyError::PlanChanged);
    };
    let actor = Actor {
        account_id: decider.to_string(),
        on_behalf_of_conversation: None,
        represented_accounts: BTreeSet::new(),
    };
    dispatch_row(pool, &actor, request)
        .await
        .map_err(|rejection| match rejection.status() {
            StatusCode::FORBIDDEN => ApplyError::Forbidden,
            StatusCode::NOT_FOUND | StatusCode::CONFLICT | StatusCode::BAD_REQUEST => {
                ApplyError::PlanChanged
            }
            _ => ApplyError::Failed(*rejection),
        })
}

/// After an approved suggestion is applied, other suggestions it settles are
/// retired: any other plan decision for the event, or the decider's other
/// pending suggestion of the same kind.
pub(crate) async fn supersede_after_apply(
    tx: &mut Transaction<'_, Postgres>,
    row: &ActionRow,
) -> Result<Vec<(Uuid,)>, sqlx_core::Error> {
    let kinds: Vec<&str> = if row.is_manager_kind() {
        MANAGER_KINDS.to_vec()
    } else {
        vec![row.kind.as_str()]
    };
    query_as(
        "UPDATE cloud_agent_pending_actions SET status = 'superseded'
         WHERE event_id = $1 AND kind = ANY($2) AND status = 'pending' AND action_id <> $3
           AND approver_account_id IS NOT DISTINCT FROM $4
         RETURNING action_id",
    )
    .bind(&row.event_id)
    .bind(&kinds)
    .bind(row.action_id)
    .bind(&row.approver)
    .fetch_all(&mut **tx)
    .await
}

/// A member acting on the card directly settles PiP's matching suggestions:
/// their own answer or vote, or, for a plan decision, every pending one.
pub(in crate::plan_cards) async fn supersede_after_member_action(
    pool: &PgPool,
    account_id: &str,
    action: &str,
    event_id: &str,
) -> Result<(), sqlx_core::Error> {
    let (kinds, approver): (Vec<&str>, Option<&str>) = match action {
        "rsvp" => (vec!["plan_rsvp"], Some(account_id)),
        "vote" => (vec!["plan_vote"], Some(account_id)),
        "confirm" | "cancel" | "reopen" => (MANAGER_KINDS.to_vec(), None),
        _ => return Ok(()),
    };
    let mut tx = pool.begin().await?;
    let settled: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_agent_pending_actions SET status = 'superseded'
         WHERE event_id = $1 AND kind = ANY($2) AND status = 'pending'
           AND approver_account_id IS NOT DISTINCT FROM $3
         RETURNING action_id",
    )
    .bind(event_id)
    .bind(&kinds)
    .bind(approver)
    .fetch_all(&mut *tx)
    .await?;
    agent_actions::publish_all(&mut tx, &settled).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approvals_act_for_the_decider_with_the_stored_revision() {
        let subject = json!({"eventId": "plan_1", "title": "Lunch", "revision": 4,
            "optionId": "opt_2", "rsvp": "no", "reason": "Rain"});
        let Some(Request::Confirm {
            event_id,
            revision,
            confirmed_by,
            option_id,
        }) = approval_request("plan_confirm", &subject, "decider")
        else {
            panic!("confirm");
        };
        assert_eq!(
            (event_id.as_str(), revision, confirmed_by.as_str()),
            ("plan_1", 4, "decider")
        );
        assert_eq!(option_id.as_deref(), Some("opt_2"));
        let Some(Request::Rsvp {
            participant_id,
            rsvp,
            ..
        }) = approval_request("plan_rsvp", &subject, "decider")
        else {
            panic!("rsvp");
        };
        assert_eq!((participant_id.as_str(), rsvp.as_str()), ("decider", "no"));
        assert!(matches!(
            approval_request("plan_reopen", &subject, "decider"),
            Some(Request::Reopen { revision: 4, .. })
        ));
        assert!(matches!(
            approval_request("plan_cancel", &subject, "decider"),
            Some(Request::Cancel { revision: 4, .. })
        ));
        // A decision without the revision it was suggested at never applies.
        assert!(approval_request("plan_confirm", &json!({"eventId": "plan_1"}), "d").is_none());
        assert!(approval_request("calendar_disclosure", &subject, "d").is_none());
    }
}
