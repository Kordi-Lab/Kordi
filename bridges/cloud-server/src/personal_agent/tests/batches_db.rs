//! Which new events one evaluation takes: old events only move the cursor,
//! a large backlog is taken oldest first in batches, and a setting change
//! during a sweep queues nothing.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::fixture::*;
use crate::personal_agent::sweep::{evaluate, reserve, Outcome};

/// (cursor received_at, cursor event id)
async fn cursor(f: &Fixture) -> (DateTime<Utc>, String) {
    query_as(
        "SELECT cursor_received_at, cursor_event_id FROM cloud_personal_agent_state \
         WHERE agent_id = $1",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

async fn received(f: &Fixture, event_id: &str) -> (DateTime<Utc>, String) {
    let (at,): (DateTime<Utc>,) =
        query_as("SELECT received_at FROM cloud_connector_events WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    (at, event_id.to_string())
}

/// The event ids the active evaluation shows, newest first.
async fn shown(f: &Fixture) -> Vec<String> {
    let run_id = f.state().await.1.expect("an active evaluation");
    let (prompt,): (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let snapshot: Value = serde_json::from_str(&prompt).unwrap();
    snapshot["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["eventId"].as_str().unwrap().to_string())
        .collect()
}

async fn runs(f: &Fixture) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs \
         WHERE execution_agent_id = $1 AND starts_with(run_id, 'personal_agent_eval_')",
    )
    .bind(&f.agent_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn old_events_only_move_the_cursor() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    let mail = |received: i64, occurred: i64| {
        let payload = json!({"from": "Archive", "subject": "Old"});
        event_at(
            &f.pool,
            &f.connector_id,
            "message.received",
            payload,
            received,
            occurred,
        )
    };
    // A new connector's first poll stores mail from long ago, and from
    // before the setting was turned on an hour ago.
    mail(130, 7 * 3_600).await;
    let before_on = mail(120, 2 * 3_600).await;
    let candidate = f.candidate(&quick()).await.expect("picked");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    assert_eq!(cursor(&f).await, received(&f, &before_on).await);
    assert_eq!((runs(&f).await, f.state().await.1), (0, None));
    assert!(f.candidate(&quick()).await.is_none(), "nothing new is left");

    // Next to a fresh event, an old one is passed but not shown.
    mail(100, 8 * 3_600).await;
    let fresh = f.mail("Sam", "Now", 90).await;
    let candidate = f.candidate(&quick()).await.expect("picked");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Queued
    );
    assert_eq!(shown(&f).await, vec![fresh.clone()]);
    let run_id = f.state().await.1.unwrap();
    f.finish(&run_id, "{\"decision\":\"skip\"}").await;
    assert_eq!(cursor(&f).await, received(&f, &fresh).await);
}

#[tokio::test]
async fn a_backlog_is_evaluated_oldest_first_in_batches() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    let mut ids = Vec::new();
    for i in 0..55 {
        ids.push(f.mail("Sam", &format!("Mail {i}"), 400 - i).await);
    }
    let candidate = f.candidate(&quick()).await.expect("picked");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Queued
    );
    let first: Vec<String> = ids[..50].iter().rev().cloned().collect();
    assert_eq!(shown(&f).await, first, "the oldest 50, newest first");
    let run_id = f.state().await.1.unwrap();
    f.finish(&run_id, "{\"decision\":\"skip\"}").await;
    assert_eq!(cursor(&f).await, received(&f, &ids[49]).await);
    let candidate = f.candidate(&quick()).await.expect("the rest are new");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Queued
    );
    let rest: Vec<String> = ids[50..].iter().rev().cloned().collect();
    assert_eq!(shown(&f).await, rest);
}

#[tokio::test]
async fn a_setting_change_during_a_sweep_queues_nothing() {
    let Some(f) = fixture().await else { return };
    f.watching().await;
    f.mail("Sam", "Dinner?", 120).await;
    let candidate = f.candidate(&quick()).await.expect("picked");
    // Off and on again restarts the cursor at now, after the sweep read it.
    f.set_proactive(&f.agent_id, false).await;
    f.set_proactive(&f.agent_id, true).await;
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    assert_eq!((runs(&f).await, f.state().await.1), (0, None));

    f.rewind().await;
    let candidate = f.candidate(&quick()).await.expect("picked");
    f.set_proactive(&f.agent_id, false).await;
    let mut tx = f.pool.begin().await.unwrap();
    let run_id = format!("personal_agent_eval_{}", uuid::Uuid::new_v4().simple());
    let reserved = reserve(&mut tx, &candidate, &run_id, &candidate.cursor)
        .await
        .unwrap();
    assert!(!reserved, "off");
    tx.rollback().await.unwrap();
}
