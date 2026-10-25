//! `GET /v1/cloud/proactive/proposals`: the caller's offers across all of
//! their agents, filtered by conversation, and lazy expiry on read.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;
use super::offer_db::{hints_for, last_hint, offer};

fn all_uri(query: &str) -> String {
    format!("/v1/cloud/proactive/proposals{query}")
}

#[tokio::test]
async fn the_cross_agent_list_shows_the_open_conversations_offers_to_the_owner_only() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    let group = f.group.to_string();

    let (status, body) = f
        .send(
            "GET",
            &all_uri(&format!("?status=pending&conversationId={group}")),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let proposals = body["proposals"].as_array().unwrap();
    assert_eq!(proposals.len(), 1, "{body}");
    assert_eq!(proposals[0]["proposalId"], proposal_id);
    assert_eq!(proposals[0]["agentId"], f.agent_id);
    assert_eq!(proposals[0]["conversationTitle"], "Launch");
    assert!(proposals[0].get("cardMessageId").is_none());

    // Pending is the default, and another conversation has nothing.
    let (status, body) = f.send("GET", &all_uri(""), &f.owner_token, None).await;
    assert_eq!(status, 200);
    assert_eq!(body["proposals"][0]["proposalId"], proposal_id);
    let (_, body) = f
        .send(
            "GET",
            &all_uri(&format!("?conversationId={}", Uuid::new_v4())),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(body["proposals"].as_array().unwrap().len(), 0);

    // The per-agent route takes the same filter.
    let (status, body) = f
        .send(
            "GET",
            &format!(
                "/v1/cloud/agents/{}/proactive/proposals?conversationId={group}",
                f.agent_id
            ),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["proposals"][0]["proposalId"], proposal_id);

    // The collaborator in the same group sees none of it.
    let (status, body) = f
        .send(
            "GET",
            &all_uri(&format!("?conversationId={group}")),
            &f.member_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["proposals"].as_array().unwrap().len(), 0);
    let (status, _) = f
        .send(
            "GET",
            &format!(
                "/v1/cloud/agents/{}/proactive/proposals?conversationId={group}",
                f.agent_id
            ),
            &f.member_token,
            None,
        )
        .await;
    assert_eq!(status, 403);

    for bad in ["?conversationId=nope", "?status=maybe"] {
        let (status, _) = f.send("GET", &all_uri(bad), &f.owner_token, None).await;
        assert_eq!(status, 400, "{bad}");
    }
}

#[tokio::test]
async fn reading_expires_offers_whose_time_ran_out_and_hints_it() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    query(
        "UPDATE cloud_agent_proactive_proposals SET expires_at = now() - interval '1 minute' \
         WHERE proposal_id = $1",
    )
    .bind(&proposal_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let (status, body) = f
        .send(
            "GET",
            &all_uri(&format!("?conversationId={}", f.group)),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["proposals"].as_array().unwrap().len(), 0);
    let (stored,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
            .bind(&proposal_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(stored, "expired");
    let statuses: Vec<String> = hints_for(&f, &f.owner, &proposal_id)
        .await
        .iter()
        .map(|hint| hint["status"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(statuses, ["pending", "expired"]);
    // A second read changes nothing and hints nothing.
    f.send("GET", &all_uri(""), &f.owner_token, None).await;
    assert_eq!(hints_for(&f, &f.owner, &proposal_id).await.len(), 2);
    assert_eq!(last_hint(&f, &proposal_id).await["status"], "expired");
    let (_, body) = f
        .send("GET", &all_uri("?status=expired"), &f.owner_token, None)
        .await;
    assert_eq!(body["proposals"][0]["proposalId"], proposal_id);
}
