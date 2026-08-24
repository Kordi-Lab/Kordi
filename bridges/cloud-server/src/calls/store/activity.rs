use chrono::{DateTime, Duration, Utc};
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

fn call_activity_client_message_id(call_id: Uuid) -> Uuid {
    call_id
}

fn call_activity_text(
    call: &CallSnapshot,
    event: CallActivityEvent,
    display_name: Option<&str>,
) -> String {
    let noun = match call.kind {
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
        CallActivityEvent::Ended => {
            format!(
                "The {noun} ended. Duration {}.",
                format_call_duration(call_duration(call))
            )
        }
    }
}

fn call_activity_started_at(call: &CallSnapshot) -> Option<DateTime<Utc>> {
    match call.kind {
        CallKind::Meeting => Some(call.created_at),
        CallKind::Voice | CallKind::Video => call.answered_at,
    }
}

fn call_duration(call: &CallSnapshot) -> Duration {
    match (call_activity_started_at(call), call.ended_at) {
        (Some(started_at), Some(ended_at)) => ended_at
            .signed_duration_since(started_at)
            .max(Duration::zero()),
        _ => Duration::zero(),
    }
}

fn format_call_duration(duration: Duration) -> String {
    let total_seconds = duration.num_seconds().max(0);
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn call_activity_duration_seconds(call: &CallSnapshot) -> Option<i64> {
    let started_at = call_activity_started_at(call)?;
    let ended_at = call.ended_at?;
    Some((ended_at - started_at).num_seconds().max(0))
}

fn call_activity_content(
    call: &CallSnapshot,
    event: CallActivityEvent,
    display_name: Option<&str>,
) -> serde_json::Value {
    json!({
        "schema": 1,
        "blocks": [{
            "type": "text",
            "text": call_activity_text(call, event, display_name)
        }],
        "call": {
            "id": call.id,
            "status": event.as_str(),
            "duration_seconds": match event {
                CallActivityEvent::Started => None,
                CallActivityEvent::Ended => Some(call_duration(call).num_seconds().max(0)),
            }
        },
        "callActivity": {
            "schema": 1,
            "callId": call.id,
            "kind": call.kind.as_str(),
            "event": event.as_str(),
            "createdAtMs": call.created_at.timestamp_millis(),
            "answeredAtMs": call_activity_started_at(call)
                .map(|value| value.timestamp_millis()),
            "endedAtMs": call.ended_at.map(|value| value.timestamp_millis()),
            "durationSeconds": match event {
                CallActivityEvent::Started => None,
                CallActivityEvent::Ended => call_activity_duration_seconds(call),
            }
        }
    })
}

pub(super) async fn record_call_activity(
    transaction: &mut Transaction<'_, Postgres>,
    call: &CallSnapshot,
    event: CallActivityEvent,
    display_name: Option<&str>,
) -> Result<(), CallStoreError> {
    let message_kind = call_activity_message_kind(call.id, event);
    let content = call_activity_content(call, event, display_name);
    if matches!(event, CallActivityEvent::Ended)
        && store::replace_server_message_in_transaction(
            transaction,
            &call.created_by_account_id,
            call_activity_client_message_id(call.id),
            &message_kind,
            content.clone(),
        )
        .await?
        .is_some()
    {
        return Ok(());
    }
    store::send_message_in_transaction(
        transaction,
        &call.created_by_account_id,
        call.conversation_id,
        SendMessageRequest {
            client_message_id: call_activity_client_message_id(call.id),
            kind: message_kind,
            content,
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
        call_activity_client_message_id, call_activity_content, call_activity_duration_seconds,
        call_activity_message_kind, call_activity_started_at, call_activity_text, call_duration,
        format_call_duration, CallActivityEvent,
    };
    use crate::calls::models::{CallKind, CallSnapshot, CallState};
    use chrono::{TimeZone, Utc};
    use uuid::Uuid;

    fn call(kind: CallKind) -> CallSnapshot {
        CallSnapshot {
            id: Uuid::parse_str("018f4e88-8a9d-7c65-a319-4f6c3dfdc100").unwrap(),
            revision: 1,
            conversation_id: Uuid::nil(),
            kind,
            state: CallState::Ended,
            created_by_account_id: "account".to_string(),
            created_at: Utc.timestamp_opt(1_000, 0).unwrap(),
            answered_at: Some(Utc.timestamp_opt(1_005, 0).unwrap()),
            ended_at: Some(Utc.timestamp_opt(1_082, 0).unwrap()),
            participants: Vec::new(),
        }
    }

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
    fn call_activity_reuses_one_timeline_identity_for_every_status() {
        let call_id = Uuid::parse_str("018f4e88-8a9d-7c65-a319-4f6c3dfdc100").unwrap();
        assert_eq!(call_activity_client_message_id(call_id), call_id);
    }

    #[test]
    fn activity_copy_distinguishes_voice_video_and_meetings() {
        assert_eq!(
            call_activity_text(
                &call(CallKind::Voice),
                CallActivityEvent::Started,
                Some("Alex")
            ),
            "Alex started a voice call."
        );
        assert_eq!(
            call_activity_text(&call(CallKind::Video), CallActivityEvent::Ended, None),
            "The video call ended. Duration 01:17."
        );
        assert_eq!(
            call_activity_text(&call(CallKind::Meeting), CallActivityEvent::Ended, None),
            "The video chat ended. Duration 01:22."
        );
    }

    #[test]
    fn call_duration_uses_answered_time_and_supports_long_calls() {
        let mut snapshot = call(CallKind::Voice);
        snapshot.ended_at = Some(Utc.timestamp_opt(4_732, 0).unwrap());
        assert_eq!(call_duration(&snapshot).num_seconds(), 3_727);
        assert_eq!(format_call_duration(call_duration(&snapshot)), "01:02:07");
    }

    #[test]
    fn structured_activity_duration_is_absent_until_answered() {
        let call = call(CallKind::Voice);
        assert_eq!(call_activity_duration_seconds(&call), Some(77));
        assert_eq!(
            call_activity_duration_seconds(&CallSnapshot {
                answered_at: None,
                ..call
            }),
            None
        );
    }

    #[test]
    fn meeting_activity_uses_creation_time_as_its_lifecycle_start() {
        let mut meeting = call(CallKind::Meeting);
        meeting.answered_at = None;

        assert_eq!(call_activity_started_at(&meeting), Some(meeting.created_at));
        assert_eq!(call_activity_duration_seconds(&meeting), Some(82));
        assert_eq!(call_duration(&meeting).num_seconds(), 82);
    }

    #[test]
    fn activity_content_keeps_main_identity_and_desktop_metadata_in_one_record() {
        let snapshot = call(CallKind::Video);
        let content = call_activity_content(&snapshot, CallActivityEvent::Ended, None);

        assert_eq!(content["call"]["id"], snapshot.id.to_string());
        assert_eq!(content["call"]["status"], "ended");
        assert_eq!(content["callActivity"]["callId"], snapshot.id.to_string());
        assert_eq!(content["callActivity"]["kind"], "video");
        assert_eq!(content["callActivity"]["event"], "ended");
        assert_eq!(content["callActivity"]["durationSeconds"], 77);
    }
}
