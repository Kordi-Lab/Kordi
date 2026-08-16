use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::calls::models::{CallKind, CallParticipantSnapshot, CallSnapshot, CallState};
use crate::chat_sync::store;
mod active_calls;
mod activity;
mod start;
mod tokens;
pub use active_calls::active_for_account;
use activity::{record_call_activity, CallActivityEvent};
pub use start::start;
pub use tokens::{
    register_notification_push_token, register_voip_push_token, NotificationPushTokenRegistration,
};

type CallRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
);

type ParticipantRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
);

#[derive(Debug)]
pub enum CallStoreError {
    Database(sqlx_core::Error),
    InvalidKind,
    InvalidPushToken,
    NotFound,
    Forbidden,
    Conflict,
    Invariant(&'static str),
}

impl From<sqlx_core::Error> for CallStoreError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

impl From<store::StoreError> for CallStoreError {
    fn from(error: store::StoreError) -> Self {
        match error {
            store::StoreError::Database(error) => Self::Database(error),
            _ => Self::Invariant("could not publish call sync event"),
        }
    }
}

pub struct StartedCall {
    pub call: CallSnapshot,
    pub room_name: String,
    pub display_name: String,
    pub inserted: bool,
}

pub struct JoinableCall {
    pub call: CallSnapshot,
    pub room_name: String,
    pub display_name: String,
}

pub struct InvitableCall {
    pub call: CallSnapshot,
    pub display_name: String,
}

fn parse_kind(value: &str) -> Result<CallKind, CallStoreError> {
    match value {
        "voice" => Ok(CallKind::Voice),
        "video" => Ok(CallKind::Video),
        "meeting" => Ok(CallKind::Meeting),
        _ => Err(CallStoreError::Invariant("stored call kind is invalid")),
    }
}

fn parse_state(value: &str) -> Result<CallState, CallStoreError> {
    match value {
        "ringing" => Ok(CallState::Ringing),
        "active" => Ok(CallState::Active),
        "ended" => Ok(CallState::Ended),
        _ => Err(CallStoreError::Invariant("stored call state is invalid")),
    }
}

async fn participant_rows(
    transaction: &mut Transaction<'_, Postgres>,
    call_id: Uuid,
) -> Result<Vec<CallParticipantSnapshot>, CallStoreError> {
    let rows: Vec<ParticipantRow> = query_as(
        "SELECT participant.account_id, account.display_name, account.avatar_url, \
                participant.participant_state, participant.joined_at, participant.left_at \
         FROM cloud_call_participants participant \
         JOIN cloud_accounts account ON account.account_id = participant.account_id \
         WHERE participant.call_id = $1 \
         ORDER BY participant.invited_at ASC, participant.account_id ASC",
    )
    .bind(call_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| CallParticipantSnapshot {
            account_id: row.0,
            display_name: row.1,
            avatar_url: row.2,
            state: row.3,
            joined_at: row.4,
            left_at: row.5,
        })
        .collect())
}

async fn snapshot_from_row(
    transaction: &mut Transaction<'_, Postgres>,
    row: CallRow,
) -> Result<(CallSnapshot, String), CallStoreError> {
    let participants = participant_rows(transaction, row.0).await?;
    Ok((
        CallSnapshot {
            id: row.0,
            conversation_id: row.1,
            kind: parse_kind(&row.2)?,
            state: parse_state(&row.3)?,
            created_by_account_id: row.4,
            created_at: row.6,
            answered_at: row.7,
            ended_at: row.8,
            participants,
        },
        row.5,
    ))
}

async fn load_call_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    call_id: Uuid,
) -> Result<(CallSnapshot, String), CallStoreError> {
    let row: Option<CallRow> = query_as(
        "SELECT call_id, conversation_id, call_kind, call_state, created_by_account_id, \
                room_name, created_at, answered_at, ended_at \
         FROM cloud_calls WHERE call_id = $1",
    )
    .bind(call_id)
    .fetch_optional(&mut **transaction)
    .await?;
    snapshot_from_row(transaction, row.ok_or(CallStoreError::NotFound)?).await
}

async fn require_participant(
    transaction: &mut Transaction<'_, Postgres>,
    call_id: Uuid,
    account_id: &str,
) -> Result<String, CallStoreError> {
    let row: Option<(String,)> = query_as(
        "SELECT participant_state FROM cloud_call_participants \
         WHERE call_id = $1 AND account_id = $2",
    )
    .bind(call_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|value| value.0).ok_or(CallStoreError::Forbidden)
}

async fn publish_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    call: &CallSnapshot,
) -> Result<(), CallStoreError> {
    let recipients = call
        .participants
        .iter()
        .map(|participant| participant.account_id.clone())
        .collect::<Vec<_>>();
    let payload = json!({ "call": call });
    store::append_user_sync_events_in_transaction(
        transaction,
        &recipients,
        event_type,
        Some(call.conversation_id),
        &payload,
    )
    .await?;
    Ok(())
}

pub async fn active(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
) -> Result<Option<CallSnapshot>, CallStoreError> {
    let mut transaction = pool.begin().await?;
    let row: Option<CallRow> = query_as(
        "SELECT call.call_id, call.conversation_id, call.call_kind, call.call_state, \
                call.created_by_account_id, call.room_name, call.created_at, \
                call.answered_at, call.ended_at \
         FROM cloud_calls call \
         JOIN cloud_call_participants participant ON participant.call_id = call.call_id \
         WHERE call.conversation_id = $1 AND call.ended_at IS NULL \
           AND participant.account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let call = match row {
        Some(row) => Some(snapshot_from_row(&mut transaction, row).await?.0),
        None => None,
    };
    transaction.commit().await?;
    Ok(call)
}

pub async fn join(
    pool: &PgPool,
    account_id: &str,
    call_id: Uuid,
) -> Result<JoinableCall, CallStoreError> {
    let mut transaction = pool.begin().await?;
    let participant_state = require_participant(&mut transaction, call_id, account_id).await?;
    let (before, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    if before.state == CallState::Ended {
        return Err(CallStoreError::Conflict);
    }
    if before.kind != CallKind::Meeting && matches!(participant_state.as_str(), "declined" | "left")
    {
        return Err(CallStoreError::Conflict);
    }
    query(
        "UPDATE cloud_call_participants SET participant_state = 'joined', \
                joined_at = COALESCE(joined_at, NOW()), left_at = NULL \
         WHERE call_id = $1 AND account_id = $2",
    )
    .bind(call_id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await?;
    query(
        "UPDATE cloud_calls SET call_state = 'active', answered_at = COALESCE(answered_at, NOW()) \
         WHERE call_id = $1 AND ended_at IS NULL",
    )
    .bind(call_id)
    .execute(&mut *transaction)
    .await?;
    let (call, room_name) = load_call_in_transaction(&mut transaction, call_id).await?;
    let display_name = account_display_name(&mut transaction, account_id).await?;
    publish_snapshot(&mut transaction, "call.updated", &call).await?;
    transaction.commit().await?;
    Ok(JoinableCall {
        call,
        room_name,
        display_name,
    })
}

pub async fn invite(
    pool: &PgPool,
    account_id: &str,
    call_id: Uuid,
) -> Result<InvitableCall, CallStoreError> {
    let mut transaction = pool.begin().await?;
    let participant_state = require_participant(&mut transaction, call_id, account_id).await?;
    let (before, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    if before.kind != CallKind::Meeting
        || before.state != CallState::Active
        || participant_state != "joined"
    {
        return Err(CallStoreError::Conflict);
    }
    query(
        "UPDATE cloud_call_participants SET participant_state = 'invited', \
                invited_at = NOW(), joined_at = NULL, left_at = NULL \
         WHERE call_id = $1 AND account_id <> $2 AND participant_state <> 'joined'",
    )
    .bind(call_id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await?;
    let (call, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    let display_name = account_display_name(&mut transaction, account_id).await?;
    publish_snapshot(&mut transaction, "call.updated", &call).await?;
    transaction.commit().await?;
    Ok(InvitableCall { call, display_name })
}

async fn account_display_name(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<String, CallStoreError> {
    let display_name: Option<(Option<String>, i64)> = query_as(
        "SELECT display_name, public_account_number FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(display_name
        .map(|(display_name, public_account_number)| {
            preferred_account_display_name(display_name, public_account_number)
        })
        .unwrap_or_else(|| "Kordi user".to_string()))
}

fn preferred_account_display_name(
    display_name: Option<String>,
    public_account_number: i64,
) -> String {
    display_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| public_account_number.to_string())
}

pub async fn decline(
    pool: &PgPool,
    account_id: &str,
    call_id: Uuid,
) -> Result<CallSnapshot, CallStoreError> {
    let mut transaction = pool.begin().await?;
    require_participant(&mut transaction, call_id, account_id).await?;
    let (before, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    if before.created_by_account_id == account_id || before.state == CallState::Ended {
        return Err(CallStoreError::Conflict);
    }
    query(
        "UPDATE cloud_call_participants SET participant_state = 'declined', left_at = NOW() \
         WHERE call_id = $1 AND account_id = $2 AND participant_state = 'invited'",
    )
    .bind(call_id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await?;
    if before.kind != CallKind::Meeting {
        query(
            "UPDATE cloud_calls SET call_state = 'ended', ended_at = NOW() \
             WHERE call_id = $1 AND ended_at IS NULL",
        )
        .bind(call_id)
        .execute(&mut *transaction)
        .await?;
    }
    let (call, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    publish_snapshot(&mut transaction, "call.updated", &call).await?;
    if call.state == CallState::Ended {
        record_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
    }
    transaction.commit().await?;
    Ok(call)
}

pub async fn leave(
    pool: &PgPool,
    account_id: &str,
    call_id: Uuid,
) -> Result<CallSnapshot, CallStoreError> {
    let mut transaction = pool.begin().await?;
    require_participant(&mut transaction, call_id, account_id).await?;
    let (before, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    if before.state == CallState::Ended {
        transaction.commit().await?;
        return Ok(before);
    }
    query(
        "UPDATE cloud_call_participants SET participant_state = 'left', left_at = NOW() \
         WHERE call_id = $1 AND account_id = $2",
    )
    .bind(call_id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await?;
    let joined: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_call_participants \
         WHERE call_id = $1 AND participant_state = 'joined'",
    )
    .bind(call_id)
    .fetch_one(&mut *transaction)
    .await?;
    if before.kind != CallKind::Meeting || joined.0 == 0 {
        query(
            "UPDATE cloud_calls SET call_state = 'ended', ended_at = NOW() \
             WHERE call_id = $1 AND ended_at IS NULL",
        )
        .bind(call_id)
        .execute(&mut *transaction)
        .await?;
    }
    let (call, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    publish_snapshot(&mut transaction, "call.updated", &call).await?;
    if call.state == CallState::Ended {
        record_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
    }
    transaction.commit().await?;
    Ok(call)
}

pub async fn end(
    pool: &PgPool,
    account_id: &str,
    call_id: Uuid,
) -> Result<CallSnapshot, CallStoreError> {
    let mut transaction = pool.begin().await?;
    require_participant(&mut transaction, call_id, account_id).await?;
    let (before, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    if before.kind == CallKind::Meeting && before.created_by_account_id != account_id {
        return Err(CallStoreError::Forbidden);
    }
    query(
        "UPDATE cloud_calls SET call_state = 'ended', ended_at = COALESCE(ended_at, NOW()) \
         WHERE call_id = $1",
    )
    .bind(call_id)
    .execute(&mut *transaction)
    .await?;
    query(
        "UPDATE cloud_call_participants SET participant_state = CASE \
                WHEN participant_state = 'declined' THEN 'declined' ELSE 'left' END, \
                left_at = COALESCE(left_at, NOW()) WHERE call_id = $1",
    )
    .bind(call_id)
    .execute(&mut *transaction)
    .await?;
    let (call, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    publish_snapshot(&mut transaction, "call.updated", &call).await?;
    record_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
    transaction.commit().await?;
    Ok(call)
}

#[cfg(test)]
mod tests {
    use super::preferred_account_display_name;

    #[test]
    fn call_display_name_prefers_a_non_empty_profile_name() {
        assert_eq!(
            preferred_account_display_name(Some("Alex".to_string()), 123_456_789),
            "Alex"
        );
    }

    #[test]
    fn call_display_name_formats_the_numeric_public_account_number() {
        assert_eq!(
            preferred_account_display_name(Some("  ".to_string()), 123_456_789),
            "123456789"
        );
    }
}
