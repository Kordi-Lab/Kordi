//! HTTP endpoints for browser sign-in (authorization code with PKCE).
//! The contract is documented in `docs/development/browser-sign-in.md`.

use super::*;
use crate::auth::app_sign_in::codes::{is_s256_challenge, issue_code};
use crate::auth::app_sign_in::{AppClientRegistry, AuthorizationGrant, CodeDelivery};
use crate::auth::rate_limit::AccountActionLimit;

mod sign_in_start;
mod sign_ins;
mod token;

pub(super) use sign_in_start::{begin_sign_in, finish_sign_in};
pub(super) use sign_ins::{list_app_sign_ins, revoke_app_sign_in};
pub(super) use token::{app_token, invalid_grant, revoke_app_token, server_error};

/// Server configuration for the web page that signs the user in and then
/// calls the authorization endpoint. Defaults to `/sign-in/app` on the
/// public origin.
pub const APP_SIGN_IN_PAGE_ENV: &str = "KORDI_AUTH_APP_SIGN_IN_PAGE_URL";
const MAX_STATE_CHARS: usize = 512;

pub(super) fn app_sign_in_page_url() -> String {
    std::env::var(APP_SIGN_IN_PAGE_ENV)
        .ok()
        .filter(|value| url::Url::parse(value).is_ok())
        .unwrap_or_else(|| {
            format!(
                "{}{}",
                crate::distribution::public_origin(),
                crate::auth::app_sign_in::APP_SIGN_IN_PAGE_PATH
            )
        })
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
    /// Display codes only: the user confirmed they started this sign-in
    /// from their own app on this device.
    #[serde(default, skip_serializing)]
    pub confirmed: Option<bool>,
    /// Redirect codes only: the user approved this app on the page
    /// ("Continue as ...") during this request (RFC 8252, section 8.6).
    #[serde(default, skip_serializing)]
    pub approved: Option<bool>,
    /// OpenID Connect `prompt`. Only `create` (open the page on account
    /// creation) is forwarded to the sign-in page; other values are dropped.
    #[serde(default, skip_serializing)]
    pub prompt: Option<String>,
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
    /// The `prompt` value forwarded to the sign-in page, if supported.
    pub(super) fn sign_in_page_prompt(&self) -> Option<&'static str> {
        (self.prompt.as_deref() == Some("create")).then_some("create")
    }

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
            let mut query = vec![
                ("response_type", "code"),
                ("client_id", valid.grant.client_id.as_str()),
                ("redirect_uri", valid.grant.redirect_uri.as_str()),
                ("code_challenge", valid.grant.code_challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("state", valid.state.as_str()),
            ];
            if let Some(prompt) = params.sign_in_page_prompt() {
                query.push(("prompt", prompt));
            }
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

/// Codes one account may request across every app.
const CODE_ISSUE_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "app-sign-in-code",
    limit: 30,
    window: std::time::Duration::from_secs(10 * 60),
};

/// Displayed codes one account may request for one app.
const DISPLAY_CODE_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "app-sign-in-display-code",
    limit: 5,
    window: std::time::Duration::from_secs(10 * 60),
};

/// The warning the sign-in page shows next to a displayed code.
pub const DISPLAY_CODE_WARNING: &str =
    "Only paste this code into the Kordi app on this device. Never share it.";

/// `POST /v1/cloud/auth/app/authorize`: called by the sign-in page with the
/// web session cookie after the user approved the app (`"approved": true`).
/// Returns the redirect URL carrying the code.
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

/// `POST /v1/cloud/auth/app/authorize/display-code`: the last-resort
/// fallback when the app's redirect is blocked. The page calls it only after
/// the user confirms they started this sign-in from their own app on this
/// device (`"confirmed": true`). The app exchanges the code with its
/// verifier as usual.
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
    let session = match authenticated_web_session(state, headers).await {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let valid = match params.validate(registry) {
        Ok(valid) => valid,
        Err(rejection) => return rejection_response(rejection),
    };
    // A code sent to the redirect URI reaches whatever app holds that URI,
    // so the signed-in user must approve each request on the page. A
    // displayed code reaches only the person reading the page, who confirms
    // instead.
    if delivery == CodeDelivery::Redirect && params.approved != Some(true) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "approval_required",
            "Approve this app on the sign-in page to continue.",
        );
    }
    if delivery == CodeDelivery::Display && params.confirmed != Some(true) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "confirmation_required",
            "Confirm that you started this sign-in from your own app on this device.",
        );
    }
    let mut limits = vec![(CODE_ISSUE_LIMIT, session.account_id.clone())];
    if delivery == CodeDelivery::Display {
        limits.push((
            DISPLAY_CODE_LIMIT,
            format!("{}:{}", session.account_id, valid.grant.client_id),
        ));
    }
    for (limit, key) in limits {
        if let RateLimitDecision::Limited { retry_after } =
            rate_limiter.observe_account_limit(limit, &key).await
        {
            return limited_response(retry_after);
        }
    }
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
            "clientId": valid.grant.client_id,
            "appName": registry
                .client(&valid.grant.client_id)
                .map(|client| client.name.clone()),
            "requestedAt": issued.issued_at.to_rfc3339(),
            "expiresAt": issued.expires_at.to_rfc3339(),
            "expiresIn": expires_in,
            "warning": DISPLAY_CODE_WARNING,
        }),
    };
    no_store((StatusCode::OK, Json(body)).into_response())
}

#[cfg(test)]
mod tests;
