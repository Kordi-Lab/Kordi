use super::{models::*, recurrence, series_routes};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::json;
use sqlx_core::query::query;

fn event() -> CalendarEvent {
    serde_json::from_value(json!({"id":"reviewed-series","title":"Review","startAt":"2026-10-25T09:00:00-04:00","endAt":"2026-10-25T09:30:00-04:00","reminderAt":"2026-10-25T08:50:00-04:00","sourceIds":[],"description":"","timezone":"America/New_York","recurrence":{"frequency":"weekly","interval":1,"weekdays":[],"timezone":"America/New_York","count":3,"until":null}})).unwrap()
}

#[test]
fn dates_are_canonical_instants_but_all_day_dates_remain_calendar_dates() {
    let mut event = event();
    event.start_at = "2026-09-08T00:30:00+03:00".into();
    event.end_at = None;
    event.reminder_at = None;
    normalize_event_times(&mut event).unwrap();
    assert_eq!(event.start_at, "2026-09-07T21:30:00+00:00");
    event.all_day = true;
    event.start_at = "2026-09-08T00:00:00+14:00".into();
    normalize_event_times(&mut event).unwrap();
    assert_eq!(event.start_at, "2026-09-08T00:00:00Z");
}

#[test]
fn model_changes_require_the_exact_event_and_revision() {
    let mut input = super::tests::input();
    let mut event = event();
    event.revision = 4;
    input.calendar_events.push(event.clone());
    let item = Item {
        id: "reschedule".into(),
        title: "Review".into(),
        text: "Move the meeting.".into(),
        kind: "possible".into(),
        source_ids: vec!["m1".into()],
        calendar_action: Some("update".into()),
        existing_event_id: Some(event.id),
        existing_event_revision: Some(4),
        ..Item::default()
    };
    let mut output = Output {
        calendar_candidates: vec![item],
        ..Output::default()
    };
    assert!(validate_output(&output, &input).is_ok());
    output.calendar_candidates[0].existing_event_revision = Some(3);
    assert!(validate_output(&output, &input).is_err());
    input.calendar_events[0].series_id = Some("owned-series".into());
    output.calendar_candidates[0].calendar_action = Some("delete".into());
    output.calendar_candidates[0].calendar_scope = Some("series".into());
    output.calendar_candidates[0].existing_series_id = Some("owned-series".into());
    output.calendar_candidates[0].existing_event_id = None;
    output.calendar_candidates[0].existing_event_revision = None;
    assert!(validate_output(&output, &input).is_ok());
    output.calendar_candidates[0].existing_series_id = Some("foreign-series".into());
    assert!(validate_output(&output, &input).is_err());
    output.calendar_candidates[0].calendar_scope = None;
    output.calendar_candidates[0].existing_series_id = None;
    output.calendar_candidates[0].existing_event_revision = Some(4);
    output.calendar_candidates[0].existing_event_id = Some("another-account-event".into());
    assert!(validate_output(&output, &input).is_err());
}

pub(super) async fn postgres_calendar_contract(pool: &sqlx_postgres::PgPool, account: &str) {
    let base = event();
    let expanded = recurrence::expand(pool, base.clone()).await.unwrap();
    assert_eq!(
        expanded
            .iter()
            .map(|e| e.start_at.as_str())
            .collect::<Vec<_>>(),
        [
            "2026-10-25T13:00:00+00:00",
            "2026-11-01T14:00:00+00:00",
            "2026-11-08T14:00:00+00:00"
        ]
    );
    assert_eq!(
        expanded[1].reminder_at.as_deref(),
        Some("2026-11-01T13:50:00+00:00")
    );
    assert_eq!(
        expanded[1].end_at.as_deref(),
        Some("2026-11-01T14:30:00+00:00")
    );
    let mut gap = base.clone();
    gap.start_at = "2027-03-07T02:30:00-05:00".into();
    gap.end_at = None;
    gap.reminder_at = None;
    assert!(recurrence::expand(pool, gap)
        .await
        .unwrap_err()
        .contains("gap"));
    let mut all_day = base.clone();
    all_day.all_day = true;
    all_day.start_at = "2026-10-25T00:00:00+14:00".into();
    all_day.end_at = None;
    all_day.reminder_at = None;
    assert_eq!(
        recurrence::expand(pool, all_day).await.unwrap()[0].start_at,
        "2026-10-25T00:00:00+00:00"
    );
    let mut unknown = base.clone();
    unknown.recurrence.as_mut().unwrap().timezone = "Unknown/Timezone".into();
    unknown.timezone = None;
    assert!(recurrence::expand(pool, unknown).await.is_err());

    let state = std::sync::Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let session = crate::auth::routes::CloudSession {
        account_id: account.into(),
        token_id: "test".into(),
        device_id: "test".into(),
    };
    let response = series_routes::preview(
        State(state.clone()),
        Extension(session.clone()),
        Json(base.clone()),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(
        super::store::calendar(pool, account)
            .await
            .unwrap()
            .is_empty(),
        "Preview must never write events"
    );
    for _ in 0..2 {
        let response = series_routes::save(
            State(state.clone()),
            Extension(session.clone()),
            Path(base.id.clone()),
            Json(base.clone()),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            super::store::calendar(pool, account).await.unwrap().len(),
            3
        );
    }
    let mut legacy = super::store::calendar(pool, account).await.unwrap()[1].clone();
    legacy.title = "Changed occurrence".into();
    legacy.series_id = None;
    legacy.series_fingerprint = None;
    legacy.recurrence = None;
    assert_eq!(
        super::routes::save_event(
            State(state.clone()),
            Extension(session.clone()),
            Path(legacy.id.clone()),
            Json(legacy.clone())
        )
        .await
        .status(),
        axum::http::StatusCode::OK
    );
    let stale = super::routes::save_event(
        State(state.clone()),
        Extension(session.clone()),
        Path(legacy.id.clone()),
        Json(legacy.clone()),
    )
    .await;
    assert_eq!(stale.status(), axum::http::StatusCode::CONFLICT);
    query("DELETE FROM cloud_calendar_events WHERE account_id=$1 AND event_id=$2")
        .bind(account)
        .bind(&base.id)
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(
        series_routes::save(
            State(state.clone()),
            Extension(session.clone()),
            Path(base.id.clone()),
            Json(base.clone())
        )
        .await
        .status(),
        axum::http::StatusCode::OK
    );
    let remaining = super::store::calendar(pool, account).await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[0].title, "Changed occurrence");
    assert_eq!(remaining[0].series_id.as_deref(), Some(base.id.as_str()));
    let mut different = base.clone();
    different.title = "Different series".into();
    assert_eq!(
        series_routes::save(
            State(state.clone()),
            Extension(session.clone()),
            Path(different.id.clone()),
            Json(different)
        )
        .await
        .status(),
        axum::http::StatusCode::CONFLICT
    );
    let expected = || series_routes::Removal {
        events: remaining
            .iter()
            .map(|event| series_routes::ExpectedEvent {
                id: event.id.clone(),
                revision: event.revision,
            })
            .collect(),
    };
    let mut stale = expected();
    stale.events[0].revision += 1;
    assert_eq!(
        series_routes::remove(
            State(state.clone()),
            Extension(session.clone()),
            Path(base.id.clone()),
            Json(stale)
        )
        .await
        .status(),
        axum::http::StatusCode::CONFLICT
    );
    assert_eq!(
        super::store::calendar(pool, account).await.unwrap().len(),
        2
    );
    let mut incomplete = expected();
    incomplete.events.pop();
    assert_eq!(
        series_routes::remove(
            State(state.clone()),
            Extension(session.clone()),
            Path(base.id.clone()),
            Json(incomplete)
        )
        .await
        .status(),
        axum::http::StatusCode::CONFLICT
    );
    let mut other = session.clone();
    other.account_id = "another-account".into();
    assert_eq!(
        series_routes::remove(
            State(state.clone()),
            Extension(other),
            Path(base.id.clone()),
            Json(expected())
        )
        .await
        .status(),
        axum::http::StatusCode::CONFLICT
    );
    assert_eq!(
        super::store::calendar(pool, account).await.unwrap().len(),
        2
    );
    assert_eq!(
        series_routes::remove(
            State(state),
            Extension(session),
            Path(base.id),
            Json(expected())
        )
        .await
        .status(),
        axum::http::StatusCode::NO_CONTENT
    );
    assert!(super::store::calendar(pool, account)
        .await
        .unwrap()
        .is_empty());
}

pub(super) async fn postgres_reply_context(
    pool: &sqlx_postgres::PgPool,
    viewer: &str,
    author: &str,
    conversation: uuid::Uuid,
    original: uuid::Uuid,
) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let content = |value: serde_json::Value| json!({"blocks":[{"type":"text","text":format!("kordi-cloud-group:{}",URL_SAFE_NO_PAD.encode(value.to_string()))}]});
    let original_body = content(
        json!({"kind":"group-message","message":{"id":"original-ui-alias","text":"A weekly three-occurrence meeting","senderKind":"human"}}),
    );
    query("UPDATE cloud_chat_messages SET content=$2 WHERE message_id=$1")
        .bind(original)
        .bind(original_body)
        .execute(pool)
        .await
        .unwrap();
    let reply = uuid::Uuid::new_v4();
    let body = content(
        json!({"kind":"group-message","message":{"id":"reply-ui-alias","text":"That no longer works. Please cancel it.","senderKind":"human","messageAction":{"kind":"quote","source":{"sourceMessageId":"original-ui-alias","sourceSessionId":conversation.to_string(),"textPreview":"FORGED copied quote must not be trusted"}}}}),
    );
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,2,$3,$4,'test',$5)").bind(reply).bind(conversation).bind(author).bind(uuid::Uuid::new_v4()).bind(body).execute(pool).await.unwrap();
    let input = super::store::input(pool, viewer, "en", "UTC", None)
        .await
        .unwrap();
    let source = input
        .sources
        .iter()
        .find(|source| source.id == reply.to_string())
        .unwrap();
    assert_eq!(
        source.reply_to_source_id.as_deref(),
        Some(original.to_string().as_str())
    );
    assert_eq!(source.text, "That no longer works. Please cancel it.");
    assert!(!serde_json::to_string(&input).unwrap().contains("FORGED"));
    query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2)")
        .bind(viewer)
        .bind(original)
        .execute(pool)
        .await
        .unwrap();
    let input = super::store::input(pool, viewer, "en", "UTC", None)
        .await
        .unwrap();
    assert!(input
        .sources
        .iter()
        .find(|source| source.id == reply.to_string())
        .unwrap()
        .reply_to_source_id
        .is_none());
    assert!(!input
        .sources
        .iter()
        .any(|source| source.id == original.to_string()));
}

fn device_event(id: &str, uid: &str, title: &str) -> CalendarEvent {
    serde_json::from_value(json!({"id":id,"title":title,"startAt":"2026-10-25T09:00:00Z","endAt":"2026-10-25T09:30:00Z","sourceIds":[],"description":"","externalUid":uid,"revision":0})).unwrap()
}

#[test]
fn sync_requests_require_device_identity_and_unique_ids() {
    use super::sync_routes::{validate_sync_request, SyncRequest};
    let mut empty = SyncRequest::default();
    assert!(validate_sync_request(&mut empty).is_err());
    let mut valid = SyncRequest {
        upserts: vec![device_event("calendar-a", "device:a", "Standup")],
        deletes: vec![super::series_routes::ExpectedEvent {
            id: "calendar-b".into(),
            revision: 2,
        }],
    };
    assert!(validate_sync_request(&mut valid).is_ok());
    assert_eq!(valid.upserts[0].start_at, "2026-10-25T09:00:00+00:00");
    let mut missing_uid = SyncRequest {
        upserts: vec![device_event("calendar-a", "", "Standup")],
        deletes: vec![],
    };
    assert!(validate_sync_request(&mut missing_uid).is_err());
    let mut duplicate = SyncRequest {
        upserts: vec![device_event("calendar-a", "device:a", "Standup")],
        deletes: vec![super::series_routes::ExpectedEvent {
            id: "calendar-a".into(),
            revision: 1,
        }],
    };
    assert!(validate_sync_request(&mut duplicate).is_err());
    let mut series = SyncRequest {
        upserts: vec![event()],
        deletes: vec![],
    };
    series.upserts[0].external_uid = Some("device:series".into());
    assert!(validate_sync_request(&mut series).is_err());
    let mut unrevised_delete = SyncRequest {
        upserts: vec![],
        deletes: vec![super::series_routes::ExpectedEvent {
            id: "calendar-a".into(),
            revision: 0,
        }],
    };
    assert!(validate_sync_request(&mut unrevised_delete).is_err());
}

#[test]
fn updated_at_is_read_only() {
    let parsed: CalendarEvent = serde_json::from_value(json!({"id":"e","title":"T","startAt":"2026-10-25T09:00:00Z","updatedAt":"2020-01-01T00:00:00Z"})).unwrap();
    assert!(
        parsed.updated_at.is_none(),
        "clients never set the server write time"
    );
    assert!(!serde_json::to_string(&parsed)
        .unwrap()
        .contains("updatedAt"));
}

pub(super) async fn postgres_sync_contract(pool: &sqlx_postgres::PgPool, account: &str) {
    use super::sync_routes::{sync, SyncRequest};
    let state = std::sync::Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let session = crate::auth::routes::CloudSession {
        account_id: account.into(),
        token_id: "test".into(),
        device_id: "test".into(),
    };
    let first = SyncRequest {
        upserts: vec![
            device_event("calendar-sync-a", "device:sync-a", "Standup"),
            device_event("calendar-sync-b", "device:sync-b", "Review"),
        ],
        deletes: vec![],
    };
    let response = sync(
        State(state.clone()),
        Extension(session.clone()),
        Json(first),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["saved"].as_array().unwrap().len(), 2);
    assert_eq!(body["saved"][0]["revision"], json!(1));
    assert!(body["saved"][0]["updatedAt"].is_string());
    let events = super::store::calendar(pool, account).await.unwrap();
    let saved_a = events
        .iter()
        .find(|e| e.id == "calendar-sync-a")
        .unwrap()
        .clone();
    assert!(saved_a.updated_at.is_some());
    // A repeated revision-0 insert is a conflict, not a duplicate; a matching revision updates in place.
    let mut renamed = device_event("calendar-sync-a", "device:sync-a", "Standup (moved)");
    renamed.revision = saved_a.revision;
    let second = SyncRequest {
        upserts: vec![
            device_event("calendar-sync-b", "device:sync-b", "Review"),
            renamed,
        ],
        deletes: vec![super::series_routes::ExpectedEvent {
            id: "calendar-sync-missing".into(),
            revision: 99,
        }],
    };
    let response = sync(
        State(state.clone()),
        Extension(session.clone()),
        Json(second),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["conflicts"], json!(["calendar-sync-b"]));
    assert_eq!(body["deleteConflicts"], json!(["calendar-sync-missing"]));
    assert_eq!(body["saved"].as_array().unwrap().len(), 1);
    assert_eq!(body["saved"][0]["title"], json!("Standup (moved)"));
    assert_eq!(body["saved"][0]["revision"], json!(2));
    let events = super::store::calendar(pool, account).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.id.starts_with("calendar-sync-"))
            .count(),
        2
    );
    let b = events.iter().find(|e| e.id == "calendar-sync-b").unwrap();
    let third = SyncRequest {
        upserts: vec![],
        deletes: vec![
            super::series_routes::ExpectedEvent {
                id: "calendar-sync-b".into(),
                revision: b.revision,
            },
            super::series_routes::ExpectedEvent {
                id: "calendar-sync-a".into(),
                revision: 2,
            },
        ],
    };
    let response = sync(State(state), Extension(session), Json(third)).await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let events = super::store::calendar(pool, account).await.unwrap();
    assert!(!events.iter().any(|e| e.id.starts_with("calendar-sync-")));
}
