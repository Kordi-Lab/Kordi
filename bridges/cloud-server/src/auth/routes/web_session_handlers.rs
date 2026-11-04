//! Cookie-held sessions for Kordi web pages, such as the app sign-in page.
//!
//! The session token lives only in an `HttpOnly` cookie, so page scripts
//! never see it. Every state-changing request authenticated by the cookie
//! must come from the public origin (exact `Origin` match) and carry the
//! CSRF token from the readable CSRF cookie in the `X-Kordi-CSRF-Token`
//! header. The CSRF token is derived from the session token, so it needs no
//! storage and cannot be computed without the session. The bearer-token
//! endpoints the apps use are unchanged.

use super::*;
use crate::auth::app_sign_in::tokens::sign_in_for_session;
use crate::auth::app_sign_in::APP_SIGN_IN_PAGE_PATH;
use sha2::{Digest, Sha256};

/// `__Host-` cookies are host-only, `Secure`, and scoped to `Path=/`, so a
/// sibling subdomain cannot set or overwrite them.
pub const WEB_SESSION_COOKIE: &str = "__Host-kordi_web_session";
pub const WEB_CSRF_COOKIE: &str = "__Host-kordi_web_csrf";
pub const WEB_CSRF_HEADER: &str = "x-kordi-csrf-token";
pub(super) const WEB_OAUTH_COMPLETE_PATH: &str = "/v1/cloud/auth/web/oauth/complete";
const WEB_SESSION_MAX_AGE_SECS: i64 = DEFAULT_SESSION_LIFETIME_DAYS * 24 * 60 * 60;
const MAX_RETURN_TO_CHARS: usize = 2048;

pub fn web_csrf_token(session_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"kordi-web-csrf\0");
    hasher.update(session_token.as_bytes());
    hex::encode(hasher.finalize())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

fn set_cookie_headers(session_token: Option<&str>) -> [String; 2] {
    let (session, csrf, max_age) = match session_token {
        Some(token) => (
            token.to_string(),
            web_csrf_token(token),
            WEB_SESSION_MAX_AGE_SECS,
        ),
        None => (String::new(), String::new(), 0),
    };
    [
        format!(
            "{WEB_SESSION_COOKIE}={session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        ),
        format!("{WEB_CSRF_COOKIE}={csrf}; Path=/; Secure; SameSite=Strict; Max-Age={max_age}"),
    ]
}

fn with_cookies(mut response: Response, session_token: Option<&str>) -> Response {
    for cookie in set_cookie_headers(session_token) {
        if let Ok(value) = cookie.parse() {
            response
                .headers_mut()
                .append(axum::http::header::SET_COOKIE, value);
        }
    }
    super::app_sign_in_handlers::no_store(response)
}

/// Whether the request's `Origin` is exactly the public origin.
pub(super) fn origin_is_public(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == crate::distribution::public_origin())
}

fn web_error(status: StatusCode, code: &'static str, message: &str) -> Box<Response> {
    Box::new(super::app_sign_in_handlers::oauth_error(
        status, code, message,
    ))
}

fn origin_error() -> Box<Response> {
    web_error(
        StatusCode::FORBIDDEN,
        "origin_mismatch",
        "This request must come from the Kordi web page.",
    )
}

fn login_required() -> Box<Response> {
    web_error(
        StatusCode::UNAUTHORIZED,
        "login_required",
        "Sign in to Kordi to continue.",
    )
}

/// The web session behind a cookie, without CSRF checks. For reads only.
async fn cookie_session(
    state: &ServerState,
    headers: &HeaderMap,
) -> Result<(CloudSession, String), Box<Response>> {
    let token = cookie_value(headers, WEB_SESSION_COOKIE)
        .filter(|token| token.starts_with(SESSION_TOKEN_PREFIX))
        .ok_or_else(login_required)?;
    let pool = state.db_pool();
    let server_error = || {
        web_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Could not validate session.",
        )
    };
    let row = match lookup_session(pool, &token).await {
        Ok(Some(row)) => row,
        Ok(None) => return Err(login_required()),
        Err(_) => return Err(server_error()),
    };
    // Only a direct web sign-in may act here; an app's access token may not.
    match sign_in_for_session(pool, &row.token_id).await {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err(web_error(
                StatusCode::FORBIDDEN,
                "web_session_required",
                "Sign in on the web page to continue.",
            ));
        }
        Err(_) => return Err(server_error()),
    }
    if let Err(error) = state
        .admission()
        .authorize_account(pool, &row.account_id)
        .await
    {
        return Err(Box::new(error.response()));
    }
    Ok((
        CloudSession {
            token_id: row.token_id,
            account_id: row.account_id,
            device_id: row.device_id,
        },
        token,
    ))
}

/// The web session for a state-changing request: exact `Origin`, session
/// cookie, and a CSRF header that matches the session.
pub(super) async fn authenticated_web_session(
    state: &ServerState,
    headers: &HeaderMap,
) -> Result<CloudSession, Box<Response>> {
    if !origin_is_public(headers) {
        return Err(origin_error());
    }
    let token = cookie_value(headers, WEB_SESSION_COOKIE).ok_or_else(login_required)?;
    let csrf_matches = headers
        .get(WEB_CSRF_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| constant_time_eq(value, &web_csrf_token(&token)));
    if !csrf_matches {
        return Err(web_error(
            StatusCode::FORBIDDEN,
            "csrf_token_invalid",
            "Reload the page and try again.",
        ));
    }
    cookie_session(state, headers)
        .await
        .map(|(session, _)| session)
}

/// Move the session token of a successful sign-in response into the cookie
/// and remove it from the body. The body gains `csrfToken`.
async fn into_web_session_response(response: Response) -> Response {
    if !response.status().is_success() {
        return response;
    }
    let (parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 1 << 20).await else {
        return err(
            "server_error",
            "Could not start the web session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let Some(token) = value
        .get_mut("session")
        .and_then(|session| session.as_object_mut())
        .and_then(|session| session.remove("token"))
        .and_then(|token| token.as_str().map(str::to_string))
    else {
        return err(
            "server_error",
            "Could not start the web session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    value["csrfToken"] = serde_json::Value::String(web_csrf_token(&token));
    with_cookies((parts.status, Json(value)).into_response(), Some(&token))
}

/// `POST /v1/cloud/auth/web/login`: email and password sign-in for web
/// pages. Same request as `/v1/cloud/auth/login`; the session goes into the
/// cookie instead of the body.
pub(super) async fn web_login(
    State(state): State<Arc<ServerState>>,
    rate_limiter: Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    request: Json<LoginRequest>,
) -> Response {
    if !origin_is_public(&headers) {
        return *origin_error();
    }
    let response = login(State(state), rate_limiter, connect_info, headers, request).await;
    into_web_session_response(response).await
}

/// `POST /v1/cloud/auth/web/signup`: like `/v1/cloud/auth/signup`, with the
/// session in the cookie.
pub(super) async fn web_signup(
    State(state): State<Arc<ServerState>>,
    rate_limiter: Extension<Arc<CloudRateLimiter>>,
    hasher_config: Extension<Arc<PasswordHasherConfig>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    request: Json<SignupRequest>,
) -> Response {
    if !origin_is_public(&headers) {
        return *origin_error();
    }
    let response = signup(
        State(state),
        rate_limiter,
        hasher_config,
        connect_info,
        headers,
        request,
    )
    .await;
    into_web_session_response(response).await
}

/// `GET /v1/cloud/auth/web/session`: the signed-in account and the CSRF
/// token, or `401 login_required`.
pub(super) async fn web_session_status(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    let (session, token) = match cookie_session(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match owner_account_response_row(state.db_pool(), &session.account_id).await {
        Ok(Some(account)) => super::app_sign_in_handlers::no_store(
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "account": account,
                    "csrfToken": web_csrf_token(&token),
                })),
            )
                .into_response(),
        ),
        _ => err(
            "server_error",
            "Could not load account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

/// `POST /v1/cloud/auth/web/logout`: revoke the web session and clear its
/// cookies.
pub(super) async fn web_logout(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    match authenticated_web_session(&state, &headers).await {
        Ok(session) => {
            if revoke_session(state.db_pool(), &session.token_id)
                .await
                .is_err()
            {
                return err(
                    "server_error",
                    "Could not revoke session.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
        // A session that is already gone still gets its cookies cleared.
        Err(response) if response.status() == StatusCode::UNAUTHORIZED => {}
        Err(response) => return *response,
    }
    with_cookies(StatusCode::NO_CONTENT.into_response(), None)
}

/// A same-origin path to return to after a web sign-in, or `None` when the
/// value could lead anywhere else.
pub(super) fn sanitize_return_to(value: Option<&str>) -> Option<String> {
    let value = value.unwrap_or(APP_SIGN_IN_PAGE_PATH);
    if value.len() > MAX_RETURN_TO_CHARS
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.contains('#')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let base = url::Url::parse(&crate::distribution::public_origin()).ok()?;
    let joined = base.join(value).ok()?;
    (joined.origin() == base.origin()).then(|| joined.to_string())
}

#[derive(Debug, Deserialize)]
pub(super) struct WebReturnQuery {
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
}

fn web_oauth_complete_url(return_to: &str) -> String {
    super::app_sign_in_handlers::redirect_uri_with(
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
pub(super) async fn web_oauth_start(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    Query(query): Query<WebReturnQuery>,
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
    // The page opens this link directly, so send the browser to the provider.
    match oauth_authorization_url(&state, &provider, &start_query).await {
        Ok(auth_url) => {
            super::app_sign_in_handlers::no_store(Redirect::to(&auth_url).into_response())
        }
        Err(response) => response,
    }
}

/// For a provider callback: when the sign-in was started by
/// [`web_oauth_start`], the page to return to.
pub(super) fn web_oauth_return_to(redirect_after: &str) -> Option<String> {
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

/// The provider callback's response for a web sign-in: set the cookie and
/// return to the page.
pub(super) fn web_oauth_success(session_token: &str, return_to: &str) -> Response {
    with_cookies(Redirect::to(return_to).into_response(), Some(session_token))
}

/// `GET /v1/cloud/auth/web/oauth/complete`: where a failed web provider
/// sign-in lands. It sends the browser back to `returnTo`; the browser
/// keeps the error fragment.
pub(super) async fn web_oauth_complete(Query(query): Query<WebReturnQuery>) -> Response {
    let target = sanitize_return_to(query.return_to.as_deref())
        .or_else(|| sanitize_return_to(None))
        .unwrap_or_else(|| "/".to_string());
    super::app_sign_in_handlers::no_store(Redirect::to(&target).into_response())
}
