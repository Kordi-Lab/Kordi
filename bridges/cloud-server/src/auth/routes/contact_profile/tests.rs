//! Database tests for the contact profile route and the `about` line. They
//! use the Common ground fixture and its skip rule: outside CI they return
//! early without `$DATABASE_URL`.

use serde_json::{json, Value};
use sqlx_core::query::query;
use uuid::Uuid;

use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

mod fixtures;
use fixtures::*;

fn profile_path(account_id: &str) -> String {
    format!("/v1/cloud/contacts/{account_id}/profile")
}

#[tokio::test]
async fn person_contact_shows_presence_counts_and_groups_in_common() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_me").await;
    let (nadia, nadia_token) = signed_in(&pool, "cp_nadia").await;
    let (other, _) = signed_in(&pool, "cp_other").await;
    befriend(&pool, &me, &nadia).await;
    let (status, _) = send(
        &app,
        "PATCH",
        "/v1/cloud/auth/me",
        &nadia_token,
        Some(json!({"about": "Robotics PhD."})),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/presence/online",
        &nadia_token,
        None,
    )
    .await;
    assert_eq!(status, 200);

    let direct_id = crate::auth::routes::direct_person_session_id(&me, &nadia);
    let direct = conversation(&pool, "direct", &direct_id, &[&me, &nadia]).await;
    let photo = message(&pool, direct, 1, &me, "").await;
    attach(&pool, photo, &me).await;
    let document_message = message(&pool, direct, 2, &nadia, "Notes").await;
    let document = attach(&pool, document_message, &nadia).await;
    share(&pool, &document, &nadia, false).await;
    message(
        &pool,
        direct,
        3,
        &nadia,
        "See https://example.test/a and http://example.test/b",
    )
    .await;
    message(&pool, direct, 4, &me, "No link here").await;
    let deleted = message(&pool, direct, 5, &me, "https://example.test/deleted").await;
    query("UPDATE cloud_chat_messages SET deleted_at = now() WHERE message_id = $1")
        .bind(deleted)
        .execute(&pool)
        .await
        .unwrap();
    let hidden = message(
        &pool,
        direct,
        6,
        &nadia,
        "https://example.test/hidden-for-me",
    )
    .await;
    query("INSERT INTO cloud_chat_message_visibility (account_id, message_id) VALUES ($1, $2)")
        .bind(&me)
        .bind(hidden)
        .execute(&pool)
        .await
        .unwrap();
    // A revoked share does not count; a link in a group is not in the direct chat.
    let revoked_message = message(&pool, direct, 7, &me, "Old notes").await;
    let revoked = attach(&pool, revoked_message, &me).await;
    share(&pool, &revoked, &me, true).await;

    let space = |label: &str| format!("session:group:{label}-{}", Uuid::new_v4().simple());
    let older = space("older");
    let group = conversation(&pool, "group", &older, &[&me, &nadia, &other]).await;
    message(&pool, group, 1, &nadia, "https://example.test/group").await;
    let newer = space("newer");
    conversation(&pool, "group", &newer, &[&nadia, &me]).await;
    let left = space("left");
    let left_group = conversation(&pool, "group", &left, &[&me, &nadia]).await;
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'left', left_at = now() WHERE conversation_id = $1 AND account_id = $2")
        .bind(left_group)
        .bind(&nadia)
        .execute(&pool)
        .await
        .unwrap();
    conversation(&pool, "group", &space("theirs"), &[&nadia, &other]).await;

    let (status, body) = send(&app, "GET", &profile_path(&nadia), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["accountId"], nadia);
    assert_eq!(body["kind"], "person");
    assert_eq!(body["about"], "Robotics PhD.");
    assert_eq!(body["isSelf"], false);
    assert_eq!(body["isContact"], true);
    assert!(
        body["kordiId"].as_str().is_some_and(|id| id.len() == 9),
        "{body}"
    );
    assert_eq!(body["presence"]["status"], "online");
    assert_eq!(body["presence"]["lastSeenAt"], Value::Null);
    assert_eq!(
        body["defaultAgent"]["agentId"],
        format!("cloud-agent:{nadia}")
    );
    assert_eq!(
        body["defaultAgent"]["accountId"],
        format!("cloud-agent:{nadia}")
    );
    assert_eq!(body["owner"], Value::Null);
    assert_eq!(body["contactSince"], "2026-08-12T09:30:00+00:00");
    assert_eq!(body["shared"]["mediaCount"], 3);
    assert_eq!(body["shared"]["linkCount"], 1);
    assert_eq!(body["shared"]["documentCount"], 1);
    let groups: Vec<&str> = body["shared"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["groupId"].as_str().unwrap())
        .collect();
    assert_eq!(groups, vec![newer.as_str(), older.as_str()]);
    assert_eq!(
        body["shared"]["groups"][0]["title"],
        format!("Group {newer}")
    );
    assert_eq!(body["shared"]["groups"][0]["avatarUrl"], Value::Null);
    assert_eq!(body["commonGround"], Value::Null);
}

#[tokio::test]
async fn self_profile_is_allowed_without_shared_counts() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_self").await;
    let (status, body) = send(&app, "GET", &profile_path(&me), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["isSelf"], true);
    assert_eq!(body["isContact"], false);
    assert_eq!(body["contactSince"], Value::Null);
    assert_eq!(body["presence"]["status"], "offline");
    assert_eq!(
        body["shared"],
        json!({"mediaCount": 0, "linkCount": 0, "documentCount": 0, "groups": []})
    );
}

#[tokio::test]
async fn agent_contact_names_its_owner() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_agent_me").await;
    let (owner, _) = signed_in(&pool, "cp_agent_owner").await;
    let (stranger, _) = signed_in(&pool, "cp_agent_stranger").await;
    befriend(&pool, &me, &owner).await;

    let (status, body) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{owner}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "agent");
    assert_eq!(body["accountId"], format!("cloud-agent:{owner}"));
    assert_eq!(body["kordiId"], Value::Null);
    assert_eq!(body["defaultAgent"], Value::Null);
    assert_eq!(body["owner"]["accountId"], owner);
    assert_eq!(body["owner"]["displayName"], "cp_agent_owner");
    assert!(body["owner"]["kordiId"].as_str().is_some(), "{body}");
    assert_eq!(body["contactSince"], Value::Null);
    assert_eq!(body["isContact"], true);
    assert_eq!(body["commonGround"], Value::Null);

    let (status, _) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{me}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200, "your own agent is visible");
    let (status, _) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{stranger}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 404, "a stranger's agent is not visible");
}

#[tokio::test]
async fn non_contacts_and_unknown_accounts_are_not_found() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (_, token) = signed_in(&pool, "cp_404_me").await;
    let (stranger, _) = signed_in(&pool, "cp_404_stranger").await;
    for target in [
        stranger.as_str(),
        "acct_missing",
        "cloud-agent:acct_missing",
    ] {
        let (status, body) = send(&app, "GET", &profile_path(target), &token, None).await;
        assert_eq!(status, 404, "{target}");
        assert_eq!(body["errorCode"], "contact_not_found");
    }
}

#[tokio::test]
async fn about_is_trimmed_cleared_and_limited() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (_, token) = signed_in(&pool, "cp_about").await;
    let me = "/v1/cloud/auth/me";

    let (status, body) = send(&app, "GET", me, &token, None).await;
    assert_eq!(status, 200);
    assert_eq!(body["about"], Value::Null, "{body}");
    assert!(body.as_object().unwrap().contains_key("about"));

    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"about": "  Building a lab.  "})),
    )
    .await;
    assert_eq!(
        (status, body["about"].clone()),
        (200, json!("Building a lab."))
    );
    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"displayName": "Renamed"})),
    )
    .await;
    assert_eq!(
        (status, body["about"].clone()),
        (200, json!("Building a lab.")),
        "absent keeps it"
    );

    let limit = "a".repeat(280);
    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": limit}))).await;
    assert_eq!((status, body["about"].clone()), (200, json!(limit)));
    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"about": format!("{limit}a")})),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "invalid_about");
    let (_, body) = send(&app, "GET", me, &token, None).await;
    assert_eq!(
        body["about"],
        json!(limit),
        "a rejected update changes nothing"
    );

    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": "   "}))).await;
    assert_eq!((status, body["about"].clone()), (200, Value::Null));
    send(&app, "PATCH", me, &token, Some(json!({"about": "Again"}))).await;
    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": null}))).await;
    assert_eq!((status, body["about"].clone()), (200, Value::Null));
}

#[tokio::test]
async fn common_ground_shows_only_when_the_card_is_visible_and_shared() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_cg_me").await;
    let (paired, _) = signed_in(&pool, "cp_cg_paired").await;
    let (unpaired, _) = signed_in(&pool, "cp_cg_unpaired").await;
    let (private, _) = signed_in(&pool, "cp_cg_private").await;
    for (peer, sharing) in [(&paired, true), (&unpaired, true), (&private, false)] {
        befriend(&pool, &me, peer).await;
        card(&pool, peer, sharing).await;
    }
    pair(&pool, &me, &paired).await;
    pair(&pool, &me, &private).await;

    let (status, body) = send(&app, "GET", &profile_path(&paired), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["commonGround"],
        json!({
            "workingOn": ["Tabletop manipulation", "Sim-to-real", "Grasping", "Tactile"],
            "canHelp": ["Grant writing"],
            "lookingFor": ["Robot datasets"],
        }),
        "hidden topics are removed and each list holds four"
    );
    for peer in [&unpaired, &private] {
        let (status, body) = send(&app, "GET", &profile_path(peer), &token, None).await;
        assert_eq!(status, 200);
        assert_eq!(body["commonGround"], Value::Null, "{peer}");
    }
}
