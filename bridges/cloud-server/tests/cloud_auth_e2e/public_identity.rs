use super::*;

#[tokio::test]
async fn signup_exposes_public_kordi_id_and_app_invites_resolve_without_auth() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool));
    let router = fast_router(state);

    let signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&unique_email("public-kordi-id"), "correct horse").await,
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

#[tokio::test]
async fn chosen_handle_replaces_the_number_and_stays_unique_ignoring_case() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "handle-owner").await;
    let (other_token, _) = signup_account(&router, "handle-other").await;

    let me = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", &owner_token))
            .await
            .unwrap(),
    )
    .await;
    let number = me["kordiId"].as_str().unwrap().to_string();
    assert_eq!(number.len(), 9);
    assert_eq!(me["accountNumber"], number);
    assert!(me["kordiIdChangeAvailableAt"].is_null());

    let invalid = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": "no_underscores" }),
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(read_json(invalid).await["errorCode"], "invalid_kordi_id");

    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..12];
    let handle = format!("Handle{suffix}");
    let set = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": format!("@{handle}") }),
        ))
        .await
        .unwrap();
    assert_eq!(set.status(), StatusCode::OK);
    let set = read_json(set).await;
    assert_eq!(set["kordiId"], handle);
    assert_eq!(set["accountNumber"], number);
    assert!(set["kordiIdChangeAvailableAt"].is_string());

    // A second change within a year is refused; repeating the same value is not.
    let locked = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": format!("{handle}x") }),
        ))
        .await
        .unwrap();
    assert_eq!(locked.status(), StatusCode::CONFLICT);
    let locked = read_json(locked).await;
    assert_eq!(locked["errorCode"], "kordi_id_change_locked");
    assert!(locked["message"]
        .as_str()
        .unwrap()
        .starts_with("You can change your Kordi ID once a year. Next change on "));
    let same = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": format!("@{handle}") }),
        ))
        .await
        .unwrap();
    assert_eq!(same.status(), StatusCode::OK);
    assert_eq!(read_json(same).await["kordiId"], handle);

    let me = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", &owner_token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(me["kordiId"], handle);
    assert!(me["kordiIdChangeAvailableAt"].is_string());

    // A display-name-only update leaves the handle alone.
    let rename = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "displayName": "Renamed" }),
        ))
        .await
        .unwrap();
    assert_eq!(rename.status(), StatusCode::OK);
    assert_eq!(read_json(rename).await["kordiId"], handle);

    for lookup in [
        format!("@{}", handle.to_lowercase()),
        handle.to_uppercase(),
        number.clone(),
    ] {
        let profile = router
            .clone()
            .oneshot(get_with_token(
                &format!("/v1/cloud/accounts/{lookup}/profile"),
                &other_token,
            ))
            .await
            .unwrap();
        assert_eq!(profile.status(), StatusCode::OK, "{lookup}");
        let profile = read_json(profile).await;
        assert_eq!(profile["accountId"], owner_id);
        assert_eq!(profile["kordiId"], handle);
        assert!(profile.get("accountNumber").is_none());
        assert!(profile.get("kordiIdChangeAvailableAt").is_none());
    }

    let taken = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &other_token,
            json!({ "kordiId": handle.to_lowercase() }),
        ))
        .await
        .unwrap();
    assert_eq!(taken.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(taken).await["errorCode"], "kordi_id_taken");

    // Clearing is a change too, so it waits for the year to pass.
    let early_clear = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": "" }),
        ))
        .await
        .unwrap();
    assert_eq!(early_clear.status(), StatusCode::CONFLICT);
    sqlx_core::query::query(
        "UPDATE cloud_accounts SET public_handle_changed_at = now() - INTERVAL '366 days' \
         WHERE account_id = $1",
    )
    .bind(&owner_id)
    .execute(&pool)
    .await
    .unwrap();

    let cleared = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "kordiId": "  " }),
        ))
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    assert_eq!(read_json(cleared).await["kordiId"], number);

    let gone = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/accounts/@{handle}/profile"),
            &other_token,
        ))
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn profile_fields_are_validated_and_birthday_stays_private() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "profile-owner").await;
    let (viewer_token, _) = signup_account(&router, "profile-viewer").await;

    let me = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", &owner_token))
            .await
            .unwrap(),
    )
    .await;
    for field in ["about", "location", "timeZone", "website", "birthday"] {
        assert!(me[field].is_null(), "{field} starts unset");
        assert!(
            me.get(field).is_some(),
            "{field} is always present for the owner"
        );
    }

    for (body, code) in [
        (json!({ "about": "a".repeat(281) }), "invalid_about"),
        (
            json!({ "location": "Line one\nLine two" }),
            "invalid_location",
        ),
        (json!({ "timeZone": "Mars/Olympus" }), "invalid_time_zone"),
        (json!({ "website": "ftp://example.com" }), "invalid_website"),
        (json!({ "birthday": "2999-01-01" }), "invalid_birthday"),
        (json!({ "birthday": "1990-02-30" }), "invalid_birthday"),
    ] {
        let response = router
            .clone()
            .oneshot(patch_json_with_token(
                "/v1/cloud/auth/me",
                &owner_token,
                body,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{code}");
        assert_eq!(read_json(response).await["errorCode"], code);
    }

    let set = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({
                "about": "  Building Kordi.  ",
                "location": "Lisbon, Portugal",
                "timeZone": "Asia/Riyadh",
                "website": "kordi.ai",
                "birthday": "1990-02-28",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(set.status(), StatusCode::OK);
    let expected = [
        ("about", "Building Kordi."),
        ("location", "Lisbon, Portugal"),
        ("timeZone", "Asia/Riyadh"),
        ("website", "https://kordi.ai/"),
        ("birthday", "1990-02-28"),
    ];
    let set = read_json(set).await;
    let me = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", &owner_token))
            .await
            .unwrap(),
    )
    .await;
    for (field, value) in expected {
        assert_eq!(set[field], value, "{field}");
        assert_eq!(me[field], value, "{field}");
    }

    let profile = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("/v1/cloud/accounts/{owner_id}/profile"),
                &viewer_token,
            ))
            .await
            .unwrap(),
    )
    .await;
    for (field, value) in &expected[..4] {
        assert_eq!(profile[field], *value, "{field}");
    }
    assert!(profile.get("birthday").is_none());
    assert!(profile.get("accountNumber").is_none());

    // Absent fields stay; null and blank clear.
    let cleared = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner_token,
            json!({ "about": null, "website": "   ", "birthday": null }),
        ))
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let cleared = read_json(cleared).await;
    assert!(cleared["about"].is_null());
    assert!(cleared["website"].is_null());
    assert!(cleared["birthday"].is_null());
    assert_eq!(cleared["location"], "Lisbon, Portugal");
    assert_eq!(cleared["timeZone"], "Asia/Riyadh");
}
