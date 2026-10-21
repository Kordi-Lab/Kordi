//! The intro PiP posts when a group starts from a room, the line it posts
//! when an invitee joins, and the members shown with each group.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::send;
use super::support::{
    build_card_with, card_reply, claim_run, make_contacts, people_in_a_room, RUNNER,
};
use crate::common_ground::{complete, fail};

async fn start(app: &axum::Router, code: &str, token: &str, body: Value) -> Value {
    let (status, body) = send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        token,
        Some(body),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body
}

async fn results(app: &axum::Router, code: &str, token: &str) -> Value {
    let (status, body) = send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body
}

fn service() -> String {
    crate::pip::service_account_id().unwrap().to_string()
}

fn conversation(group: &Value) -> Uuid {
    group["group"]["conversationId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

/// The group's intro run, claimed by the runner: (run id, prompt, owner).
async fn claim_intro(pool: &PgPool, group: &Value) -> (String, String, String) {
    let space = group["group"]["groupSpaceId"].as_str().unwrap();
    let (run_id, prompt, owner, status): (String, String, String, String) = query_as(
        "SELECT run.run_id, run.prompt, run.owner_account_id, run.status
         FROM cloud_common_ground_group_intros intro
         JOIN cloud_agent_fallback_runs run ON run.run_id = intro.run_id
         WHERE intro.group_space_id = $1",
    )
    .bind(space)
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(run_id.starts_with("cg_intro_"), "{run_id}");
    assert_eq!(status, "queued");
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    claim_run(pool, &run_id, &lease).await;
    (run_id, prompt, owner)
}

/// The cloud message envelopes PiP posted in a conversation, oldest first.
async fn pip_envelopes(pool: &PgPool, conversation_id: Uuid) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2
         ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .bind(service())
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(content,)| {
            let raw = content["blocks"][0]["text"].as_str().unwrap();
            let encoded = raw.strip_prefix("kordi-cloud-message:").unwrap();
            let payload: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
            assert_eq!(payload["kind"], "message");
            payload
        })
        .collect()
}

/// Texts of the messages PiP posted in a conversation, oldest first.
async fn pip_messages(pool: &PgPool, conversation_id: Uuid) -> Vec<String> {
    pip_envelopes(pool, conversation_id)
        .await
        .into_iter()
        .map(|payload| payload["text"].as_str().unwrap().to_string())
        .collect()
}

/// (displayText, account id) per mention, after checking each range points
/// at its "@Name" in the text.
fn mentions(payload: &Value) -> Vec<(String, String)> {
    let text: Vec<u16> = payload["text"].as_str().unwrap().encode_utf16().collect();
    payload["mentions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|mention| {
            let start = mention["startUtf16"].as_u64().unwrap() as usize;
            let length = mention["lengthUtf16"].as_u64().unwrap() as usize;
            let display = mention["displayText"].as_str().unwrap();
            assert_eq!(
                String::from_utf16(&text[start..start + length]).unwrap(),
                display
            );
            let id = mention["humanId"].as_str().unwrap();
            assert_eq!(mention["targetKind"], "person");
            assert_eq!(mention["targetIdentityId"], format!("human:{id}"));
            assert_eq!(mention["label"], &display[1..]);
            (display.to_string(), id.to_string())
        })
        .collect()
}

/// Kinds of the messages PiP posted in a conversation, oldest first.
async fn pip_kinds(pool: &PgPool, conversation_id: Uuid) -> Vec<String> {
    query_as(
        "SELECT message_kind FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2
         ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .bind(service())
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(kind,): (String,)| kind)
    .collect()
}

/// Stores a match result for `viewer` with `other`, between their room
/// profiles.
async fn store_match(pool: &PgPool, viewer: &str, other: &str, result: Value) {
    sqlx_core::query::query(
        "INSERT INTO cloud_common_ground_matches
           (viewer_account_id, other_account_id, viewer_profile_id, other_profile_id,
            viewer_revision, other_revision, result_json)
         SELECT $1, $2, mine.profile_id, theirs.profile_id, 1, 1, $3
         FROM cloud_common_ground_room_members mine, cloud_common_ground_room_members theirs
         WHERE mine.account_id = $1 AND theirs.account_id = $2",
    )
    .bind(viewer)
    .bind(other)
    .bind(result)
    .execute(pool)
    .await
    .unwrap();
}

async fn intro_state(pool: &PgPool, run_id: &str) -> (bool, Option<String>) {
    query_as(
        "SELECT posted_at IS NOT NULL, error_code FROM cloud_common_ground_group_intros
         WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn start_group_queues_an_intro_that_pip_posts() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let priya_card = card_reply(&["Tool use"], &["Retrieval"], &["Rust services"], &[]);
    build_card_with(&app, &pool, &priya, &priya_token, &priya_card).await;
    make_contacts(&pool, &alex, &priya).await;
    let group = start(
        &app,
        &code,
        &alex_token,
        json!({"name": "Memory group", "topic": "Agent memory", "memberIds": [priya, sam]}),
    )
    .await;

    let (run_id, prompt, owner) = claim_intro(&pool, &group).await;
    assert_eq!(owner, service(), "the intro runs on PiP's account");
    for expected in [
        "Group: Memory group\n",
        "Topic: Agent memory\n",
        "- @Alex (started the group). Working on: Agent memory.",
        "- @Priya. Working on: Tool use. Can help with: Rust services.",
        "- @Sam (invited). Working on: Agent memory.",
    ] {
        assert!(prompt.contains(expected), "{expected:?} in {prompt}");
    }
    assert!(pip_messages(&pool, conversation(&group)).await.is_empty());

    // The model wrote two names bare; the cap cuts the last "@Sam" in half.
    let lines = "  Welcome, Alex, Priya and Sam.\nAlex: memory.\n@Priya: tool use.\n\
                 Sam (invited): here.\n";
    let reply = format!("{lines}{} @Sam", "x".repeat(1_200 - 89));
    complete(&pool, &run_id, RUNNER, &reply).await.unwrap();
    let posted = pip_envelopes(&pool, conversation(&group)).await;
    assert_eq!(posted.len(), 1);
    assert_eq!(
        pip_kinds(&pool, conversation(&group)).await,
        vec!["system-notice"]
    );
    let text = posted[0]["text"].as_str().unwrap();
    assert!(
        text.starts_with(
            "Welcome, Alex, Priya and Sam.\n@Alex: memory.\n@Priya: tool use.\n\
             @Sam (invited): here.\n"
        ),
        "{text}"
    );
    assert_eq!(text.chars().count(), 1_200, "the intro is capped");
    assert!(text.ends_with(" @Sa"), "{}", &text[text.len() - 8..]);
    assert_eq!(
        mentions(&posted[0]),
        vec![
            ("@Alex".to_string(), alex.clone()),
            ("@Priya".to_string(), priya.clone()),
            ("@Sam".to_string(), sam.clone()),
        ]
    );
    assert_eq!(intro_state(&pool, &run_id).await, (true, None));
    // Priya was added, so the intro is in her chat.
    let snapshot = crate::chat_sync::store::bootstrap(&pool, &priya)
        .await
        .unwrap();
    assert!(snapshot
        .conversations
        .iter()
        .any(|c| c.id == conversation(&group)));
    // A repeated report posts nothing more.
    assert!(complete(&pool, &run_id, RUNNER, "Again").await.is_err());
    assert_eq!(pip_messages(&pool, conversation(&group)).await.len(), 1);
}

#[tokio::test]
async fn a_failed_intro_posts_nothing() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(_, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    let group = start(&app, &code, &alex_token, json!({"memberIds": [priya]})).await;
    let (run_id, _, _) = claim_intro(&pool, &group).await;
    fail(&pool, &run_id, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    assert_eq!(
        intro_state(&pool, &run_id).await,
        (false, Some("provider_error".into()))
    );
    assert!(complete(&pool, &run_id, RUNNER, "Hello").await.is_err());
    assert!(pip_messages(&pool, conversation(&group)).await.is_empty());

    // An empty reply fails the run the same way.
    let group = start(&app, &code, &alex_token, json!({"memberIds": [priya]})).await;
    let (run_id, _, _) = claim_intro(&pool, &group).await;
    complete(&pool, &run_id, RUNNER, "   ").await.unwrap();
    assert_eq!(
        intro_state(&pool, &run_id).await,
        (false, Some("invalid_output".into()))
    );
    assert!(pip_messages(&pool, conversation(&group)).await.is_empty());
}

#[tokio::test]
async fn joining_posts_a_line_and_groups_show_their_members() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, _), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let sam_card = card_reply(
        &["Agent memory", "Tool use", "Evals"],
        &["Retrieval"],
        &["Eval design", "Rust", "Writing"],
        &[],
    );
    build_card_with(&app, &pool, &sam, &sam_token, &sam_card).await;
    make_contacts(&pool, &alex, &priya).await;
    let group = start(&app, &code, &alex_token, json!({"memberIds": [sam, priya]})).await;
    let conversation_id = conversation(&group);

    let mine = results(&app, &code, &alex_token).await;
    let row = &mine["groups"][0];
    let shown: Vec<&str> = row["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(shown, vec![alex.as_str(), priya.as_str()], "creator first");
    assert_eq!(row["members"][0]["name"], "Alex");
    assert_eq!(row["memberCount"], 2);
    assert!(!row.to_string().contains(&service()), "PiP is not a member");

    // Sam's stored match with Priya names her; Alex has none and is left out.
    store_match(
        &pool,
        &sam,
        &priya,
        json!({
            "score": 60,
            "headline": "Memory for agents",
            "shared": [{"topic": "Agent memory", "theirTopic": "Memory for agents", "why": "Same area"}],
            "youBring": [],
            "theyBring": [],
            "nextStep": "Meet",
        }),
    )
    .await;
    let theirs = results(&app, &code, &sam_token).await;
    let reference = theirs["invitations"][0]["invitationRef"].as_str().unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/invitations/{reference}/join"),
        &sam_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let posted = pip_envelopes(&pool, conversation_id).await;
    assert_eq!(posted.len(), 1);
    assert_eq!(
        posted[0]["text"],
        "@Sam joined. Working on agent memory and tool use; can help with eval design and \
         rust. Shares agent memory with @Priya."
    );
    assert_eq!(
        mentions(&posted[0]),
        vec![
            ("@Sam".to_string(), sam.clone()),
            ("@Priya".to_string(), priya.clone()),
        ]
    );
    assert_eq!(
        pip_kinds(&pool, conversation_id).await,
        vec!["system-notice"]
    );
    let (_, again) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/invitations/{reference}/join"),
        &sam_token,
        None,
    )
    .await;
    assert_eq!(again["status"], "already_joined");
    assert_eq!(pip_messages(&pool, conversation_id).await.len(), 1);

    let theirs = results(&app, &code, &sam_token).await;
    let row = &theirs["groups"][0];
    assert_eq!(row["memberCount"], 3);
    assert_eq!(row["members"].as_array().unwrap().len(), 3);
    assert_eq!(row["members"][0]["accountId"], alex.as_str());
    assert_eq!(row["members"][2]["accountId"], sam.as_str());
}
