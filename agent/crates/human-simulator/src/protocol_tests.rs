use super::*;
use serde_json::json;

const CONVERSATION_ID: Uuid = Uuid::from_u128(1);
const OTHER_CONVERSATION_ID: Uuid = Uuid::from_u128(2);
const ACTOR_ACCOUNT_ID: &str = "account-actor";
const OTHER_ACCOUNT_ID: &str = "account-other";

#[test]
fn terminal_pending_delivery_is_indeterminate_and_legacy_state_loads() {
    let mut state = ActorState::default();
    assert_eq!(state.delivery_status(), "none");
    let mut legacy = serde_json::to_value(&state).unwrap();
    legacy.as_object_mut().unwrap().remove("last_delivery");
    assert_eq!(serde_json::from_value::<ActorState>(legacy).unwrap(), state);
    state.pending = Some(PendingSend {
        client_message_id: Uuid::from_u128(3),
        text: "Synthetic pending message".into(),
    });
    assert_eq!(state.delivery_status(), "pending");
    state.status = "stopped".into();
    assert_eq!(state.delivery_status(), "indeterminate");
    state.last_delivery = Some(DeliveryReceipt {
        client_message_id: Uuid::from_u128(4),
        message_id: Uuid::from_u128(5),
    });
    // An older successful receipt must not hide a later unconfirmed send.
    assert_eq!(state.delivery_status(), "indeterminate");
    state.pending = None;
    assert_eq!(state.delivery_status(), "confirmed");
}

fn config() -> ActorConfig {
    ActorConfig {
        actor_id: "actor_test".into(),
        account_id: ACTOR_ACCOUNT_ID.into(),
        conversation_id: CONVERSATION_ID,
        objective: "Reach the objective".into(),
        persona: "Friendly".into(),
        private_facts: Vec::new(),
        skill: "human-requester@1".into(),
        max_model_calls: 10,
        max_messages: 20,
        poll_seconds: 5,
        max_wait_seconds: 60,
    }
}

/// The canonical v2 event envelope emitted by chat_sync::store::message::fanout.
#[allow(clippy::too_many_arguments)]
fn v2_message_event(
    conversation_id: Uuid,
    event_type: &str,
    message_id: Uuid,
    sender_account_id: &str,
    sequence: i64,
    text: &str,
    generation_status: Option<&str>,
    deleted_at: Option<&str>,
) -> Value {
    json!({
        "stream_seq": sequence,
        "event_id": Uuid::from_u128(sequence as u128 + 100),
        "protocol_version": 2,
        "type": event_type,
        "critical": false,
        "conversation_id": conversation_id,
        "entity_id": message_id,
        "entity_version": 1,
        "occurred_at": "2026-11-01T12:00:00Z",
        "payload": {
            "message": {
                "id": message_id,
                "client_message_id": Uuid::from_u128(sequence as u128 + 200),
                "conversation_id": conversation_id,
                "conversation_sequence": sequence,
                "sender_account_id": sender_account_id,
                "kind": "text",
                "content": {"schema": 1, "blocks": [{"type":"text", "text":text}]},
                "reply_to_message_id": null,
                "attachment_ids": [],
                "version": 1,
                "generation_status": generation_status,
                "provider_response_id": null,
                "created_at": "2026-11-01T12:00:00Z",
                "edited_at": null,
                "deleted_at": deleted_at,
                "reactions": []
            },
            "conversation": {"id": conversation_id}
        }
    })
}

#[test]
fn consumes_v2_message_payload_and_ignores_other_conversations_and_own_messages() {
    let config = config();
    let own_id = Uuid::from_u128(10);
    let other_id = Uuid::from_u128(11);
    let mut state = ActorState {
        needs_decision: false,
        ..ActorState::default()
    };
    state.apply_events(
        &config,
        &[
            v2_message_event(
                OTHER_CONVERSATION_ID,
                "message.created",
                other_id,
                OTHER_ACCOUNT_ID,
                1,
                "Do not include this other conversation.",
                None,
                None,
            ),
            v2_message_event(
                CONVERSATION_ID,
                "message.created",
                own_id,
                ACTOR_ACCOUNT_ID,
                2,
                "My own message.",
                None,
                None,
            ),
        ],
        "cursor-after-own-message".into(),
    );

    assert_eq!(state.history.len(), 1);
    assert_eq!(state.history[0].id, own_id);
    assert_eq!(state.history[0].text, "My own message.");
    assert!(
        !state.needs_decision,
        "an actor's own send must not trigger another decision"
    );
    assert_eq!(state.cursor.as_deref(), Some("cursor-after-own-message"));
    assert!(state.initialized);
}

#[test]
fn ignores_streaming_message_updates_until_content_is_committed() {
    let config = config();
    let id = Uuid::from_u128(20);
    let mut state = ActorState {
        needs_decision: false,
        ..ActorState::default()
    };
    state.apply_events(
        &config,
        &[v2_message_event(
            CONVERSATION_ID,
            "message.created",
            id,
            OTHER_ACCOUNT_ID,
            1,
            "Partial generated text.",
            Some("streaming"),
            None,
        )],
        "streaming-cursor".into(),
    );

    assert!(state.history.is_empty());
    assert!(!state.needs_decision);
}

#[test]
fn applies_edits_and_actual_v2_delete_payloads() {
    let config = config();
    let id = Uuid::from_u128(30);
    let mut state = ActorState {
        needs_decision: false,
        ..ActorState::default()
    };
    state.apply_events(
        &config,
        &[v2_message_event(
            CONVERSATION_ID,
            "message.created",
            id,
            OTHER_ACCOUNT_ID,
            1,
            "Original wording.",
            None,
            None,
        )],
        "created".into(),
    );
    assert!(state.needs_decision);

    state.needs_decision = false;
    state.apply_events(
        &config,
        &[v2_message_event(
            CONVERSATION_ID,
            "message.updated",
            id,
            OTHER_ACCOUNT_ID,
            1,
            "Edited wording.",
            None,
            None,
        )],
        "edited".into(),
    );
    assert_eq!(state.history.len(), 1);
    assert_eq!(state.history[0].text, "Edited wording.");
    assert!(state.needs_decision);

    state.needs_decision = false;
    state.apply_events(
        &config,
        &[v2_message_event(
            CONVERSATION_ID,
            "message.deleted",
            id,
            OTHER_ACCOUNT_ID,
            1,
            "",
            None,
            Some("2026-11-01T12:05:00Z"),
        )],
        "deleted".into(),
    );
    assert!(
        state.history.is_empty(),
        "v2 deletion carries message.id inside payload.message"
    );
    assert!(
        state.needs_decision,
        "deleting another participant's message changes observed context"
    );
}

#[test]
fn bounds_history_and_observation_fields() {
    let config = config();
    let events = (1..=45)
        .map(|sequence| {
            v2_message_event(
                CONVERSATION_ID,
                "message.created",
                Uuid::from_u128(sequence as u128 + 1000),
                OTHER_ACCOUNT_ID,
                sequence,
                &"x".repeat(8_100),
                None,
                None,
            )
        })
        .collect::<Vec<_>>();
    let mut state = ActorState::default();
    state.apply_events(&config, &events, "bounded".into());

    assert_eq!(state.history.len(), 40);
    assert_eq!(state.history.first().unwrap().sequence, 6);
    assert_eq!(state.history.last().unwrap().sequence, 45);
    assert!(
        state
            .history
            .iter()
            .all(|observation| observation.text.chars().count() == 8_000)
    );
    state.validate().expect("bounded history validates");
}
