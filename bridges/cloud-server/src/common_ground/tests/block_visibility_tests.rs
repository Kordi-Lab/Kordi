//! A block in either direction hides two people from each other in
//! Grounding: cards, matches, and Recent read as if they were not linked.

use serde_json::json;
use sqlx_core::query::query;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::sharing_support::{card_and_match, hidden, recent_ids, CG};
use super::support::{answer_match, build_card_with, card_reply};

#[tokio::test]
async fn a_block_hides_a_pairing_both_ways() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let alex_card = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
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
    assert_eq!(
        send(&app, "POST", &path, &priya_token, Some(redeem))
            .await
            .0,
        200
    );
    let detail = format!("{CG}/people/{priya}/match");
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 202);
    answer_match(&pool, &alex).await;
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 200);
    assert_eq!(recent_ids(&app, &alex_token).await, vec![priya.clone()]);

    query(
        "INSERT INTO cloud_account_blocks(blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&priya)
    .bind(&alex)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );
    assert_eq!(
        card_and_match(&app, &priya_token, &alex, None).await,
        [hidden(), hidden()]
    );
    assert!(recent_ids(&app, &alex_token).await.is_empty());
}
