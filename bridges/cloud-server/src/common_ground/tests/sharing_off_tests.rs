//! Sharing off works both ways (#2100): a pairing or room links two people
//! only while both linked profiles share a built card. When the other
//! person's card is not shared, theirs answers 404; when yours is not, you
//! get 409 `common_ground_sharing_off`. Turning sharing back on restores
//! the same link.

use serde_json::{json, Value};
use sqlx_core::query::query;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::sharing_support::{
    answer, card, card_and_match, contact_grounding, follow_through, hidden, ids, lobby, own_off,
    recent_ids, results, set_sharing, topics, CG,
};
use super::support::{
    answer_match, build_card_with, card_reply, claim_open, make_contacts, open_runs,
    people_in_a_room, RUNNER,
};
use crate::common_ground::{complete, fail};

#[tokio::test]
async fn sharing_off_hides_a_pairing_both_ways() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let alex_card = card_reply(&["Agent memory"], &["Retrieval"], &["Eval design"], &[]);
    build_card_with(&app, &pool, &alex, &alex_token, &alex_card).await;
    let priya_card = card_reply(&["Memory for agents"], &["Retrieval"], &[], &[]);
    build_card_with(&app, &pool, &priya, &priya_token, &priya_card).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("{CG}/pairings/code"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let redeem = json!({"code": body["code"]});
    let path = format!("{CG}/pairings/redeem");
    let (status, body) = send(&app, "POST", &path, &priya_token, Some(redeem)).await;
    assert_eq!(status, 200, "{body}");
    make_contacts(&pool, &alex, &priya).await;

    // Alex opens their match: Priya is in his Recent and on his contact
    // profile of her.
    let detail = format!("{CG}/people/{priya}/match");
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 202);
    answer_match(&pool, &alex).await;
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 200);
    assert_eq!(recent_ids(&app, &alex_token).await, vec![priya.clone()]);
    let grounding = contact_grounding(&app, &alex_token, &priya).await;
    assert_eq!(grounding["workingOn"], json!(["Memory for agents"]));
    assert_eq!(grounding["match"]["headline"], "Memory for agents");

    // Priya turns sharing off: Alex no longer sees her...
    set_sharing(&app, &priya_token, None, false).await;
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );
    assert_eq!(
        follow_through(&app, &alex_token, &priya).await,
        vec![hidden(); 3]
    );
    assert!(recent_ids(&app, &alex_token).await.is_empty());
    assert_eq!(
        contact_grounding(&app, &alex_token, &priya).await,
        Value::Null
    );
    // ...and she no longer sees him through the same pairing.
    assert_eq!(
        card_and_match(&app, &priya_token, &alex, None).await,
        [own_off(), own_off()]
    );
    assert_eq!(
        follow_through(&app, &priya_token, &alex).await,
        vec![own_off(); 3]
    );
    assert_eq!(
        contact_grounding(&app, &priya_token, &alex).await,
        Value::Null
    );

    // Back on, the pairing shows both cards again.
    set_sharing(&app, &priya_token, None, true).await;
    let (status, body) = card(&app, &alex_token, &priya, None).await;
    assert_eq!(
        (status, &body["card"]["workingOn"]),
        (200, &json!(["Memory for agents"]))
    );
    assert_eq!(card(&app, &priya_token, &alex, None).await.0, 200);
    assert_eq!(recent_ids(&app, &alex_token).await, vec![priya.clone()]);
    assert!(contact_grounding(&app, &alex_token, &priya)
        .await
        .is_object());

    // Alex turns his own sharing off: the same answers the other way round.
    set_sharing(&app, &alex_token, None, false).await;
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [own_off(), own_off()]
    );
    assert!(recent_ids(&app, &alex_token).await.is_empty());
    assert_eq!(
        card_and_match(&app, &priya_token, &alex, None).await,
        [hidden(), hidden()]
    );
    assert_eq!(
        follow_through(&app, &priya_token, &alex).await,
        vec![hidden(); 3]
    );
    set_sharing(&app, &alex_token, None, true).await;
    assert_eq!(card(&app, &alex_token, &priya, None).await.0, 200);
    assert_eq!(card(&app, &priya_token, &alex, None).await.0, 200);
}

/// Answers the open room-theme run with these themes, each given by the
/// account ids of its people.
async fn answer_themes(pool: &sqlx_postgres::PgPool, themes: &[(&str, &[&String])]) {
    let (run_id, read) = claim_open(pool, "room", None).await;
    let themes: Vec<Value> = themes
        .iter()
        .map(|(label, people)| {
            let people: Vec<usize> = people
                .iter()
                .map(|id| read.iter().position(|r| r == *id).unwrap())
                .collect();
            json!({"label": label, "people": people})
        })
        .collect();
    let reply = json!({ "themes": themes }).to_string();
    complete(pool, &run_id, RUNNER, &reply).await.unwrap();
}

#[tokio::test]
async fn sharing_off_hides_a_room_both_ways_open_or_closed() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    assert_eq!(results(&app, &code, &alex_token).await.0, 200);
    answer_match(&pool, &alex).await;
    let everyone = [&alex, &priya, &sam];
    answer_themes(
        &pool,
        &[("Agent memory", &everyone), ("Retrieval", &[&alex, &priya])],
    )
    .await;
    let (_, body) = results(&app, &code, &alex_token).await;
    let mut ranked = ids(&body["people"], "person");
    ranked.sort();
    let mut expected = vec![priya.clone(), sam.clone()];
    expected.sort();
    assert_eq!(ranked, expected, "{body}");
    assert_eq!(topics(&body).len(), 2, "{body}");

    // Priya turns sharing off. Alex's lobby keeps her in the room without a
    // card; his results leave her out, and the theme run that follows does
    // not read her card.
    set_sharing(&app, &priya_token, None, false).await;
    let expected = vec![(priya.clone(), false), (sam.clone(), true)];
    assert_eq!(lobby(&app, &code, &alex_token).await, expected);
    let (status, body) = results(&app, &code, &alex_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["people"], "person"), vec![sam.clone()]);
    assert_eq!(
        body["topics"],
        json!([]),
        "themes are found again without her"
    );
    let (run_id, read) = claim_open(&pool, "room", None).await;
    assert_eq!(read, vec![alex.clone(), sam.clone()]);
    fail(&pool, &run_id, Some(RUNNER), "provider_error")
        .await
        .unwrap();
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );
    assert_eq!(
        open_runs(&pool, &alex).await,
        0,
        "nothing is matched with her"
    );
    // Priya sees nobody in the room while her card is not shared.
    assert_eq!(answer(results(&app, &code, &priya_token).await), own_off());
    let expected = vec![(alex.clone(), false), (sam.clone(), false)];
    assert_eq!(lobby(&app, &code, &priya_token).await, expected);
    assert_eq!(
        card_and_match(&app, &priya_token, &alex, None).await,
        [own_off(), own_off()]
    );

    // The room closes. Its stored results and themes still leave her out,
    // and a theme only she shared with Alex is gone.
    query("UPDATE cloud_common_ground_rooms SET last_join_at = now() - interval '25 hours' WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = results(&app, &code, &alex_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["people"], "person"), vec![sam.clone()]);
    let shown = vec![("Agent memory".to_string(), vec![alex.clone(), sam.clone()])];
    assert_eq!(topics(&body), shown, "{body}");
    assert_eq!(
        ids(&body["suggestion"]["people"], ""),
        vec![alex.clone(), sam.clone()]
    );
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );

    // Back on, the closed room shows her again.
    set_sharing(&app, &priya_token, None, true).await;
    let (_, body) = results(&app, &code, &alex_token).await;
    assert!(ids(&body["people"], "person").contains(&priya), "{body}");
    assert_eq!(topics(&body).len(), 2, "{body}");
    assert_eq!(card(&app, &alex_token, &priya, None).await.0, 200);
    let detail = format!("{CG}/people/{priya}/match");
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 200);

    // Alex turns his own sharing off in the closed room.
    set_sharing(&app, &alex_token, None, false).await;
    assert_eq!(answer(results(&app, &code, &alex_token).await), own_off());
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [own_off(), own_off()]
    );
    let expected = vec![(alex.clone(), false), (sam.clone(), true)];
    assert_eq!(lobby(&app, &code, &priya_token).await, expected);
    assert_eq!(
        card_and_match(&app, &priya_token, &alex, None).await,
        [hidden(), hidden()]
    );
}
