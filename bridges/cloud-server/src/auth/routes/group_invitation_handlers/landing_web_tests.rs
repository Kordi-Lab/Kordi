//! The signed-in `/g/<token>` form continuing in the browser application,
//! against a disposable PostgreSQL database at `$DATABASE_URL`. Run with
//! `--ignored`.

use super::pending_tests::{cookie_request, harness};
use super::*;
use crate::auth::routes::web_session_handlers::web_csrf_token;
use axum::body::Body;

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn continue_on_the_web_claims_with_the_csrf_token_and_opens_only_the_web_app() {
    let h = harness().await;
    let (admin, member, friend) = (
        h.account("Maya Chen").await,
        h.account("Ethan").await,
        h.account("Ana Silva").await,
    );
    let group = h.group(&admin, &member).await;
    let origin = crate::distribution::public_origin();
    let csrf = web_csrf_token(&friend.token);
    let page = format!("/g/{}", group.token);
    let post = |origin: Option<&str>, body: String| {
        let mut request = cookie_request("POST", &page, &friend.token)
            .header("Content-Type", "application/x-www-form-urlencoded");
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        request.body(Body::from(body)).unwrap()
    };

    // The web choice needs the same exact Origin and CSRF token as the app.
    for (origin, body) in [
        (Some(origin.as_str()), "continue=web".to_string()),
        (Some(origin.as_str()), "csrf=wrong&continue=web".to_string()),
        (None, format!("csrf={csrf}&continue=web")),
        (
            Some("https://evil.example.test"),
            format!("csrf={csrf}&continue=web"),
        ),
    ] {
        let (status, headers, _) = h.request(post(origin, body.clone())).await;
        assert!(
            matches!(
                status,
                StatusCode::FORBIDDEN | StatusCode::UNPROCESSABLE_ENTITY
            ),
            "{body}: {status}"
        );
        assert!(headers.get("location").is_none(), "{body}");
    }
    assert!(
        h.pending(&friend).await.is_empty(),
        "refused posts claim nothing"
    );

    let (status, headers, _) = h
        .request(post(Some(&origin), format!("csrf={csrf}&continue=web")))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers.get("location").unwrap(), "/app/");
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    assert_eq!(h.pending(&friend).await.len(), 1, "the web choice claims");

    // A destination the server does not know opens the app, never elsewhere.
    for choice in [
        "app",
        "https%3A%2F%2Fevil.example.test%2F",
        "%2F%2Fevil",
        "",
    ] {
        let (status, headers, _) = h
            .request(post(
                Some(&origin),
                format!("csrf={csrf}&continue={choice}"),
            ))
            .await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{choice}");
        assert_eq!(
            headers.get("location").unwrap(),
            group_invite_deep_link(&group.token).as_str(),
            "{choice}"
        );
    }
    assert_eq!(h.pending(&friend).await.len(), 1, "claims stay idempotent");
}
