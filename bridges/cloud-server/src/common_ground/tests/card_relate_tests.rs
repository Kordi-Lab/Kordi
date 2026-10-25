//! Card builds relate the owner's other memories to the card (#2069): which
//! memories a build offers, which ones it adds, and that `memoriesSinceBuild`
//! does not count a build's own additions.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_memories_tests::{group_of, listed, own, pairs, save, since_build};
use super::profile_support::create_profile;
use super::support::{claim, RUNNER};
use crate::common_ground::complete;

const BUILD: &str = "/v1/cloud/common-ground/card/build";
const WORK: &str = "Leads the Atlas data pipeline";
const HEALTH: &str = "Trains for a marathon on weekends";
const PREFERENCE: &str = "Prefers typed Rust services";
const GOAL: &str = "Wants to publish the memory paper this year";
const LATE: &str = "Learning to review database migrations";
const ADDED: &str = "Keeps a reading list of systems papers";
const REMOVED: &str = "Mentors two interns";
const GROUP: &str = "The crew likes Friday demos";

/// Starts a memory-only build of `profile` and returns the run id, its
/// prompts and the ids it offered.
async fn start(
    app: &axum::Router,
    pool: &PgPool,
    (account, token): (&str, &str),
    profile: &str,
) -> (String, String, String, Value) {
    let body = json!({ "profileId": profile, "memory": true });
    let (status, reply) = send(app, "POST", BUILD, token, Some(body)).await;
    assert_eq!(status, 202, "{reply}");
    let run_id = claim(pool, account).await;
    let (prompt, system, offered): (String, String, Value) = query_as(
        "SELECT run.prompt, run.system_prompt, card.build_candidates_json \
         FROM cloud_agent_fallback_runs run \
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id \
         WHERE run.run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(pool)
    .await
    .unwrap();
    (run_id, prompt, system, offered)
}

fn reply(related: &[&str]) -> String {
    json!({
        "working_on": [{ "label": "Atlas data pipeline", "evidence": [0] }],
        "relatedMemoryIds": related,
    })
    .to_string()
}

async fn choice(pool: &PgPool, memory: &str, profile: &str) -> Option<bool> {
    query_as::<_, (bool,)>(
        "SELECT included FROM cloud_account_memory_card_overrides \
         WHERE memory_id = $1 AND profile_id = $2",
    )
    .bind(memory)
    .bind(profile)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(included,)| included)
}

async fn audits(pool: &PgPool, account: &str) -> Vec<Value> {
    let rows: Vec<(String,)> = query_as(
        "SELECT metadata_json FROM cloud_audit_events \
         WHERE account_id = $1 AND event_type = 'card_memories_related' ORDER BY created_at",
    )
    .bind(account)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.iter()
        .map(|(json,)| serde_json::from_str(json).unwrap())
        .collect()
}

#[tokio::test]
async fn builds_relate_offered_memories_to_the_card() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &token, "work", None).await;
    let custom = create_profile(&app, &token, "custom", Some("KAUST")).await;

    let work_memory = save(&app, &token, own(WORK, "work_context")).await;
    save(&app, &token, own(HEALTH, "health_context")).await;
    let preference = save(&app, &token, own(PREFERENCE, "general_preferences")).await;
    let goal = save(&app, &token, own(GOAL, "goals_and_constraints")).await;
    let late = save(&app, &token, own(LATE, "general_preferences")).await;
    let added = save(&app, &token, own(ADDED, "general_preferences")).await;
    let path = format!("/v1/cloud/memory/{added}");
    let (status, body) = send(
        &app,
        "PATCH",
        &path,
        &token,
        Some(json!({ "addProfileId": work })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // Removed from Work, then moved to a category Work does not receive:
    // the removal still holds, so the build never offers it.
    let removed = save(&app, &token, own(REMOVED, "work_context")).await;
    let path = format!("/v1/cloud/memory/{removed}");
    let (status, body) = send(
        &app,
        "PATCH",
        &path,
        &token,
        Some(json!({ "removeProfileId": work })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = send(
        &app,
        "PATCH",
        &path,
        &token,
        Some(json!({ "category": "general_preferences" })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let group_id = group_of(&pool, &alex).await;
    save(
        &app,
        &token,
        json!({ "scope": "group", "scopeId": group_id, "source": "manual",
                "text": GROUP, "category": "general_preferences" }),
    )
    .await;

    let (run_id, prompt, system, offered) = start(&app, &pool, (&alex, &token), &work).await;
    // Newest first: not on the card, never removed from it, not health,
    // not a group memory.
    assert_eq!(offered, json!([late, goal, preference]));
    assert!(
        prompt.contains(&format!(
            "Other memories:\n[{late}] general_preferences · {LATE}\n"
        )),
        "{prompt}"
    );
    for absent in [WORK, HEALTH, ADDED, REMOVED, GROUP] {
        let block = prompt.split("Other memories:").nth(1).unwrap();
        assert!(!block.contains(absent), "{absent} offered: {prompt}");
    }
    assert!(system.contains("\"relatedMemoryIds\""), "{system}");

    // The person removes LATE from Work while the run works: it stays off.
    query("INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included) VALUES ($1, $2, FALSE)")
        .bind(&late)
        .bind(&work)
        .execute(&pool)
        .await
        .unwrap();
    let text = reply(&[
        &preference,
        &goal,
        &late,
        &work_memory,
        &added,
        "mem_unknown",
    ]);
    complete(&pool, &run_id, RUNNER, &text).await.unwrap();

    assert_eq!(choice(&pool, &preference, &work).await, Some(true));
    assert_eq!(choice(&pool, &goal, &work).await, Some(true));
    assert_eq!(choice(&pool, &late, &work).await, Some(false));
    assert_eq!(choice(&pool, &work_memory, &work).await, None);
    assert_eq!(
        audits(&pool, &alex).await,
        [json!({ "profileId": work, "count": 2 })]
    );
    // The legacy column names the one added card.
    let (legacy,): (Option<String>,) =
        query_as("SELECT profile_id FROM cloud_account_memories WHERE memory_id = $1")
            .bind(&preference)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(legacy.as_deref(), Some(work.as_str()));

    // The card lists them, and the build's own additions are not changes
    // since the build.
    assert_eq!(
        listed(&app, &token, &work).await,
        pairs(&[
            (WORK, false),
            (PREFERENCE, false),
            (GOAL, false),
            (ADDED, false)
        ])
    );
    assert_eq!(since_build(&app, &token, &work).await, (0, 0));
    save(&app, &token, own("Runs the lab seminar", "work_context")).await;
    assert_eq!(since_build(&app, &token, &work).await, (1, 1));

    // A reply without the list relates nothing; the card is still built.
    let (run_id, _, _, offered) = start(&app, &pool, (&alex, &token), &custom).await;
    assert!(
        offered
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &json!(preference)),
        "{offered}"
    );
    let text = json!({ "working_on": [{ "label": "KAUST lab", "evidence": [0] }] }).to_string();
    complete(&pool, &run_id, RUNNER, &text).await.unwrap();
    assert_eq!(listed(&app, &token, &custom).await, pairs(&[]));
    assert_eq!(audits(&pool, &alex).await.len(), 1);
    let (built, offered): (bool, Option<Value>) = query_as(
        "SELECT built_at IS NOT NULL, build_candidates_json FROM cloud_common_ground_cards \
         WHERE profile_id = $1",
    )
    .bind(&custom)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(built);
    assert_eq!(offered, None);

    // A custom card gets its related memories too.
    let (run_id, _, _, _) = start(&app, &pool, (&alex, &token), &custom).await;
    complete(&pool, &run_id, RUNNER, &reply(&[&goal]))
        .await
        .unwrap();
    assert_eq!(listed(&app, &token, &custom).await, pairs(&[(GOAL, false)]));
    assert_eq!(since_build(&app, &token, &custom).await, (0, 0));

    query("DELETE FROM cloud_chat_conversations WHERE conversation_id = $1::uuid")
        .bind(&group_id)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn builds_offer_at_most_forty_memories_and_only_when_reading_memories() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &token, "work", None).await;
    save(&app, &token, own(WORK, "work_context")).await;
    let mut saved = Vec::new();
    for index in 0..45 {
        let text = format!("Likes topic number {index}");
        saved.push(save(&app, &token, own(&text, "general_preferences")).await);
    }
    let (run_id, _, _, offered) = start(&app, &pool, (&alex, &token), &work).await;
    let offered = offered.as_array().unwrap().clone();
    assert_eq!(offered.len(), 40);
    assert_eq!(offered[0], json!(saved[44]));
    complete(&pool, &run_id, RUNNER, &reply(&[])).await.unwrap();
    assert!(audits(&pool, &alex).await.is_empty());

    // A build that does not read memories offers none.
    let body = json!({ "profileId": work, "notes": "Building the Atlas pipeline" });
    let (status, reply) = send(&app, "POST", BUILD, &token, Some(body)).await;
    assert_eq!(status, 202, "{reply}");
    let (prompt, system, offered): (String, String, Value) = query_as(
        "SELECT run.prompt, run.system_prompt, card.build_candidates_json \
         FROM cloud_agent_fallback_runs run \
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id \
         WHERE card.profile_id = $1",
    )
    .bind(&work)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(offered, json!([]));
    assert!(!prompt.contains("Other memories"), "{prompt}");
    assert!(!system.contains("relatedMemoryIds"), "{system}");
}
