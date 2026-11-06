//! Sign in with Apple through the browser: Apple's cross-site form post is
//! stored with its state and handed to the `GET` callback, which still
//! requires the starting browser's binding cookie.

use super::*;
use crate::auth::oauth::apple::test_support::configure_env;
use crate::auth::routes::web_session_handlers::{
    WEB_OAUTH_BIND_COOKIE, WEB_OAUTH_COMPLETE_PATH, WEB_SESSION_COOKIE,
};

fn query_value(url: &str, name: &str) -> Option<String> {
    let parsed = url::Url::parse(url)
        .or_else(|_| url::Url::parse(&format!("http://relative.invalid{url}")))
        .unwrap();
    parsed
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn location(headers: &HeaderMap) -> String {
    headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string()
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .find(|cookie| cookie.starts_with(&format!("{name}=")))
        .and_then(|cookie| {
            cookie
                .split(';')
                .next()
                .and_then(|pair| pair.split_once('='))
                .map(|(_, value)| value.to_string())
        })
}

async fn post_form(harness: &Harness, pairs: &[(&str, &str)]) -> (StatusCode, Value, HeaderMap) {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    harness
        .send_with(
            "POST",
            "/v1/cloud/auth/oauth/apple/callback",
            vec![(
                "Origin".to_string(),
                "https://appleid.apple.com".to_string(),
            )],
            Some(("application/x-www-form-urlencoded", body)),
        )
        .await
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn apple_is_offered_and_starts_a_form_post_sign_in() {
    configure_env();
    let harness = harness().await;
    let (status, body, _) = harness
        .send("GET", "/v1/cloud/auth/capabilities", None, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["oauthProviders"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider == "apple"));

    let (status, body, _) = harness
        .send(
            "GET",
            &format!(
                "/v1/cloud/auth/oauth/apple/start?redirectAfter={}",
                url::form_urlencoded::byte_serialize(LOOPBACK.as_bytes()).collect::<String>()
            ),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let auth_url = body["authUrl"].as_str().unwrap();
    assert!(auth_url.starts_with("https://appleid.apple.com/auth/authorize?"));
    assert!(auth_url.contains("response_mode=form_post"), "{auth_url}");
    assert!(auth_url.contains("scope=name%20email"), "{auth_url}");
    assert!(!auth_url.contains("code_challenge"), "{auth_url}");
    let state = query_value(auth_url, "state").unwrap();
    let (verifier,): (Option<String>,) =
        query_as("SELECT code_verifier FROM cloud_oauth_states WHERE state_id = $1")
            .bind(&state)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    assert_eq!(
        query_value(auth_url, "nonce").unwrap(),
        crate::auth::oauth::apple::web_nonce(&verifier.unwrap())
    );
    assert!(query_value(auth_url, "redirect_uri")
        .unwrap()
        .ends_with("/v1/cloud/auth/oauth/apple/callback"));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_form_post_is_kept_once_and_handed_to_the_get_callback() {
    configure_env();
    let harness = harness().await;
    let (_, body, _) = harness
        .send(
            "GET",
            &format!(
                "/v1/cloud/auth/oauth/apple/start?redirectAfter={}",
                url::form_urlencoded::byte_serialize(LOOPBACK.as_bytes()).collect::<String>()
            ),
            None,
            None,
        )
        .await;
    let state = query_value(body["authUrl"].as_str().unwrap(), "state").unwrap();
    let user = r#"{"name":{"firstName":"Ada","lastName":"Lovelace"}}"#;

    let (status, _, headers) = post_form(
        &harness,
        &[("state", &state), ("code", "apple-code"), ("user", user)],
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    let target = location(&headers);
    assert!(
        target.starts_with("/v1/cloud/auth/oauth/apple/callback?"),
        "{target}"
    );
    assert_eq!(
        query_value(&target, "state").as_deref(),
        Some(state.as_str())
    );
    assert_eq!(query_value(&target, "code"), None);
    let stored: (Option<String>, Option<String>) = query_as(
        "SELECT form_post_code, form_post_user FROM cloud_oauth_states WHERE state_id = $1",
    )
    .bind(&state)
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(stored.0.as_deref(), Some("apple-code"));
    assert_eq!(stored.1.as_deref(), Some(user));

    // A second post for the same state, or an unknown state, is refused.
    let (status, body, _) = post_form(&harness, &[("state", &state), ("code", "other")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "invalid_oauth_state");
    let (status, _, _) =
        post_form(&harness, &[("state", "oauth_state_unknown"), ("code", "c")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = post_form(&harness, &[("code", "c")]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_apple_code_in_the_get_url_is_ignored() {
    configure_env();
    let harness = harness().await;
    let (_, body, _) = harness
        .send(
            "GET",
            &format!(
                "/v1/cloud/auth/oauth/apple/start?redirectAfter={}",
                url::form_urlencoded::byte_serialize(LOOPBACK.as_bytes()).collect::<String>()
            ),
            None,
            None,
        )
        .await;
    let state = query_value(body["authUrl"].as_str().unwrap(), "state").unwrap();
    let (status, _, headers) = harness
        .send(
            "GET",
            &format!("/v1/cloud/auth/oauth/apple/callback?state={state}&code=injected"),
            None,
            None,
        )
        .await;
    assert!(status.is_redirection());
    let target = location(&headers);
    assert!(target.starts_with(LOOPBACK), "{target}");
    assert!(
        target.contains("kordi_cloud_oauth_error=Missing%20OAuth%20code."),
        "{target}"
    );
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_web_sign_in_keeps_its_browser_binding_across_the_form_post() {
    configure_env();
    let harness = harness().await;
    let (status, _, headers) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/oauth/apple/start?returnTo=%2Flogin%3Fclient_id%3Dkordi-ios%26state%3Dapp-state",
            vec![],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let binding = cookie_value(&headers, WEB_OAUTH_BIND_COOKIE).unwrap();
    let state = query_value(&location(&headers), "state").unwrap();

    // Apple's cross-site post carries no cookie; the user canceled.
    let (status, _, headers) = post_form(
        &harness,
        &[("state", &state), ("error", "user_cancelled_authorize")],
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let next = location(&headers);

    // The redirected navigation carries the Lax binding cookie again.
    let (status, _, headers) = harness
        .send_with(
            "GET",
            &next,
            vec![(
                "Cookie".to_string(),
                format!("{WEB_OAUTH_BIND_COOKIE}={binding}"),
            )],
            None,
        )
        .await;
    assert!(status.is_redirection());
    let target = location(&headers);
    assert!(
        target.contains(WEB_OAUTH_COMPLETE_PATH),
        "a canceled web sign-in returns to the page: {target}"
    );
    assert!(target.contains("Sign-in%20was%20canceled."), "{target}");
    assert!(!target.contains("oauth_browser_mismatch"), "{target}");
    assert!(cookie_value(&headers, WEB_SESSION_COOKIE).is_none());

    // The login page of the app hand-off gets the browser back, query intact.
    let without_fragment = target.split('#').next().unwrap();
    assert_eq!(
        query_value(without_fragment, "returnTo").as_deref(),
        Some("/login?client_id=kordi-ios&state=app-state")
    );
    let (status, _, headers) = harness
        .send_with("GET", without_fragment, vec![], None)
        .await;
    assert!(status.is_redirection());
    assert!(location(&headers).ends_with("/login?client_id=kordi-ios&state=app-state"));
}
