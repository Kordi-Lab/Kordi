//! Web provider sign-ins finish only in the browser that started them, and
//! replace the web session they started from.

use super::*;
use crate::auth::routes::web_session_handlers::{
    browser_binding_matches, web_oauth_success, WEB_OAUTH_BIND_COOKIE, WEB_OAUTH_COMPLETE_PATH,
    WEB_SESSION_COOKIE,
};

fn configure_github() {
    std::env::set_var("KORDI_OAUTH_GITHUB_CLIENT_ID", "synthetic-web-start-client");
    std::env::set_var(
        "KORDI_OAUTH_GITHUB_CLIENT_SECRET",
        "synthetic-web-start-secret",
    );
}

fn set_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .find(|cookie| cookie.starts_with(&format!("{name}=")))
}

fn provider_state(location: &str) -> String {
    url::Url::parse(location)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap()
}

/// Start a web provider sign-in; returns the provider state and the
/// binding cookie value.
async fn web_start(harness: &Harness, cookies: Vec<(String, String)>) -> (String, String) {
    let (status, body, headers) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/oauth/github/start?returnTo=%2Fsign-in%2Fapp",
            cookies,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let bind = set_cookie(&headers, WEB_OAUTH_BIND_COOKIE).expect("binding cookie");
    for attribute in [
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=600",
    ] {
        assert!(bind.contains(attribute), "{bind}");
    }
    assert!(!bind.contains("Domain="));
    let value = bind
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string();
    let location = headers.get("location").unwrap().to_str().unwrap();
    (provider_state(location), value)
}

async fn callback(harness: &Harness, state: &str, cookie: Option<&str>) -> (StatusCode, HeaderMap) {
    let headers = cookie
        .map(|value| vec![("Cookie".to_string(), value.to_string())])
        .unwrap_or_default();
    let (status, _, headers) = harness
        .send_with(
            "GET",
            &format!("/v1/cloud/auth/oauth/github/callback?state={state}&code=synthetic"),
            headers,
            None,
        )
        .await;
    (status, headers)
}

fn assert_browser_mismatch(status: StatusCode, headers: &HeaderMap) {
    assert!(status.is_redirection(), "{status}");
    let location = headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.starts_with(&format!(
            "{}{WEB_OAUTH_COMPLETE_PATH}",
            crate::distribution::public_origin()
        )),
        "{location}"
    );
    assert!(location.contains("oauth_browser_mismatch"), "{location}");
    assert!(set_cookie(headers, WEB_SESSION_COOKIE).is_none());
    assert!(set_cookie(headers, WEB_OAUTH_BIND_COOKIE)
        .unwrap()
        .contains("Max-Age=0"));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_callback_without_the_starting_browsers_cookie_signs_nobody_in() {
    configure_github();
    let harness = harness().await;

    // Someone else's callback URL, opened in a browser without the cookie.
    let (state, _) = web_start(&harness, vec![]).await;
    let (status, headers) = callback(&harness, &state, None).await;
    assert_browser_mismatch(status, &headers);
    // The state is used up.
    let (status, headers) = callback(&harness, &state, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(set_cookie(&headers, WEB_SESSION_COOKIE).is_none());

    // A browser holding a binding cookie from its own, different start.
    let (state, _) = web_start(&harness, vec![]).await;
    let (_, own_binding) = web_start(&harness, vec![]).await;
    let (status, headers) = callback(
        &harness,
        &state,
        Some(&format!("{WEB_OAUTH_BIND_COOKIE}={own_binding}")),
    )
    .await;
    assert_browser_mismatch(status, &headers);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_starting_browsers_cookie_matches_its_state() {
    configure_github();
    let harness = harness().await;
    let (state, binding) = web_start(&harness, vec![]).await;
    let stored: (Option<String>,) =
        query_as("SELECT browser_binding_hash FROM cloud_oauth_states WHERE state_id = $1")
            .bind(&state)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert!(stored.0.as_deref().is_some_and(|hash| hash != binding));
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("{WEB_OAUTH_BIND_COOKIE}={binding}")
            .parse()
            .unwrap(),
    );
    assert!(browser_binding_matches(&headers, stored.0.as_deref()));
    assert!(!browser_binding_matches(&headers, None));
    assert!(!browser_binding_matches(
        &HeaderMap::new(),
        stored.0.as_deref()
    ));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_legacy_start_cannot_reach_the_web_cookie_hand_off() {
    configure_github();
    let harness = harness().await;
    let origin = crate::distribution::public_origin();
    let complete = format!("{origin}{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2Fsign-in%2Fapp");
    let start = |target: &str| {
        format!(
            "/v1/cloud/auth/oauth/github/start?redirectAfter={}",
            url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>()
        )
    };
    // A page on this server could read a session from the URL fragment, so
    // only the web start, which binds the browser, may return here.
    for target in [
        format!("{origin}/"),
        format!("{origin}/sign-in/app"),
        complete.clone(),
    ] {
        let (status, body, _) = harness.send("GET", &start(&target), None, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{target} {body}");
        assert_eq!(body["errorCode"], "invalid_redirect", "{body}");
    }
    // A stored state for this server without a usable web return, or
    // without a binding, never hands over a session.
    for (target, expect_mismatch) in [
        (
            format!("{origin}{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2F%2Fevil.example.test"),
            false,
        ),
        (complete.clone(), true),
    ] {
        let state = format!("oauth_state_{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        query(
            "INSERT INTO cloud_oauth_states \
             (state_id, provider, redirect_after, code_verifier, created_at, expires_at) \
             VALUES ($1, 'github', $2, 'verifier', $3, $4)",
        )
        .bind(&state)
        .bind(&target)
        .bind(now.to_rfc3339())
        .bind((now + ChronoDuration::minutes(10)).to_rfc3339())
        .execute(&harness.pool)
        .await
        .unwrap();
        let (status, headers) = callback(
            &harness,
            &state,
            Some(&format!("{WEB_OAUTH_BIND_COOKIE}=anything")),
        )
        .await;
        if expect_mismatch {
            assert_browser_mismatch(status, &headers);
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "{target}");
            assert!(headers.get("location").is_none());
            assert!(set_cookie(&headers, WEB_SESSION_COOKIE).is_none());
        }
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_web_provider_sign_in_replaces_the_cookie_session() {
    configure_github();
    let harness = harness().await;
    let account = harness.web_account().await;
    let (state, _) = web_start(
        &harness,
        vec![(
            "Cookie".to_string(),
            format!("{WEB_SESSION_COOKIE}={}", account.web_token),
        )],
    )
    .await;
    let replaces: (Option<String>,) =
        query_as("SELECT replaces_session_token_id FROM cloud_oauth_states WHERE state_id = $1")
            .bind(&state)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    let replaces = replaces.0.expect("the cookie session is recorded");
    let response = web_oauth_success(
        &harness.pool,
        "kordi_cs_synthetic_new_session",
        &format!("{}/sign-in/app", crate::distribution::public_origin()),
        Some(&replaces),
    )
    .await;
    assert!(response.status().is_redirection());
    assert_eq!(
        harness.me_status(&account.web_token).await,
        StatusCode::UNAUTHORIZED
    );
}
