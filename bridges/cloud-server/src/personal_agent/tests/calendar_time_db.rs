//! Calendar presentation in an evaluation snapshot, using synthetic data.

use chrono::Utc;
use serde_json::json;
use sqlx_core::query::query;

use super::fixture::*;
use crate::personal_agent::snapshot::{self, Event};

#[tokio::test]
async fn calendar_snapshot_uses_the_latest_owner_zone_without_changing_source_instants() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    let (conversation, _) = f.personal_session(&f.agent_id).await;
    let agent = snapshot::load_agent(&f.pool, &f.agent_id)
        .await
        .unwrap()
        .unwrap();
    let events = [Event {
        event_id: "synthetic-calendar-event".into(),
        provider: "google_calendar".into(),
        kind: "event.changed".into(),
        occurred_at: Utc::now(),
        received_at: Utc::now(),
        payload: json!({"summary": "Synthetic meeting moved", "start": "2026-11-01T22:30:00+03:00", "end": "2026-11-01T23:00:00+03:00"}),
        stale: false,
    }];
    let missing = snapshot::build(&f.pool, &agent, conversation, &events)
        .await
        .unwrap();
    assert!(missing["owner"]["timeZone"].is_null());
    assert!(missing["events"][0]["ownerLocalTime"].is_null());
    query("INSERT INTO cloud_account_digests (account_id, timezone) VALUES ($1, 'UTC')")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    let fallback = snapshot::build(&f.pool, &agent, conversation, &events)
        .await
        .unwrap();
    assert_eq!(fallback["owner"]["timeZone"], "UTC");
    query("UPDATE cloud_accounts SET time_zone = 'America/Los_Angeles' WHERE account_id = $1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    let local = snapshot::build(&f.pool, &agent, conversation, &events)
        .await
        .unwrap();
    assert_eq!(local["owner"]["timeZone"], "America/Los_Angeles");
    assert_eq!(
        local["events"][0]["ownerLocalTime"]["start"]["label"],
        "2026-11-01 11:30 PST"
    );
    assert_eq!(local["events"][0]["summary"], events[0].payload);
    query("UPDATE cloud_accounts SET time_zone = 'America/New_York' WHERE account_id = $1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    let changed = snapshot::build(&f.pool, &agent, conversation, &events)
        .await
        .unwrap();
    assert_eq!(
        changed["events"][0]["ownerLocalTime"]["start"]["label"],
        "2026-11-01 14:30 EST"
    );
    query("UPDATE cloud_accounts SET time_zone = 'Invalid/Zone' WHERE account_id = $1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    let invalid = snapshot::build(&f.pool, &agent, conversation, &events)
        .await
        .unwrap();
    assert!(invalid["owner"]["timeZone"].is_null());
    assert!(invalid["events"][0]["ownerLocalTime"].is_null());
}
