//! Google and GitHub sign-in for Kordi web pages.
//!
//! The start link sets a short-lived, random browser binding cookie and the
//! provider state stores its SHA-256. The callback installs a web session
//! only in the browser that holds the matching cookie, so a callback URL
//! from someone else's sign-in cannot plant their session in this browser
//! (login CSRF).

use super::*;

/// Binds a web provider sign-in to the browser that started it. `Lax`, so
/// the provider's top-level redirect back to the callback carries it.
pub const WEB_OAUTH_BIND_COOKIE: &str = "__Host-kordi_oauth_bind";
const WEB_OAUTH_BIND_MAX_AGE_SECS: i64 = 10 * 60;
pub(in crate::auth::routes) const OAUTH_BROWSER_MISMATCH: &str = "oauth_browser_mismatch";

/// What a web start records with the provider state.
pub(in crate::auth::routes) struct WebOAuthStart {
    pub browser_binding_hash: String,
    /// The web session this sign-in will replace in the cookie.
    pub replaces_session_token_id: Option<String>,
}

fn binding_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"kordi-oauth-browser-binding\0");
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn random_binding() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn bind_cookie(value: Option<&str>) -> String {
    let (value, max_age) = match value {
        Some(value) => (value, WEB_OAUTH_BIND_MAX_AGE_SECS),
        None => ("", 0),
    };
    format!(
        "{WEB_OAUTH_BIND_COOKIE}={value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={max_age}"
    )
}

fn with_bind_cookie(mut response: Response, value: Option<&str>) -> Response {
    if let Ok(cookie) = bind_cookie(value).parse() {
        response
            .headers_mut()
            .append(axum::http::header::SET_COOKIE, cookie);
    }
    super::super::app_sign_in_handlers::no_store(response)
}

/// Whether the request carries the binding cookie of the stored hash.
pub(in crate::auth::routes) fn browser_binding_matches(
    headers: &HeaderMap,
    stored_hash: Option<&str>,
) -> bool {
    match (cookie_value(headers, WEB_OAUTH_BIND_COOKIE), stored_hash) {
        (Some(value), Some(stored)) if !value.is_empty() => {
            constant_time_eq(&binding_hash(&value), stored)
        }
        _ => false,
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::auth::routes) struct WebReturnQuery {
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
}

fn web_oauth_complete_url(return_to: &str) -> String {
    super::super::app_sign_in_handlers::redirect_uri_with(
        &format!(
            "{}{WEB_OAUTH_COMPLETE_PATH}",
            crate::distribution::public_origin()
        ),
        &[("returnTo", return_to)],
    )
}

/// `GET /v1/cloud/auth/web/oauth/:provider/start?returnTo=<path>`: Google or
/// GitHub sign-in for web pages. The callback sets the session cookie and
/// returns to `returnTo` without putting the session in the URL.
pub(in crate::auth::routes) async fn web_oauth_start(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    Query(query): Query<WebReturnQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(return_to) = sanitize_return_to(query.return_to.as_deref()) else {
        return err(
            "invalid_redirect",
            "The return path is not allowed.",
            StatusCode::BAD_REQUEST,
        );
    };
    let path = &return_to[crate::distribution::public_origin().len()..];
    let start_query = OAuthStartQuery {
        redirect_after: web_oauth_complete_url(path),
        device_name: None,
        device_platform: None,
        device_os_version: None,
        device_app_version: None,
        device_approximate_location: None,
        device_public_key: None,
        device_key_algorithm: None,
    };
    let binding = random_binding();
    // The page's own link sends the strict session cookie; a link from
    // another site does not, so it can never name a session to replace.
    let previous = cookie_value(&headers, WEB_SESSION_COOKIE);
    let web = WebOAuthStart {
        browser_binding_hash: binding_hash(&binding),
        replaces_session_token_id: web_session_token_id(state.db_pool(), previous.as_deref()).await,
    };
    // The page opens this link directly, so send the browser to the provider.
    match oauth_authorization_url(&state, &provider, &start_query, Some(&web)).await {
        Ok(auth_url) => with_bind_cookie(Redirect::to(&auth_url).into_response(), Some(&binding)),
        Err(response) => *response,
    }
}

/// For a provider callback: when the sign-in was started by
/// [`web_oauth_start`], the page to return to.
pub(in crate::auth::routes) fn web_oauth_return_to(redirect_after: &str) -> Option<String> {
    let url = url::Url::parse(redirect_after).ok()?;
    let base = url::Url::parse(&crate::distribution::public_origin()).ok()?;
    if url.origin() != base.origin() || url.path() != WEB_OAUTH_COMPLETE_PATH {
        return None;
    }
    let return_to = url
        .query_pairs()
        .find(|(key, _)| key == "returnTo")
        .map(|(_, value)| value.into_owned());
    sanitize_return_to(return_to.as_deref())
}

/// The provider callback's response for a web sign-in: end the session it
/// replaces, set the cookie, clear the binding, and return to the page.
pub(in crate::auth::routes) async fn web_oauth_success(
    pool: &PgPool,
    session_token: &str,
    return_to: &str,
    replaces_session_token_id: Option<&str>,
) -> Response {
    // The new session was just issued, so it is never the one replaced.
    revoke_replaced_web_session(pool, replaces_session_token_id).await;
    let response = with_cookies(Redirect::to(return_to).into_response(), Some(session_token));
    with_bind_cookie(response, None)
}

/// The provider callback's response when the browser does not hold the
/// binding cookie of a web start: no session, back to the page with an
/// error.
pub(in crate::auth::routes) fn web_oauth_binding_rejected(redirect_after: &str) -> Response {
    let response = redirect_with_oauth_error_code(
        redirect_after,
        OAUTH_BROWSER_MISMATCH,
        "This sign-in was started in another browser. Start it again here.",
    );
    with_bind_cookie(response, None)
}

/// `GET /v1/cloud/auth/web/oauth/complete`: where a failed web provider
/// sign-in lands. It sends the browser back to `returnTo`; the browser
/// keeps the error fragment.
pub(in crate::auth::routes) async fn web_oauth_complete(
    Query(query): Query<WebReturnQuery>,
) -> Response {
    let target = sanitize_return_to(query.return_to.as_deref())
        .or_else(|| sanitize_return_to(None))
        .unwrap_or_else(|| "/".to_string());
    super::super::app_sign_in_handlers::no_store(Redirect::to(&target).into_response())
}
