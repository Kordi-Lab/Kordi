use super::{models::CalendarEvent, series_routes::ExpectedEvent, store, sync_routes::*};
use axum::{extract::State, Extension, Json};
use serde_json::{json, Value};
use sqlx_core::query::query;

fn event(id: &str) -> CalendarEvent {
    serde_json::from_value(json!({"id":id,"title":"Synthetic event","startAt":"2026-10-07T12:00:00Z","externalUid":format!("device:{id}")})).unwrap()
}

#[test]
fn sync_request_boundaries_are_independent_of_account_capacity() {
    for count in [500, 501] {
        let mut request = SyncRequest {
            upserts: (0..count).map(|i| event(&format!("event-{i}"))).collect(),
            deletes: vec![],
        };
        assert_eq!(validate_sync_request(&mut request).is_ok(), count == 500);
        let mut request = SyncRequest {
            upserts: vec![],
            deletes: (0..count)
                .map(|i| ExpectedEvent {
                    id: format!("event-{i}"),
                    revision: 1,
                })
                .collect(),
        };
        assert_eq!(validate_sync_request(&mut request).is_ok(), count == 500);
    }
}

pub(super) async fn postgres_contract(pool: &sqlx_postgres::PgPool, account: &str) {
    let state = std::sync::Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let session = crate::auth::routes::CloudSession {
        account_id: account.into(),
        token_id: "test".into(),
        device_id: "test".into(),
    };
    // This fixture owns the account and is called only by the isolated digest DB test.
    query("DELETE FROM cloud_calendar_events WHERE account_id=$1")
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
    for start in [0, 500, 1000] {
        let request = SyncRequest {
            upserts: (start..(start + 500).min(1001))
                .map(|i| event(&format!("large-{i}")))
                .collect(),
            deletes: vec![],
        };
        let response = sync(
            State(state.clone()),
            Extension(session.clone()),
            Json(request),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(body["skipped"].as_array().unwrap().is_empty());
    }
    let snapshot = store::calendar(pool, account).await.unwrap();
    assert_eq!(
        snapshot.len(),
        1001,
        "the sync snapshot must include events beyond the old limit"
    );
    assert!(snapshot.iter().any(|event| event.id == "large-1000"));

    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) SELECT $1,'fill-'||i,jsonb_set($2,'{id}',to_jsonb('fill-'||i)) FROM generate_series(1,$3) i")
        .bind(account).bind(serde_json::to_value(event("fill")).unwrap()).bind(CALENDAR_CAPACITY - 1001).execute(pool).await.unwrap();
    assert_eq!(
        store::calendar(pool, account).await.unwrap().len(),
        CALENDAR_CAPACITY as usize
    );
    // A successful deletion releases capacity for an insert in the very same batch.
    let response = sync(
        State(state.clone()),
        Extension(session.clone()),
        Json(SyncRequest {
            upserts: vec![event("replacement")],
            deletes: vec![ExpectedEvent {
                id: "large-0".into(),
                revision: 1,
            }],
        }),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["saved"][0]["id"], "replacement");
    assert_eq!(body["deleted"], json!(["large-0"]));
    assert_eq!(body["capacity"], 0);
    let response = sync(
        State(state),
        Extension(session),
        Json(SyncRequest {
            upserts: vec![event("overflow")],
            deletes: vec![ExpectedEvent {
                id: "replacement".into(),
                revision: 999,
            }],
        }),
    )
    .await;
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["skipped"], json!(["overflow"]));
    assert_eq!(body["deleteConflicts"], json!(["replacement"]));
    assert_eq!(body["capacity"], 0);
    // Other writers or legacy rows can exceed the bound. Fail closed, never truncate.
    query(
        "INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'overflow',$2)",
    )
    .bind(account)
    .bind(serde_json::to_value(event("overflow")).unwrap())
    .execute(pool)
    .await
    .unwrap();
    assert!(store::calendar(pool, account).await.is_err());
    query("DELETE FROM cloud_calendar_events WHERE account_id=$1")
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
}
