//! Database tests for stable block ids on save.

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::db_fixture::*;

const PLAIN: &str = "# Field notes\n\nAlpha.\n\nBeta.\n\nGamma.\n\nDelta.\n";
const STAMPED: &str = "# Field notes <!-- k:title01 -->\n\nAlpha. <!-- k:alpha01 -->\n\nBeta. <!-- k:beta0001 -->\n\nGamma. <!-- k:gamma001 -->\n\nDelta. <!-- k:delta001 -->\n";

async fn put(f: &Fixture, base: i64, source: &str, block_ids: Value) -> (StatusCode, Value) {
    send(
        &f.app,
        "PUT",
        &format!("/v1/cloud/documents/{}/content", f.attachment_id),
        Some(&f.owner_token),
        Some(json!({"baseRevision": base, "source": source, "blockIds": block_ids})),
    )
    .await
}

async fn comment_on(f: &Fixture, block: &str) -> Value {
    let (status, comment) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{}/comments", f.attachment_id),
        Some(&f.member_token),
        Some(json!({"blockId": block, "body": format!("On {block}")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{comment}");
    comment
}

fn block_of(document: &Value, comment: &Value) -> String {
    document["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["commentId"] == comment["commentId"])
        .map(|item| item["blockId"].as_str().unwrap().to_string())
        .unwrap()
}

fn ids(document: &Value) -> Vec<String> {
    document["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| block["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn stamping_moves_index_annotations_and_stable_ids_follow_their_blocks() {
    let Some(f) = fixture().await else { return };
    let (status, _) = put(&f, 1, PLAIN, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let on_gamma = comment_on(&f, "b3").await;
    let on_alpha = comment_on(&f, "b1").await;

    // First save from a stamping editor: b3 is mapped explicitly, b1 follows by source.
    let (status, stamped) = put(&f, 2, STAMPED, json!({"b3": "k:gamma001"})).await;
    assert_eq!(status, StatusCode::OK, "{stamped}");
    assert_eq!(
        ids(&stamped),
        [
            "k:title01",
            "k:alpha01",
            "k:beta0001",
            "k:gamma001",
            "k:delta001"
        ]
    );
    assert_eq!(block_of(&stamped, &on_gamma), "k:gamma001");
    assert_eq!(block_of(&stamped, &on_alpha), "k:alpha01");
    assert!(stamped["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|block| !block["source"].as_str().unwrap().contains("<!--")));

    // Gamma moves to the top and is rewritten; its comment stays on it.
    let moved = "Gamma, rewritten. <!-- k:gamma001 -->\n\n# Field notes <!-- k:title01 -->\n\nAlpha. <!-- k:alpha01 -->\n\nBeta. <!-- k:beta0001 -->\n\nDelta. <!-- k:delta001 -->\n";
    let (status, after_move) = put(&f, 3, moved, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{after_move}");
    assert_eq!(block_of(&after_move, &on_gamma), "k:gamma001");
    assert_eq!(after_move["blocks"][0]["id"], "k:gamma001");

    let (status, more) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{}/comments", f.attachment_id),
        Some(&f.member_token),
        Some(json!({"blockId": "k:missing1", "body": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{more}");
}

#[tokio::test]
async fn a_deleted_stable_block_hands_its_reaction_to_the_block_before_it() {
    let Some(f) = fixture().await else { return };
    let (status, _) = put(&f, 1, STAMPED, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, reacted) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{}/reactions", f.attachment_id),
        Some(&f.member_token),
        Some(json!({"blockId": "k:gamma001", "reaction": "\u{1f44d}"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reacted}");
    let without_gamma = STAMPED.replace("Gamma. <!-- k:gamma001 -->\n\n", "");
    let (status, saved) = put(&f, 2, &without_gamma, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["reactions"][0]["blockId"], "k:beta0001");

    let token = token_of(&create_share(&f).await);
    let (_, public) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{token}"),
        None,
        None,
    )
    .await;
    assert_eq!(ids(&public)[1], "k:alpha01");
    assert!(!public.to_string().contains("<!--"));
    let (_, _, page_html) = page(&f.app, &format!("/d/{token}")).await;
    assert!(page_html.contains(r#"data-block="k:beta0001""#));
    assert!(!page_html.contains("k:gamma001"));
}

#[tokio::test]
async fn invalid_block_id_mappings_are_rejected() {
    let Some(f) = fixture().await else { return };
    for mapping in [
        json!({"k:alpha01": "k:beta0001"}),
        json!({"b1": "b2"}),
        json!({"b1": "k:notthere"}),
        json!({"b1": "k:a b"}),
    ] {
        let (status, body) = put(&f, 1, STAMPED, mapping.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{mapping}: {body}");
        assert_eq!(body["errorCode"], "invalid_block_ids");
    }
}
