use super::*;

/// The owner's plain message runs their own Agent with the route they chose;
/// other members' plain messages and route choices do not.
pub(super) async fn verify(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    [owner, peer]: [&TestAccount; 2],
    id: &str,
) {
    let uri = format!("/v1/cloud/agent-subsessions/{id}");
    let send = |actor: &TestAccount, text: &str, route: Option<Value>| {
        let mut body = json!({"clientMessageId":uuid::Uuid::new_v4(),"text":text,"mentions":[]});
        if let Some(route) = route {
            body["runtimeRoute"] = route;
        }
        let request = post_json_with_token(&format!("{uri}/messages"), &actor.token, body.clone());
        (
            body["clientMessageId"].as_str().unwrap().to_string(),
            request,
        )
    };
    let route = json!({"defaultModel":"openai/gpt-5.5","defaultAuthProvider":"openai","defaultAuthChoice":"api-key","thinking":"high"});
    let run_for = |message: String| {
        sqlx_core::query_as::query_as::<_, (Option<String>, Option<Value>, Option<String>)>(
            "SELECT c.run_id,r.runtime_route_json,r.requester_account_id FROM cloud_agent_subsession_chat c LEFT JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE c.message_id=$1::uuid",
        )
        .bind(message)
        .fetch_one(pool)
    };

    let (_, request) = send(
        peer,
        "Only the owner chooses the route",
        Some(route.clone()),
    );
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let (_, request) = send(owner, "Malformed route", Some(json!({"thinking":"bogus"})));
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let (peer_message, request) = send(peer, "Plain peer context", None);
    assert_eq!(
        router.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(
        run_for(peer_message).await.unwrap().0.is_none(),
        "another member's plain message stays conversation context"
    );

    let (retry, request) = send(owner, "try again", Some(route.clone()));
    assert_eq!(
        router.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    let (run, stored_route, requester) = run_for(retry).await.unwrap();
    assert!(run.is_some(), "the owner's plain message must start a run");
    assert_eq!(stored_route, Some(route.clone()));
    assert_eq!(requester.as_deref(), Some(owner.account_id.as_str()));

    let owner_view = read_json(
        router
            .clone()
            .oneshot(get_with_token(&uri, &owner.token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(owner_view["runtimeRoute"], route);
    let peer_view = read_json(
        router
            .clone()
            .oneshot(get_with_token(&uri, &peer.token))
            .await
            .unwrap(),
    )
    .await;
    assert!(
        peer_view.get("runtimeRoute").is_none(),
        "only the owner sees the route"
    );

    let (next, request) = send(owner, "and once more", None);
    assert_eq!(
        router.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    let (run, stored_route, _) = run_for(next).await.unwrap();
    assert!(run.is_some());
    assert_eq!(
        stored_route,
        Some(route),
        "the next run keeps the chosen route"
    );
}
