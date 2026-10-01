use super::*;

use std::net::SocketAddr;

use axum::extract::ConnectInfo;

fn login_from(email: &str, password: &str, peer: &str, forwarded: Option<&str>) -> Request<Body> {
    let mut request = post(
        "/v1/cloud/auth/login",
        Body::from(json!({ "email": email, "password": password }).to_string()),
    );
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    if let Some(forwarded) = forwarded {
        request
            .headers_mut()
            .insert("x-real-ip", forwarded.parse().unwrap());
    }
    request
}

async fn signup_with_email(router: &axum::Router, email: &str) {
    let response = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(email, "correct horse"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn password_signup_leaves_the_email_unverified() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("unverified-signup");
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    signup_with_email(&router, &email).await;

    let (verified_at,): (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT primary_email_verified_at FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(verified_at, None);
}

#[tokio::test]
async fn failed_logins_lock_only_the_failing_client() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("lockout-owner");
    let router = fast_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    signup_with_email(&router, &email).await;
    let proxy = "127.0.0.1:40000";

    for _ in 0..5 {
        let response = router
            .clone()
            .oneshot(login_from(
                &email,
                "wrong horse",
                proxy,
                Some("203.0.113.10"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let locked = router
        .clone()
        .oneshot(login_from(
            &email,
            "correct horse",
            proxy,
            Some("203.0.113.10"),
        ))
        .await
        .unwrap();
    assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(read_json(locked).await["errorCode"], "rate_limited");

    let owner = router
        .clone()
        .oneshot(login_from(
            &email,
            "correct horse",
            proxy,
            Some("203.0.113.11"),
        ))
        .await
        .unwrap();
    assert_eq!(
        owner.status(),
        StatusCode::OK,
        "failures from one client must not lock out the owner's address"
    );
}

#[tokio::test]
async fn email_wide_failures_lock_new_addresses_but_not_familiar_ones() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("lockout-familiar");
    let router = fast_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    signup_with_email(&router, &email).await;
    let proxy = "127.0.0.1:40000";
    let login = |password: &str, client: &str| {
        router
            .clone()
            .oneshot(login_from(&email, password, proxy, Some(client)))
    };

    let familiar = login("correct horse", "203.0.113.20").await.unwrap();
    assert_eq!(familiar.status(), StatusCode::OK);

    // The test limiter's email-wide ceiling is 50: five failures from each of
    // ten addresses, each below its own per-address limit until the last try.
    for client in 1..=10 {
        for _ in 0..5 {
            let response = login("wrong horse", &format!("198.51.100.{client}"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    let new_address = login("correct horse", "198.51.100.200").await.unwrap();
    assert_eq!(
        new_address.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "addresses that never signed in are locked once the ceiling is reached"
    );
    assert!(new_address.headers().contains_key("retry-after"));

    let owner = login("correct horse", "203.0.113.20").await.unwrap();
    assert_eq!(
        owner.status(),
        StatusCode::OK,
        "an address that already signed in keeps working"
    );
}

#[tokio::test]
async fn forwarded_addresses_from_untrusted_peers_are_ignored() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("lockout-direct");
    let router = fast_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    signup_with_email(&router, &email).await;
    let public_peer = "198.51.100.20:40000";

    for index in 0..5 {
        let forwarded = format!("203.0.113.{}", 30 + index);
        let response = router
            .clone()
            .oneshot(login_from(
                &email,
                "wrong horse",
                public_peer,
                Some(&forwarded),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let still_locked = router
        .clone()
        .oneshot(login_from(
            &email,
            "correct horse",
            public_peer,
            Some("203.0.113.99"),
        ))
        .await
        .unwrap();
    assert_eq!(
        still_locked.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "a direct client cannot choose a new address with X-Real-IP"
    );
}

#[tokio::test]
async fn contact_adds_are_budgeted_per_account() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool, EventBus::noop())));
    let (token, _) = signup_account(&router, "contact-budget").await;
    let (_, peer_account_id) = signup_account(&router, "contact-budget-peer").await;
    let add = || {
        post_json_with_token(
            "/v1/cloud/contacts",
            &token,
            json!({ "peerAccountId": peer_account_id }),
        )
    };

    for _ in 0..100 {
        let response = router.clone().oneshot(add()).await.unwrap();
        // The one-sided add now sends (or repeats) a contact request.
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
    let limited = router.clone().oneshot(add()).await.unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(read_json(limited).await["errorCode"], "rate_limited");

    let request = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/contacts/requests",
            &token,
            json!({ "peerAccountId": peer_account_id }),
        ))
        .await
        .unwrap();
    assert_eq!(
        request.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "contact requests share the contact budget"
    );
}
