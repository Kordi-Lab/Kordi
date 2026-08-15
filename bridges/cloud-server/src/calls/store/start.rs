use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::calls::models::{CallKind, CallState, StartCallRequest};

use super::activity::{record_call_activity, CallActivityEvent};
use super::{
    account_display_name, load_call_in_transaction, publish_snapshot, snapshot_from_row, CallRow,
    CallStoreError, StartedCall,
};

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
    record_call_activity(
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
