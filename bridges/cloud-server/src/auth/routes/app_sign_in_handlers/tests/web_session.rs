//! Cookie-held web sessions for the sign-in page.

use super::*;
use crate::auth::routes::web_session_handlers::{
    sanitize_return_to, web_csrf_token, web_oauth_return_to, WEB_CSRF_COOKIE, WEB_CSRF_HEADER,
    WEB_OAUTH_COMPLETE_PATH, WEB_SESSION_COOKIE,
};

const PASSWORD: &str = "synthetic-Password-42!";

async fn password_account(harness: &Harness) -> String {
    let email = format!("web-{}@example.test", uuid::Uuid::new_v4().simple());
    let account_id = format!("acct_web_{}", uuid::Uuid::new_v4().simple());
    let hash =
        crate::auth::password::hash_password(PASSWORD, PasswordHasherConfig::for_tests()).unwrap();
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, password_hash, created_at, updated_at, \
          avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, \
          avatar_updated_at) \
         VALUES ($1, 'Web tester', $2, $3, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
    )
    .bind(&account_id)
    .bind(&email)
    .bind(hash)
    .bind(&now)
    .execute(&harness.pool)
    .await
    .unwrap();
    email
}

fn set_cookies(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect()
}

fn cookie_value(cookies: &[String], name: &str) -> String {
    cookies
        .iter()
        .find_map(|cookie| cookie.strip_prefix(&format!("{name}=")))
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_string()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn web_login_keeps_the_session_out_of_page_scripts() {
    let harness = harness().await;
    let email = password_account(&harness).await;
    let login = serde_json::json!({ "email": email, "password": PASSWORD }).to_string();
    let origin = ("Origin".to_string(), crate::distribution::public_origin());

    // Without the exact public origin, the request is refused.
    for headers in [
        vec![],
        vec![(
            "Origin".to_string(),
            "https://evil.example.test".to_string(),
        )],
    ] {
        let (status, body, _) = harness
            .send_with(
                "POST",
                "/v1/cloud/auth/web/login",
                headers,
                Some(("application/json", login.clone())),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "origin_mismatch");
    }
    let (status, body, _) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/web/signup",
            vec![],
            Some(("application/json", "{}".to_string())),
        )
        .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::UNPROCESSABLE_ENTITY,
        "{status} {body}"
    );

    let (status, body, headers) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/web/login",
            vec![origin.clone()],
            Some(("application/json", login.clone())),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["session"].get("token").is_none(), "{body}");
    assert!(!body.to_string().contains("kordi_cs_"));
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    let cookies = set_cookies(&headers);
    let session_cookie = cookies
        .iter()
        .find(|cookie| cookie.starts_with(&format!("{WEB_SESSION_COOKIE}=")))
        .unwrap();
    for attribute in [
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=",
    ] {
        assert!(session_cookie.contains(attribute), "{session_cookie}");
    }
    assert!(!session_cookie.contains("Domain="));
    let csrf_cookie = cookies
        .iter()
        .find(|cookie| cookie.starts_with(&format!("{WEB_CSRF_COOKIE}=")))
        .unwrap();
    assert!(!csrf_cookie.contains("HttpOnly"));
    assert!(csrf_cookie.contains("Secure") && csrf_cookie.contains("SameSite=Strict"));

    let session = cookie_value(&cookies, WEB_SESSION_COOKIE);
    let csrf = cookie_value(&cookies, WEB_CSRF_COOKIE);
    assert_eq!(csrf, web_csrf_token(&session));
    assert_eq!(body["csrfToken"], csrf);

    // The page reads its account and CSRF token from the cookie session.
    let cookie_header = (
        "Cookie".to_string(),
        format!("{WEB_SESSION_COOKIE}={session}"),
    );
    let (status, status_body, _) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/session",
            vec![cookie_header.clone()],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{status_body}");
    assert_eq!(status_body["csrfToken"], csrf);
    assert!(status_body["account"]["accountId"].is_string());
    let (status, _, _) = harness
        .send_with("GET", "/v1/cloud/auth/web/session", vec![], None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The cookie session can authorize an app.
    let pkce = pkce();
    harness.code(&session, DESKTOP, LOOPBACK, &pkce).await;

    // Sign-out needs the CSRF token too, then clears both cookies.
    let (status, body, _) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/web/logout",
            vec![cookie_header.clone(), origin.clone()],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _, headers) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/web/logout",
            vec![
                cookie_header.clone(),
                origin,
                (WEB_CSRF_HEADER.to_string(), csrf),
            ],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cleared = set_cookies(&headers);
    assert_eq!(cleared.len(), 2);
    assert!(cleared.iter().all(|cookie| cookie.contains("Max-Age=0")));
    let (status, _, _) = harness
        .send_with(
            "GET",
            "/v1/cloud/auth/web/session",
            vec![cookie_header],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn failed_web_provider_sign_in_returns_to_the_page() {
    let harness = harness().await;
    let (status, _, headers) = harness
        .send(
            "GET",
            &format!("{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2Fsign-in%2Fapp%3Fstate%3Ds"),
            None,
            None,
        )
        .await;
    assert!(status.is_redirection());
    assert_eq!(
        headers.get("location").unwrap(),
        &format!(
            "{}/sign-in/app?state=s",
            crate::distribution::public_origin()
        )
    );
    for unsafe_target in ["%2F%2Fevil.example.test", "https%3A%2F%2Fevil.example.test"] {
        let (_, _, headers) = harness
            .send(
                "GET",
                &format!("{WEB_OAUTH_COMPLETE_PATH}?returnTo={unsafe_target}"),
                None,
                None,
            )
            .await;
        let location = headers.get("location").unwrap().to_str().unwrap();
        assert!(
            location.starts_with(&crate::distribution::public_origin()),
            "{location}"
        );
    }
    let (status, body, _) = harness
        .send(
            "GET",
            "/v1/cloud/auth/web/oauth/google/start?returnTo=https%3A%2F%2Fevil.example.test",
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn web_provider_start_sends_the_browser_to_the_provider() {
    std::env::set_var("KORDI_OAUTH_GITHUB_CLIENT_ID", "synthetic-web-start-client");
    std::env::set_var(
        "KORDI_OAUTH_GITHUB_CLIENT_SECRET",
        "synthetic-web-start-secret",
    );
    let harness = harness().await;
    let (status, body, headers) = harness
        .send(
            "GET",
            "/v1/cloud/auth/web/oauth/github/start?returnTo=%2Faccount",
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let location = headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.starts_with("https://github.com/login/oauth/authorize?"),
        "{location}"
    );
    assert!(
        location.contains("client_id=synthetic-web-start-client"),
        "{location}"
    );
    assert!(
        location.contains("code_challenge_method=S256"),
        "{location}"
    );
    assert_eq!(
        headers.get("cache-control").unwrap().to_str().unwrap(),
        "no-store"
    );
}

#[test]
fn return_paths_stay_on_the_public_origin() {
    let origin = crate::distribution::public_origin();
    assert_eq!(
        sanitize_return_to(None).unwrap(),
        format!("{origin}/sign-in/app")
    );
    assert_eq!(
        sanitize_return_to(Some("/sign-in/app?client_id=kordi-ios")).unwrap(),
        format!("{origin}/sign-in/app?client_id=kordi-ios")
    );
    for unsafe_path in [
        "//evil.example.test/x",
        "https://evil.example.test/",
        "/\\evil.example.test",
        "sign-in/app",
        "/sign-in#token",
        "/sign-in\napp",
        "",
    ] {
        assert!(
            sanitize_return_to(Some(unsafe_path)).is_none(),
            "{unsafe_path:?}"
        );
    }
}

#[test]
fn only_web_starts_get_a_cookie_from_the_provider_callback() {
    let origin = crate::distribution::public_origin();
    assert_eq!(
        web_oauth_return_to(&format!(
            "{origin}{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2Fsign-in%2Fapp"
        ))
        .unwrap(),
        format!("{origin}/sign-in/app")
    );
    for other in [
        // Existing app and web flows keep their fragment hand-off.
        "http://127.0.0.1:53682/oauth/callback".to_string(),
        format!("{origin}/"),
        format!("{origin}/sign-in/app"),
        format!("https://evil.example.test{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2F"),
        format!("{origin}{WEB_OAUTH_COMPLETE_PATH}?returnTo=%2F%2Fevil.example.test"),
    ] {
        assert!(web_oauth_return_to(&other).is_none(), "{other}");
    }
}
