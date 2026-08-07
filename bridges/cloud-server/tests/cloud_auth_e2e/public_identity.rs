use super::*;

#[tokio::test]
async fn signup_exposes_public_kordi_id_and_app_invites_resolve_without_auth() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("public-kordi-id"), "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(signup.status(), StatusCode::CREATED);
    let signup_body = read_json(signup).await;
    let token = signup_body["session"]["token"].as_str().unwrap();
    let account_id = signup_body["account"]["accountId"].as_str().unwrap();
    let kordi_id = signup_body["account"]["kordiId"].as_str().unwrap();
    assert_eq!(kordi_id.len(), 9);
    assert!(kordi_id.chars().all(|ch| ch.is_ascii_digit()));

    let profile = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/accounts/{kordi_id}/profile"),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(profile.status(), StatusCode::OK);
    let profile_body = read_json(profile).await;
    assert_eq!(profile_body["accountId"], account_id);
    assert_eq!(profile_body["kordiId"], kordi_id);

    let create_invite = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/invitations/app", token))
        .await
        .unwrap();
    assert_eq!(create_invite.status(), StatusCode::OK);
    let invitation = read_json(create_invite).await;
    let invite_url = invitation["inviteUrl"].as_str().unwrap();
    let invite_token = invite_url.rsplit('/').next().unwrap();
    assert!(invite_token.starts_with("kordi_ai_"));

    let resolve = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/cloud/invitations/app/resolve/{invite_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resolve.status(), StatusCode::OK);
    let resolved = read_json(resolve).await;
    assert_eq!(resolved["inviter"]["kordiId"], kordi_id);
    assert_eq!(resolved["inviter"]["displayName"], "E2E");

    let landing = router
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/i/{invite_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(landing.status(), StatusCode::OK);
    assert_eq!(
        landing.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    let landing_body = to_bytes(landing.into_body(), 64 * 1024).await.unwrap();
    let landing_html = String::from_utf8(landing_body.to_vec()).unwrap();
    assert!(landing_html.contains("E2E invited you to Kordi"));
    assert!(landing_html.contains(&format!("@{kordi_id}")));
    assert!(!landing_html.contains(account_id));
}
