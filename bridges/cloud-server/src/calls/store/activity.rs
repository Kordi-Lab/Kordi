use serde_json::json;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::calls::models::{CallKind, CallSnapshot};
use crate::chat_sync::models::SendMessageRequest;
use crate::chat_sync::store;

use super::CallStoreError;

#[derive(Clone, Copy)]
pub(super) enum CallActivityEvent {
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

pub(super) async fn append_call_activity(
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
