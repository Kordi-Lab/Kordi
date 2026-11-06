//! "Use my agent" off (docs/contact-permissions.md): a restricted account's
//! agent cannot reach out to the owner's agent, and a request already sent
//! is withdrawn when the restriction is saved.
use super::*;
use sqlx_core::query_as::query_as;

async fn restrict(f: &Fixture, owner: usize, subject: usize) {
    let path = format!(
        "/v1/cloud/contacts/{}/permissions",
        f.people[subject].account_id
    );
    let request = Request::builder()
        .method("PUT")
        .uri(path)
        .header("authorization", format!("Bearer {}", f.people[owner].token))
        .header("content-type", "application/json")
        .body(Body::from(json!({"agentAccess": false}).to_string()))
        .unwrap();
    let response = f.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn exchanges_to(f: &Fixture, target: usize) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_exchanges WHERE parent_run_id = $1 AND target_owner_id = $2",
    )
    .bind(&f.root)
    .bind(&f.people[target].account_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn restricted_agents_cannot_reach_out_and_sent_requests_are_withdrawn() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    // Gamma stops Alpha from using its agent: Alpha's agent cannot reach it.
    restrict(&f, 2, 0).await;
    let path = format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root);
    let body = json!({"claimId":f.claim,"toolCallId":"blocked","arguments":{"target":format!("cloud-agent:{}",f.people[2].account_id),"message":"Return the synthetic status."}});
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(&path, &f.people[0].token, body))
        .await
        .unwrap();
    let status = response.status();
    let value = read_json(response).await;
    assert!(
        status != StatusCode::OK || value.get("exchangeId").is_none(),
        "{status} {value}"
    );
    assert_eq!(exchanges_to(&f, 2).await, 0);

    // Beta's agent is reachable until Beta restricts Alpha; then the sent
    // request is no longer offered to Beta's Mac or claimable there.
    f.send("allowed", 1).await;
    let target = f.pending(1).await.remove(0);
    restrict(&f, 1, 0).await;
    assert!(f.pending(1).await.is_empty());
    let claim = json!({"claimId":uuid::Uuid::new_v4(),"requestMessageId":target["requestMessageId"],"sessionId":f.session,"ownerAccountId":f.people[1].account_id,"requesterAccountId":target["requesterAccountId"],"prompt":target["prompt"],"idempotencyKey":target["runId"]});
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &f.people[1].token,
            claim,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        read_json(response).await["errorCode"],
        "agent_not_available"
    );
}
