//! Nearby search: range and minimum score, ordering and matching.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::db_fixture::{pool, send};
use super::nearby_support::{
    answer_check, listed, located, need, north, setup, spot, store_match, NEARBY, PEOPLE,
};
use super::support::open_runs;
use crate::common_ground::nearby::distance::{band, haversine_m, round3};

fn search(range: i32, min_score: i64) -> String {
    format!("{PEOPLE}?range={range}&minScore={min_score}")
}

fn entry<'a>(body: &'a Value, account: &str) -> &'a Value {
    body["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["person"]["accountId"] == account)
        .unwrap()
}

#[tokio::test]
async fn range_and_minimum_score_filter_and_order() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    // Distances well inside their bands, after rounding to 3 decimals.
    let meters = [300.0, 800.0, 1_600.0, 4_000.0, 8_000.0, 20_000.0];
    let mut people = Vec::new();
    for (index, distance) in meters.iter().enumerate() {
        let at = north(here, *distance);
        let (id, _) = located(&app, &pool, &format!("P{index}"), at).await;
        let actual = haversine_m(here.0, here.1, round3(at.0), round3(at.1));
        people.push((id, band(actual).unwrap().1));
    }
    let bands: Vec<i32> = people.iter().map(|(_, band)| *band).collect();
    assert_eq!(bands, [500, 1_000, 2_000, 5_000, 10_000, 25_000]);
    // Stored matches for some; the rest are still matching.
    store_match(&pool, &me, &people[0].0, 60).await;
    store_match(&pool, &me, &people[1].0, 92).await;
    store_match(&pool, &me, &people[2].0, 85).await;
    store_match(&pool, &me, &people[3].0, 84).await;

    // Score first, then distance band; matching people last without a score.
    let (_, body) = send(&app, "GET", &search(25_000, 0), &token, None).await;
    let ids = |indexes: &[usize]| {
        indexes
            .iter()
            .map(|i| people[*i].0.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(listed(&body), ids(&[1, 2, 3, 0, 4, 5]));
    assert_eq!(body["matching"], 2);
    let ready = entry(&body, &people[1].0);
    assert_eq!(
        (ready["status"].clone(), ready["score"].clone()),
        (json!("ready"), json!(92))
    );
    assert_eq!(ready["headline"], "Score 92");
    assert_eq!(
        ready["distance"],
        json!({"minMeters": 500, "maxMeters": 1000})
    );
    let waiting = entry(&body, &people[5].0);
    assert_eq!(
        (waiting["status"].clone(), waiting["score"].clone()),
        (json!("matching"), json!(null))
    );
    assert_eq!(
        waiting["distance"],
        json!({"minMeters": 10000, "maxMeters": 25000})
    );
    // Each range keeps people up to its edge.
    for (range, expected) in [
        (500, 1),
        (1_000, 2),
        (2_000, 3),
        (5_000, 4),
        (10_000, 5),
        (25_000, 6),
    ] {
        let (status, body) = send(&app, "GET", &search(range, 0), &token, None).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(listed(&body).len(), expected, "range {range}: {body}");
    }

    // A minimum keeps scores at or above it and only counts the unmatched.
    let (_, body) = send(&app, "GET", &search(25_000, 85), &token, None).await;
    assert_eq!(listed(&body), ids(&[1, 2]), "85 itself is kept");
    assert_eq!(body["matching"], 2);
    let (_, body) = send(&app, "GET", &search(25_000, 50), &token, None).await;
    assert_eq!(listed(&body), ids(&[1, 2, 3, 0]));
    let (_, body) = send(&app, "GET", &search(1_000, 70), &token, None).await;
    assert_eq!(listed(&body), ids(&[1]));

    // Parameters never change the stored settings; stored ones apply.
    let (_, settings) = send(&app, "GET", NEARBY, &token, None).await;
    assert_eq!(
        (settings["range"].clone(), settings["minScore"].clone()),
        (json!(2000), json!(0))
    );
    send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"range": 1000, "minScore": 85})),
    )
    .await;
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(listed(&body), ids(&[1]));
    for bad in ["?range=750", "?minScore=99", "?range=far"] {
        let (status, body) = send(&app, "GET", &format!("{PEOPLE}{bad}"), &token, None).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (422, Some("common_ground_nearby_invalid_settings"))
        );
    }
    // Searching queued matching for the nearest unmatched people.
    let (batch,): (serde_json::Value,) = query_as(
        "SELECT cards_json FROM cloud_common_ground_match_runs WHERE viewer_account_id = $1 AND room_id IS NULL
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&me)
    .fetch_one(&pool)
    .await
    .unwrap();
    let read: Vec<&str> = batch
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(
        read,
        [me.as_str(), people[4].0.as_str(), people[5].0.as_str()]
    );
}

#[tokio::test]
async fn people_who_meet_a_request_come_first() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (high, _) = located(&app, &pool, "High", north(here, 300.0)).await;
    let (low, _) = located(&app, &pool, "Low", north(here, 1_500.0)).await;
    store_match(&pool, &me, &high, 95).await;
    store_match(&pool, &me, &low, 55).await;
    let need_id = need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee", "range": 2000}),
    )
    .await;
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(listed(&body), vec![high.clone(), low.clone()]);
    assert_eq!(open_runs(&pool, &me).await, 1, "one check for the request");
    // The check finds both meet it; only Low is answered as meeting here.
    let checked = answer_check(&pool, &me).await;
    assert_eq!(checked.len(), 2);
    sqlx_core::query::query("UPDATE cloud_common_ground_nearby_verdicts SET met = false, checks_json = jsonb_set(checks_json, '{checks,0,verdict}', '\"unknown\"') WHERE other_profile_id = (SELECT profile_id FROM cloud_common_ground_cards WHERE account_id = $1)")
        .bind(&high)
        .execute(&pool)
        .await
        .unwrap();
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(listed(&body), vec![low.clone(), high.clone()], "{body}");
    assert_eq!(
        entry(&body, &low)["requests"],
        json!([{"needId": need_id, "text": "Retrieval people up for coffee"}])
    );
    assert_eq!(entry(&body, &high)["requests"], json!([]));
    // A request out of range does not count.
    let path = format!("{}/{need_id}", super::nearby_support::NEEDS);
    send(&app, "PUT", &path, &token, Some(json!({"range": 1000}))).await;
    let (_, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(listed(&body), vec![high, low]);
}
