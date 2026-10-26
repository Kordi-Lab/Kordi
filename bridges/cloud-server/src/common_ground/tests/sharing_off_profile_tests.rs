//! Sharing off per profile and in group notices: switching one profile off
//! hides only the links through it, and a group intro or joined line quotes
//! cards only while everyone it names shares theirs in the room.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, create_profile};
use super::sharing_support::{
    answer, card, card_and_match, lobby, own_off, results, set_sharing, CG,
};
use super::support::{join_fresh_room, make_contacts, people_in_a_room};

#[tokio::test]
async fn sharing_off_on_one_profile_leaves_the_other_link() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let alex_work = create_profile(&app, &alex_token, "work", None).await;
    build_profile(&app, &pool, (&alex, &alex_token), &alex_work, "Alex work").await;
    let alex_health = create_profile(&app, &alex_token, "health", None).await;
    build_profile(
        &app,
        &pool,
        (&alex, &alex_token),
        &alex_health,
        "Alex health",
    )
    .await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let priya_work = create_profile(&app, &priya_token, "work", None).await;
    build_profile(
        &app,
        &pool,
        (&priya, &priya_token),
        &priya_work,
        "Priya work",
    )
    .await;
    // A room through Alex's work profile and a pairing through his health one.
    let code = join_fresh_room(&app, &pool, &[&alex_token, &priya_token]).await;
    let body = json!({"profileId": alex_health});
    let (_, shown) = send(
        &app,
        "POST",
        &format!("{CG}/pairings/code"),
        &alex_token,
        Some(body),
    )
    .await;
    let redeem = json!({"code": shown["code"], "profileId": priya_work});
    let path = format!("{CG}/pairings/redeem");
    let (status, body) = send(&app, "POST", &path, &priya_token, Some(redeem)).await;
    assert_eq!(status, 200, "{body}");

    set_sharing(&app, &alex_token, Some(&alex_work), false).await;
    // Through his health profile they still see each other.
    let (status, body) = card(&app, &alex_token, &priya, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["profileId"], alex_health.as_str());
    assert_eq!(body["card"]["workingOn"], json!(["Priya work"]));
    let (status, body) = card(&app, &priya_token, &alex, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["person"]["profile"]["profileId"], alex_health.as_str());
    assert_eq!(body["card"]["workingOn"], json!(["Alex health"]));
    // Through the work profile neither does.
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, Some(&alex_work)).await,
        [own_off(), own_off()]
    );
    assert_eq!(answer(results(&app, &code, &alex_token).await), own_off());
    assert_eq!(
        lobby(&app, &code, &priya_token).await,
        vec![(alex.clone(), false)]
    );
    let (status, body) = results(&app, &code, &priya_token).await;
    assert_eq!((status, &body["people"]), (200, &json!([])), "{body}");

    // Sharing the work profile again restores the room link.
    set_sharing(&app, &alex_token, Some(&alex_work), true).await;
    let (status, body) = card(&app, &alex_token, &priya, Some(&alex_work)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["profileId"], alex_work.as_str());
    assert_eq!(
        lobby(&app, &code, &priya_token).await,
        vec![(alex.clone(), true)]
    );
}

async fn start_group(app: &axum::Router, code: &str, token: &str, members: &[&String]) -> Value {
    let path = format!("{CG}/rooms/{code}/group");
    let body = json!({"memberIds": members});
    let (status, body) = send(app, "POST", &path, token, Some(body)).await;
    assert_eq!(status, 201, "{body}");
    body
}

/// The prompt of the intro run queued for this group.
async fn intro_prompt(pool: &PgPool, group: &Value) -> String {
    let (prompt,): (String,) = query_as(
        "SELECT run.prompt FROM cloud_common_ground_group_intros intro
         JOIN cloud_agent_fallback_runs run ON run.run_id = intro.run_id
         WHERE intro.group_space_id = $1",
    )
    .bind(group["group"]["groupSpaceId"].as_str().unwrap())
    .fetch_one(pool)
    .await
    .unwrap();
    prompt
}

/// The texts System posted in the group, oldest first.
async fn notices(pool: &PgPool, group: &Value) -> Vec<String> {
    let conversation: uuid::Uuid = group["group"]["conversationId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2 ORDER BY conversation_sequence",
    )
    .bind(conversation)
    .bind(crate::system_account::SYSTEM_ACCOUNT_ID)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(content,)| {
            let raw = content["blocks"][0]["text"].as_str().unwrap();
            let encoded = raw.strip_prefix("kordi-cloud-message:").unwrap();
            let payload: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
            payload["text"].as_str().unwrap().to_string()
        })
        .collect()
}

#[tokio::test]
async fn group_notices_quote_cards_only_while_everyone_shares() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;

    // Priya, added as a contact, does not share: the intro names everyone
    // and quotes no card, and Sam's joined line names only him.
    set_sharing(&app, &priya_token, None, false).await;
    let group = start_group(&app, &code, &alex_token, &[&priya, &sam]).await;
    let prompt = intro_prompt(&pool, &group).await;
    for line in [
        "- @Alex (started the group). No card shared.\n",
        "- @Priya. No card shared.\n",
        "- @Sam (invited). No card shared.\n",
    ] {
        assert!(prompt.contains(line), "{line:?} in {prompt}");
    }
    let (_, body) = results(&app, &code, &sam_token).await;
    let reference = body["invitations"][0]["invitationRef"].as_str().unwrap();
    let path = format!("{CG}/rooms/{code}/invitations/{reference}/join");
    let (status, body) = send(&app, "POST", &path, &sam_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(notices(&pool, &group).await, vec!["@Sam joined."]);

    // With everyone sharing, a new group's intro quotes every card.
    set_sharing(&app, &priya_token, None, true).await;
    let group = start_group(&app, &code, &alex_token, &[&priya, &sam]).await;
    let prompt = intro_prompt(&pool, &group).await;
    for name in ["@Alex (started the group)", "@Priya", "@Sam (invited)"] {
        let line = format!("- {name}. Working on: Agent memory. Interests: Retrieval.\n");
        assert!(prompt.contains(&line), "{line:?} in {prompt}");
    }
}
