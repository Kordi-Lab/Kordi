//! HTTP endpoints for browser sign-in (authorization code with PKCE).
//! The contract is documented in `docs/development/browser-sign-in.md`.

use super::*;
use crate::auth::app_sign_in::codes::{is_s256_challenge, issue_code};
use crate::auth::app_sign_in::tokens::sign_in_for_session;
use crate::auth::app_sign_in::{AppClientRegistry, AuthorizationGrant, CodeDelivery};

mod sign_ins;
mod token;

pub(super) use sign_ins::{list_app_sign_ins, revoke_app_sign_in};
pub(super) use token::{app_token, revoke_app_token};

/// Server configuration for the web page that signs the user in and then
/// calls the authorization endpoint. Defaults to `/sign-in/app` on the
/// public origin.
pub const APP_SIGN_IN_PAGE_ENV: &str = "KORDI_AUTH_APP_SIGN_IN_PAGE_URL";
const MAX_STATE_CHARS: usize = 512;

pub(super) fn app_sign_in_page_url() -> String {
    std::env::var(APP_SIGN_IN_PAGE_ENV)
        .ok()
        .filter(|value| url::Url::parse(value).is_ok())
        .unwrap_or_else(|| format!("{}/sign-in/app", crate::distribution::public_origin()))
}

/// An RFC 6749 error body that also carries the `errorCode`/`message`
/// fields every other Kordi endpoint returns.
pub(super) fn oauth_error(status: StatusCode, error: &'static str, description: &str) -> Response {
    no_store(
        (
            status,
            Json(serde_json::json!({
                "error": error,
                "error_description": description,
                "errorCode": error,
                "message": description,
            })),
        )
            .into_response(),
    )
}

pub(super) fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert("Cache-Control", "no-store".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    response
}

/// Parse a body sent either as `application/x-www-form-urlencoded`, as
/// RFC 6749 requires, or as JSON. Repeated form parameters are rejected.
pub(super) fn parse_form_or_json<T: serde::de::DeserializeOwned>(
    headers: &HeaderMap,
    body: &[u8],
) -> Result<T, String> {
    let is_json = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .trim()
                .to_ascii_lowercase()
                .starts_with("application/json")
        });
    if is_json {
        return serde_json::from_slice(body).map_err(|error| error.to_string());
    }
    let mut fields = serde_json::Map::new();
    for (key, value) in url::form_urlencoded::parse(body) {
        if fields
            .insert(
                key.to_string(),
                serde_json::Value::String(value.into_owned()),
            )
            .is_some()
        {
            return Err(format!("parameter {key} is repeated"));
        }
    }
    serde_json::from_value(serde_json::Value::Object(fields)).map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct AppAuthorizationParams {
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    pub response_type: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ValidAuthorization {
    pub grant: AuthorizationGrant,
    pub state: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AuthorizationRejection {
    /// The client is unknown; nothing may be sent to the redirect URI.
    UnknownClient,
    /// The redirect URI is not registered for the client.
    RedirectUriMismatch,
    /// The client and redirect URI are valid, so the error may be returned
    /// to the app through the redirect URI.
    Redirectable {
        redirect_uri: String,
        error: &'static str,
        description: &'static str,
        state: Option<String>,
    },
}

impl AppAuthorizationParams {
    pub(super) fn validate(
        &self,
        registry: &AppClientRegistry,
    ) -> Result<ValidAuthorization, AuthorizationRejection> {
        let client = self
            .client_id
            .as_deref()
            .and_then(|client_id| registry.client(client_id))
            .ok_or(AuthorizationRejection::UnknownClient)?;
        let redirect_uri = self
            .redirect_uri
            .as_deref()
            .filter(|uri| client.allows_redirect_uri(uri))
            .ok_or(AuthorizationRejection::RedirectUriMismatch)?;
        let state = self
            .state
            .clone()
            .filter(|state| state.len() <= MAX_STATE_CHARS);
        let reject = |error, description| AuthorizationRejection::Redirectable {
            redirect_uri: redirect_uri.to_string(),
            error,
            description,
            state: state.clone(),
        };
        if self.response_type.as_deref() != Some("code") {
            return Err(reject(
                "unsupported_response_type",
                "Only the authorization code flow is supported.",
            ));
        }
        if self.code_challenge_method.as_deref() != Some("S256") {
            return Err(reject(
                "invalid_request",
                "PKCE with code_challenge_method S256 is required.",
            ));
        }
        let Some(code_challenge) = self
            .code_challenge
            .as_deref()
            .filter(|c| is_s256_challenge(c))
        else {
            return Err(reject(
                "invalid_request",
                "The code_challenge is malformed.",
            ));
        };
        let Some(state) = state.clone().filter(|state| !state.is_empty()) else {
            return Err(reject("invalid_request", "A state value is required."));
        };
        Ok(ValidAuthorization {
            grant: AuthorizationGrant {
                client_id: client.client_id.clone(),
                redirect_uri: redirect_uri.to_string(),
                code_challenge: code_challenge.to_string(),
            },
            state,
        })
    }
}

pub(super) fn redirect_uri_with(redirect_uri: &str, pairs: &[(&str, &str)]) -> String {
    let Ok(mut url) = url::Url::parse(redirect_uri) else {
        return redirect_uri.to_string();
    };
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.to_string()
}

fn rejection_response(rejection: AuthorizationRejection) -> Response {
    match rejection {
        AuthorizationRejection::UnknownClient => oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_client",
            "This app is not registered for browser sign-in.",
        ),
        AuthorizationRejection::RedirectUriMismatch => oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_redirect_uri",
            "The redirect URI is not registered for this app.",
        ),
        AuthorizationRejection::Redirectable {
            error, description, ..
        } => oauth_error(StatusCode::BAD_REQUEST, error, description),
    }
}

/// `GET /v1/cloud/auth/app/authorize`: the URL the app opens in the system
/// browser. Validates the request and sends the browser to the sign-in page
/// with the same parameters. Errors for an unknown client or redirect URI
/// are shown in the browser; other errors return to the app.
pub(super) async fn app_authorize_start(
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Query(params): Query<AppAuthorizationParams>,
) -> Response {
    match params.validate(&registry) {
        Ok(valid) => {
            let query = [
                ("response_type", "code"),
                ("client_id", valid.grant.client_id.as_str()),
                ("redirect_uri", valid.grant.redirect_uri.as_str()),
                ("code_challenge", valid.grant.code_challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("state", valid.state.as_str()),
            ];
            no_store(
                Redirect::to(&redirect_uri_with(&app_sign_in_page_url(), &query)).into_response(),
            )
        }
        Err(AuthorizationRejection::Redirectable {
            redirect_uri,
            error,
            description,
            state,
        }) => {
            let mut pairs = vec![("error", error), ("error_description", description)];
            if let Some(state) = state.as_deref() {
                pairs.push(("state", state));
            }
            no_store(Redirect::to(&redirect_uri_with(&redirect_uri, &pairs)).into_response())
        }
        Err(rejection) => rejection_response(rejection),
    }
}

/// `POST /v1/cloud/auth/app/authorize`: called by the sign-in page with the
/// web session's bearer token. Returns the redirect URL carrying the code.
pub(super) async fn app_authorize(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(params): Json<AppAuthorizationParams>,
) -> Response {
    authorize_with_delivery(
        &state,
        &registry,
        &rate_limiter,
        client_ip(&headers, connect_info.as_ref()),
        &headers,
        params,
        CodeDelivery::Redirect,
    )
    .await
}

/// `POST /v1/cloud/auth/app/authorize/display-code`: like the authorization
/// endpoint, but returns a code for the page to show when the app's
/// redirect is blocked. The app exchanges it with its verifier as usual.
pub(super) async fn app_authorize_display_code(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(params): Json<AppAuthorizationParams>,
) -> Response {
    authorize_with_delivery(
        &state,
        &registry,
        &rate_limiter,
        client_ip(&headers, connect_info.as_ref()),
        &headers,
        params,
        CodeDelivery::Display,
    )
    .await
}

async fn authorize_with_delivery(
    state: &ServerState,
    registry: &AppClientRegistry,
    rate_limiter: &CloudRateLimiter,
    peer_ip: Option<IpAddr>,
    headers: &HeaderMap,
    params: AppAuthorizationParams,
    delivery: CodeDelivery,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return limited_response(retry_after);
    }
    let pool = state.db_pool();
    let session = match web_session(state, headers).await {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let valid = match params.validate(registry) {
        Ok(valid) => valid,
        Err(rejection) => return rejection_response(rejection),
    };
    let issued = match issue_code(pool, &session.account_id, &valid.grant, delivery).await {
        Ok(issued) => issued,
        Err(_) => {
            return oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Could not issue an authorization code.",
            );
        }
    };
    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "auth.app_sign_in.code_issued",
        serde_json::json!({
            "clientId": valid.grant.client_id,
            "delivery": if delivery == CodeDelivery::Display { "display" } else { "redirect" },
            "ip": peer_ip.map(|ip| ip.to_string()),
        }),
    )
    .await;
    let expires_in = delivery.lifetime().num_seconds();
    let body = match delivery {
        CodeDelivery::Redirect => serde_json::json!({
            "redirectUrl": redirect_uri_with(
                &valid.grant.redirect_uri,
                &[("code", issued.code.as_str()), ("state", valid.state.as_str())],
            ),
            "expiresAt": issued.expires_at.to_rfc3339(),
            "expiresIn": expires_in,
        }),
        CodeDelivery::Display => serde_json::json!({
            "code": issued.code,
            "state": valid.state,
            "expiresAt": issued.expires_at.to_rfc3339(),
            "expiresIn": expires_in,
        }),
    };
    no_store((StatusCode::OK, Json(body)).into_response())
}

/// The signed-in web session behind an authorization request. Only a session
/// from a direct sign-in may authorize an app; an app's own access token may
/// not mint codes for other apps.
async fn web_session(
    state: &ServerState,
    headers: &HeaderMap,
) -> Result<CloudSession, Box<Response>> {
    let login_required = || {
        Box::new(oauth_error(
            StatusCode::UNAUTHORIZED,
            "login_required",
            "Sign in to Kordi to continue.",
        ))
    };
    let token = bearer_token_from_headers(headers)
        .filter(|token| token.starts_with(SESSION_TOKEN_PREFIX))
        .ok_or_else(login_required)?;
    let pool = state.db_pool();
    let row = match lookup_session(pool, token).await {
        Ok(Some(row)) => row,
        Ok(None) => return Err(login_required()),
        Err(_) => {
            return Err(Box::new(oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Could not validate session.",
            )));
        }
    };
    match sign_in_for_session(pool, &row.token_id).await {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err(Box::new(oauth_error(
                StatusCode::FORBIDDEN,
                "web_session_required",
                "Sign in on the web page to authorize this app.",
            )));
        }
        Err(_) => {
            return Err(Box::new(oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Could not validate session.",
            )));
        }
    }
    if let Err(error) = state
        .admission()
        .authorize_account(pool, &row.account_id)
        .await
    {
        return Err(Box::new(error.response()));
    }
    Ok(CloudSession {
        token_id: row.token_id,
        account_id: row.account_id,
        device_id: row.device_id,
    })
}

#[cfg(test)]
mod tests;
