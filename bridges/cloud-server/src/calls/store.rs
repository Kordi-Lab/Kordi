use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::calls::models::{
    CallKind, CallParticipantSnapshot, CallSnapshot, CallState, StartCallRequest,
};
use crate::chat_sync::models::SendMessageRequest;
use crate::chat_sync::store;

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

pub async fn register_voip_push_token(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    let clean_token = device_token.trim().to_ascii_lowercase();
    let valid_token = (32..=200).contains(&clean_token.len())
        && clean_token.bytes().all(|value| value.is_ascii_hexdigit());
    if !valid_token || !matches!(environment, "development" | "production") {
        return Err(CallStoreError::InvalidPushToken);
    }
    query(
        "INSERT INTO cloud_voip_push_tokens \
         (device_id, account_id, device_token, apns_environment) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (device_id) DO UPDATE SET \
           account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
           apns_environment = EXCLUDED.apns_environment, updated_at = NOW()",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(clean_token)
    .bind(environment)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn register_notification_push_token(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    device_token: &str,
    environment: &str,
) -> Result<(), CallStoreError> {
    let clean_token = device_token.trim().to_ascii_lowercase();
    let valid_token = (32..=200).contains(&clean_token.len())
        && clean_token.bytes().all(|value| value.is_ascii_hexdigit());
    if !valid_token || !matches!(environment, "development" | "production") {
        return Err(CallStoreError::InvalidPushToken);
    }
    query(
        "INSERT INTO cloud_apns_push_tokens \
         (device_id, account_id, device_token, apns_environment) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (device_id) DO UPDATE SET \
           account_id = EXCLUDED.account_id, device_token = EXCLUDED.device_token, \
           apns_environment = EXCLUDED.apns_environment, updated_at = NOW()",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(clean_token)
    .bind(environment)
    .execute(pool)
    .await?;
    Ok(())
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

#[derive(Clone, Copy)]
enum CallActivityEvent {
    Started,
    Ended,
}

impl CallActivityEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Ended => "ended",
        }
    }
}

fn call_activity_message_kind(call_id: Uuid, event: CallActivityEvent) -> String {
    format!("call.{}.{}", event.as_str(), call_id)
}

fn call_activity_client_message_id(call_id: Uuid, event: CallActivityEvent) -> Uuid {
    match event {
        CallActivityEvent::Started => call_id,
        CallActivityEvent::Ended => Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("kordi-call-ended:{call_id}").as_bytes(),
        ),
    }
}

fn call_activity_text(
    kind: CallKind,
    event: CallActivityEvent,
    display_name: Option<&str>,
) -> String {
    let noun = match kind {
        CallKind::Voice => "voice call",
        CallKind::Video => "video call",
        CallKind::Meeting => "video chat",
    };
    match event {
        CallActivityEvent::Started => {
            format!(
                "{} started a {noun}.",
                display_name.unwrap_or("A participant")
            )
        }
        CallActivityEvent::Ended => format!("The {noun} ended."),
    }
}

async fn append_call_activity(
    transaction: &mut Transaction<'_, Postgres>,
    call: &CallSnapshot,
    event: CallActivityEvent,
    display_name: Option<&str>,
) -> Result<(), CallStoreError> {
    store::send_message_in_transaction(
        transaction,
        &call.created_by_account_id,
        call.conversation_id,
        SendMessageRequest {
            client_message_id: call_activity_client_message_id(call.id, event),
            kind: call_activity_message_kind(call.id, event),
            content: json!({
                "schema": 1,
                "blocks": [{
                    "type": "text",
                    "text": call_activity_text(call.kind, event, display_name)
                }]
            }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await?;
    Ok(())
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

pub async fn start(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: StartCallRequest,
) -> Result<StartedCall, CallStoreError> {
    if request.kind == CallKind::Meeting {
        return Err(CallStoreError::InvalidKind);
    }
    let mut transaction = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("call:{conversation_id}"))
        .execute(&mut *transaction)
        .await?;
    let conversation: Option<(String,)> = query_as(
        "SELECT conversation.kind FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.conversation_id = $1 AND member.account_id = $2 \
           AND member.membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let conversation_kind = conversation.ok_or(CallStoreError::Forbidden)?.0;
    let kind = match conversation_kind.as_str() {
        "direct" => request.kind,
        "group" => CallKind::Meeting,
        _ => return Err(CallStoreError::Forbidden),
    };
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active' ORDER BY account_id",
    )
    .bind(conversation_id)
    .fetch_all(&mut *transaction)
    .await?;
    if (conversation_kind == "direct" && members.len() != 2) || members.len() < 2 {
        return Err(CallStoreError::Conflict);
    }
    let existing: Option<CallRow> = query_as(
        "SELECT call_id, conversation_id, call_kind, call_state, created_by_account_id, \
                room_name, created_at, answered_at, ended_at \
         FROM cloud_calls WHERE conversation_id = $1 AND ended_at IS NULL",
    )
    .bind(conversation_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(existing) = existing {
        let (mut call, room_name) = snapshot_from_row(&mut transaction, existing).await?;
        if call.kind != CallKind::Meeting && call.created_by_account_id != account_id {
            return Err(CallStoreError::Conflict);
        }
        let participant_is_joined = call.participants.iter().any(|participant| {
            participant.account_id == account_id && participant.state == "joined"
        });
        if call.kind == CallKind::Meeting && !participant_is_joined {
            query(
                "UPDATE cloud_call_participants SET participant_state = 'joined', \
                        joined_at = COALESCE(joined_at, NOW()), left_at = NULL \
                 WHERE call_id = $1 AND account_id = $2",
            )
            .bind(call.id)
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
            call = load_call_in_transaction(&mut transaction, call.id).await?.0;
            publish_snapshot(&mut transaction, "call.updated", &call).await?;
        }
        let display_name = account_display_name(&mut transaction, account_id).await?;
        transaction.commit().await?;
        return Ok(StartedCall {
            call,
            room_name,
            display_name,
            inserted: false,
        });
    }
    let call_id = Uuid::now_v7();
    let room_name = format!("kordi-call-{}", call_id.simple());
    let state = if kind == CallKind::Meeting {
        CallState::Active
    } else {
        CallState::Ringing
    };
    query(
        "INSERT INTO cloud_calls \
         (call_id, conversation_id, created_by_account_id, client_operation_id, \
          call_kind, call_state, room_name) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(call_id)
    .bind(conversation_id)
    .bind(account_id)
    .bind(request.client_operation_id)
    .bind(kind.as_str())
    .bind(state.as_str())
    .bind(&room_name)
    .execute(&mut *transaction)
    .await?;
    for (member_id,) in members {
        let participant_state = if member_id == account_id {
            "joined"
        } else {
            "invited"
        };
        query(
            "INSERT INTO cloud_call_participants \
             (call_id, account_id, participant_state, joined_at) \
             VALUES ($1, $2, $3, CASE WHEN $3 = 'joined' THEN NOW() ELSE NULL END)",
        )
        .bind(call_id)
        .bind(member_id)
        .bind(participant_state)
        .execute(&mut *transaction)
        .await?;
    }
    let (call, _) = load_call_in_transaction(&mut transaction, call_id).await?;
    let display_name = account_display_name(&mut transaction, account_id).await?;
    publish_snapshot(&mut transaction, "call.created", &call).await?;
    append_call_activity(
        &mut transaction,
        &call,
        CallActivityEvent::Started,
        Some(&display_name),
    )
    .await?;
    transaction.commit().await?;
    Ok(StartedCall {
        call,
        room_name,
        display_name,
        inserted: true,
    })
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
    let display_name: Option<(Option<String>, String)> = query_as(
        "SELECT display_name, public_account_number FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(display_name
        .map(|value| {
            value
                .0
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(value.1)
        })
        .unwrap_or_else(|| "Kordi user".to_string()))
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
        append_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
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
        append_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
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
    append_call_activity(&mut transaction, &call, CallActivityEvent::Ended, None).await?;
    transaction.commit().await?;
    Ok(call)
}

#[cfg(test)]
mod tests {
    use super::{
        call_activity_client_message_id, call_activity_message_kind, call_activity_text,
        CallActivityEvent,
    };
    use crate::calls::models::CallKind;
    use uuid::Uuid;

    #[test]
    fn call_activity_messages_keep_event_and_call_identity() {
        let call_id = Uuid::parse_str("018f4e88-8a9d-7c65-a319-4f6c3dfdc100").unwrap();
        assert_eq!(
            call_activity_message_kind(call_id, CallActivityEvent::Started),
            format!("call.started.{call_id}")
        );
        assert_eq!(
            call_activity_message_kind(call_id, CallActivityEvent::Ended),
            format!("call.ended.{call_id}")
        );
    }

    #[test]
    fn ended_activity_id_is_deterministic_and_distinct_from_start() {
        let call_id = Uuid::parse_str("018f4e88-8a9d-7c65-a319-4f6c3dfdc100").unwrap();
        let first = call_activity_client_message_id(call_id, CallActivityEvent::Ended);
        let second = call_activity_client_message_id(call_id, CallActivityEvent::Ended);
        assert_eq!(first, second);
        assert_ne!(first, call_id);
    }

    #[test]
    fn activity_copy_distinguishes_voice_video_and_meetings() {
        assert_eq!(
            call_activity_text(CallKind::Voice, CallActivityEvent::Started, Some("Alex")),
            "Alex started a voice call."
        );
        assert_eq!(
            call_activity_text(CallKind::Video, CallActivityEvent::Ended, None),
            "The video call ended."
        );
        assert_eq!(
            call_activity_text(CallKind::Meeting, CallActivityEvent::Ended, None),
            "The video chat ended."
        );
    }
}
