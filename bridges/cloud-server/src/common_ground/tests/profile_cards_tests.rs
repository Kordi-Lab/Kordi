//! Several Grounding cards per memory (#2035): the profile memories route,
//! card builds and `memoriesSinceBuild` follow each memory's cards.

use serde_json::json;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_memories_tests::{assert_texts, build, listed, own, pairs, save, since_build};
use super::profile_support::create_profile;

const WORK: &str = "Leads the Atlas data pipeline";
const MOVED: &str = "Reviews papers for the KAUST lab";
const COORDINATION: &str = "Free on Tuesday mornings";
const HEALTH: &str = "Trains for a marathon on weekends";

async fn edit(app: &axum::Router, token: &str, memory: &str, body: serde_json::Value) {
    let path = format!("/v1/cloud/memory/{memory}");
    let (status, reply) = send(app, "PATCH", &path, token, Some(body)).await;
    assert_eq!(status, 200, "{reply}");
}

#[tokio::test]
async fn memories_follow_their_cards() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &token, "work", None).await;
    let health = create_profile(&app, &token, "health", None).await;
    let daily = create_profile(&app, &token, "daily", None).await;
    let custom = create_profile(&app, &token, "custom", Some("KAUST")).await;

    save(&app, &token, own(WORK, "work_context")).await;
    save(&app, &token, own(HEALTH, "health_context")).await;
    let moved = save(&app, &token, own(MOVED, "work_context")).await;
    let coordination = save(&app, &token, own(COORDINATION, "coordination_context")).await;

    // A work memory also added to Health and the custom card, then taken off
    // Work: it feeds exactly the cards it is on.
    edit(&app, &token, &moved, json!({ "addProfileId": health })).await;
    edit(&app, &token, &moved, json!({ "addProfileId": custom })).await;
    edit(&app, &token, &moved, json!({ "removeProfileId": work })).await;
    // A coordination memory taken off Daily tasks only.
    edit(
        &app,
        &token,
        &coordination,
        json!({ "removeProfileId": daily }),
    )
    .await;

    assert_eq!(
        listed(&app, &token, &work).await,
        pairs(&[(WORK, false), (COORDINATION, true)])
    );
    assert_eq!(
        listed(&app, &token, &health).await,
        pairs(&[(HEALTH, false), (MOVED, false), (COORDINATION, true)])
    );
    assert_eq!(listed(&app, &token, &daily).await, pairs(&[]));
    assert_eq!(
        listed(&app, &token, &custom).await,
        pairs(&[(MOVED, false)])
    );

    let evidence = build(&app, &pool, (&alex, &token), &work).await;
    assert_texts(&evidence, &[WORK, COORDINATION], &[MOVED, HEALTH]);
    let evidence = build(&app, &pool, (&alex, &token), &health).await;
    assert_texts(&evidence, &[HEALTH, MOVED, COORDINATION], &[WORK]);
    // A custom build reads its own cards plus every memory not added to any
    // card and not removed from it.
    let evidence = build(&app, &pool, (&alex, &token), &custom).await;
    assert_texts(&evidence, &[MOVED, WORK, HEALTH, COORDINATION], &[]);

    // A card change counts as a change since the build.
    assert_eq!(since_build(&app, &token, &work).await, (0, 0));
    edit(&app, &token, &moved, json!({ "addProfileId": work })).await;
    assert_eq!(since_build(&app, &token, &work).await, (1, 1));
    assert_eq!(
        listed(&app, &token, &work).await,
        pairs(&[(WORK, false), (MOVED, false), (COORDINATION, true)])
    );

    // A custom card shows only memories added to it, so there is nothing to
    // remove for one it reads only in its build.
    let path = format!("/v1/cloud/memory/{coordination}");
    let (status, body) = send(
        &app,
        "PATCH",
        &path,
        &token,
        Some(json!({ "removeProfileId": custom })),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "memory_profile_not_found");
}
