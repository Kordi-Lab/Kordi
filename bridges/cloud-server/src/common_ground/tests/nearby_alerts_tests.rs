//! Nearby alerts: queueing, deduplication, frequency caps and the checks
//! made again just before delivery.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{pool, send};
use super::nearby_support::{
    alert_hints, alerts_to, answer_check, backdate, locate, located, mark_dirty, need, north,
    pending, setup, spot, status_of, store_match, sweep, NEARBY, NEEDS, PEOPLE,
};

#[tokio::test]
async fn a_met_request_alerts_once() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, service) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (maya, _) = located(&app, &pool, "Maya", north(here, 200.0)).await;
    need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee"}),
    )
    .await;
    // The sweep queues the check; its completion marks the viewer again.
    sweep(&pool, &service).await;
    assert!(alerts_to(&pool, &me).await.is_empty());
    assert_eq!(answer_check(&pool, &me).await, vec![maya.clone()]);
    sweep(&pool, &service).await;
    let alerts = alerts_to(&pool, &me).await;
    assert_eq!(
        alerts,
        vec![("need".into(), "delivered".into(), None, maya.clone())]
    );
    assert_eq!(
        alert_hints(&pool, &me).await,
        1,
        "delivered in the app without a push service"
    );
    for _ in 0..3 {
        mark_dirty(&pool, &me).await;
        mark_dirty(&pool, &maya).await;
        sweep(&pool, &service).await;
    }
    assert_eq!(
        alerts_to(&pool, &me).await.len(),
        1,
        "one alert per request revision"
    );
    assert!(alerts_to(&pool, &maya).await.is_empty());
}

#[tokio::test]
async fn daily_cap_and_quiet_gap_suppress_alerts() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, service) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"alerts": {"maxPerDay": 1}})),
    )
    .await;
    let (first, _) = located(&app, &pool, "First", north(here, 100.0)).await;
    let (second, _) = located(&app, &pool, "Second", north(here, 300.0)).await;
    store_match(&pool, &me, &first, 90).await;
    store_match(&pool, &me, &second, 95).await;
    sweep(&pool, &service).await;
    let mut statuses: Vec<String> = alerts_to(&pool, &me)
        .await
        .into_iter()
        .map(|a| a.1)
        .collect();
    statuses.sort();
    assert_eq!(statuses, ["delivered", "suppressed"]);
    // The cap allows more now, but not within 10 minutes of the last one.
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"alerts": {"maxPerDay": 3}})),
    )
    .await;
    let (third, _) = located(&app, &pool, "Third", north(here, 400.0)).await;
    store_match(&pool, &me, &third, 90).await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    let third_alert = alerts_to(&pool, &me)
        .await
        .into_iter()
        .find(|a| a.3 == third)
        .unwrap();
    assert_eq!(
        (third_alert.1.as_str(), third_alert.2.as_deref()),
        ("suppressed", Some("limit"))
    );
    for other in [&first, &second, &third] {
        backdate(&pool, &me, other, "11 minutes").await;
    }
    let (fourth, _) = located(&app, &pool, "Fourth", north(here, 450.0)).await;
    store_match(&pool, &me, &fourth, 90).await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    let alerts = alerts_to(&pool, &me).await;
    assert_eq!(
        alerts.len(),
        4,
        "suppressed alerts are not queued again: {alerts:?}"
    );
    let fourth_alert = alerts.iter().find(|a| a.3 == fourth).unwrap();
    assert_eq!(fourth_alert.1, "delivered");
}

#[tokio::test]
async fn delivery_checks_everything_again() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, service) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (maya, maya_token) = located(&app, &pool, "Maya", north(here, 200.0)).await;
    let need_id = need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee"}),
    )
    .await;
    send(&app, "GET", PEOPLE, &token, None).await;
    answer_check(&pool, &me).await;
    let at = |revision| Some((need_id.as_str(), revision));

    // Turning off invalidates the viewer's pending alerts at once.
    let alert = pending(&pool, &me, &maya, at(1)).await;
    send(&app, "PUT", NEARBY, &token, Some(json!({"enabled": false}))).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("off".into()))
    );
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"enabled": true, "consent": true})),
    )
    .await;
    locate(&app, &token, here).await;

    // So does pausing, for alerts about the person who paused.
    let alert = pending(&pool, &me, &maya, at(1)).await;
    let until = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    send(
        &app,
        "PUT",
        NEARBY,
        &maya_token,
        Some(json!({"pausedUntil": until})),
    )
    .await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("paused".into()))
    );
    send(
        &app,
        "PUT",
        NEARBY,
        &maya_token,
        Some(json!({"pausedUntil": null})),
    )
    .await;

    // A location that went stale before delivery.
    locate(&app, &maya_token, north(here, 200.0)).await;
    query("UPDATE cloud_common_ground_nearby_locations SET fresh_until = now() - interval '1 second' WHERE account_id = $1")
        .bind(&maya)
        .execute(&pool)
        .await
        .unwrap();
    let alert = pending(&pool, &me, &maya, at(1)).await;
    sweep(&pool, &service).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("not_visible".into()))
    );
    locate(&app, &maya_token, north(here, 200.0)).await;

    // An alert pending for more than 15 minutes is never sent.
    let alert = pending(&pool, &me, &maya, at(1)).await;
    query("UPDATE cloud_common_ground_nearby_alerts SET created_at = now() - interval '16 minutes' WHERE alert_id = $1")
        .bind(&alert)
        .execute(&pool)
        .await
        .unwrap();
    sweep(&pool, &service).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("expired".into()))
    );
    // The sweep then queued and delivered the real one.
    let delivered: Vec<_> = alerts_to(&pool, &me)
        .await
        .into_iter()
        .filter(|a| a.1 == "delivered")
        .collect();
    assert_eq!(delivered.len(), 1);

    // Editing or pausing the request invalidates its pending alerts.
    query("DELETE FROM cloud_common_ground_nearby_alerts WHERE recipient_account_id = $1")
        .bind(&me)
        .execute(&pool)
        .await
        .unwrap();
    let path = format!("{NEEDS}/{need_id}");
    let alert = pending(&pool, &me, &maya, at(1)).await;
    send(&app, "PUT", &path, &token, Some(json!({"paused": true}))).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("need_paused".into()))
    );
    send(&app, "PUT", &path, &token, Some(json!({"paused": false}))).await;
    let alert = pending(&pool, &me, &maya, at(1)).await;
    send(
        &app,
        "PUT",
        &path,
        &token,
        Some(json!({"text": "Founders up for coffee"})),
    )
    .await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("need_changed".into()))
    );

    // A request that ended before delivery, and an old revision.
    let alert = pending(&pool, &me, &maya, at(1)).await;
    sweep(&pool, &service).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("need_changed".into()))
    );
    answer_check(&pool, &me).await;
    let alert = pending(&pool, &me, &maya, at(2)).await;
    query("UPDATE cloud_common_ground_nearby_needs SET ends_at = now() - interval '1 second' WHERE need_id = $1")
        .bind(&need_id)
        .execute(&pool)
        .await
        .unwrap();
    sweep(&pool, &service).await;
    assert_eq!(
        status_of(&pool, &alert).await,
        ("invalidated".into(), Some("need_changed".into()))
    );
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    assert!(
        alerts_to(&pool, &me)
            .await
            .iter()
            .all(|a| a.1 == "invalidated"),
        "an ended request produces no alerts"
    );
}

#[tokio::test]
async fn match_alerts_follow_the_score_and_the_weekly_window() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, service) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (low, _) = located(&app, &pool, "Low", north(here, 100.0)).await;
    let (high, _) = located(&app, &pool, "High", north(here, 200.0)).await;
    store_match(&pool, &me, &low, 80).await;
    store_match(&pool, &me, &high, 90).await;
    sweep(&pool, &service).await;
    let alerts = alerts_to(&pool, &me).await;
    assert_eq!(
        alerts,
        vec![("match".into(), "delivered".into(), None, high.clone())]
    );
    let (score,): (Option<i32>,) = query_as(
        "SELECT score FROM cloud_common_ground_nearby_alerts WHERE recipient_account_id = $1",
    )
    .bind(&me)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(score, Some(90));

    // A lower alert score lets Low through.
    backdate(&pool, &me, &high, "11 minutes").await;
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"alerts": {"matchMinScore": 70}})),
    )
    .await;
    sweep(&pool, &service).await;
    assert_eq!(alerts_to(&pool, &me).await.len(), 2);
    // Within a week, the same pair does not alert again.
    backdate(&pool, &me, &low, "11 minutes").await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    assert_eq!(alerts_to(&pool, &me).await.len(), 2);
    backdate(&pool, &me, &high, "8 days").await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    let alerts = alerts_to(&pool, &me).await;
    assert_eq!(alerts.len(), 3);
    assert_eq!(
        alerts
            .iter()
            .filter(|a| a.3 == high && a.1 == "delivered")
            .count(),
        2
    );

    // A person who met a request today gives no match alert as well.
    let (both, _) = located(&app, &pool, "Both", north(here, 300.0)).await;
    need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee", "range": 500}),
    )
    .await;
    sweep(&pool, &service).await;
    assert!(answer_check(&pool, &me).await.contains(&both));
    sweep(&pool, &service).await;
    store_match(&pool, &me, &both, 95).await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    let about: Vec<_> = alerts_to(&pool, &me)
        .await
        .into_iter()
        .filter(|a| a.3 == both)
        .collect();
    assert_eq!(about.len(), 1, "{about:?}");
    assert_eq!(about[0].0, "need");

    // Match alerts off: none queued.
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"alerts": {"matches": false}})),
    )
    .await;
    let (late, _) = located(&app, &pool, "Late", north(here, 350.0)).await;
    store_match(&pool, &me, &late, 99).await;
    mark_dirty(&pool, &me).await;
    sweep(&pool, &service).await;
    assert!(alerts_to(&pool, &me).await.iter().all(|a| a.3 != late));
}
