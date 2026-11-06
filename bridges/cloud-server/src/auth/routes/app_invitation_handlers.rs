use super::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

mod browser_action;
mod landing;
pub(super) use browser_action::{configured_browser_app_url, BROWSER_APP_PATH};
#[cfg(test)]
use landing::{
    invitation_landing_document, invitation_landing_document_with_actions,
    invitation_landing_document_with_open_action,
};
use landing::{invitation_landing_html, invitation_landing_html_with_browser_action};

const APP_INVITE_TOKEN_PREFIX: &str = "kordi_ai_";
const APP_INVITE_LIFETIME_DAYS: i64 = 7;
pub(super) fn homepage_url() -> String {
    format!("{}/", crate::distribution::public_origin())
}
pub(super) const KORDI_FAVICON_URL: &str = "/assets/favicon.png";

struct AppInvitationRecord {
    display_name: Option<String>,
    kordi_id: String,
    avatar_url: Option<String>,
    expires_at: String,
}

enum AppInvitationLookup {
    Valid(AppInvitationRecord),
    Invalid,
    Expired,
}

fn new_app_invite_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!(
        "{}{}",
        APP_INVITE_TOKEN_PREFIX,
        URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn hash_app_invite_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn app_invite_url(token: &str) -> String {
    let public_base = std::env::var("KORDI_PUBLIC_APP_URL")
        .unwrap_or_else(|_| crate::distribution::public_origin());
    format!("{}/i/{token}", public_base.trim_end_matches('/'))
}

async fn lookup_app_invitation(
    pool: &PgPool,
    token: &str,
) -> Result<AppInvitationLookup, sqlx_core::Error> {
    if !token.starts_with(APP_INVITE_TOKEN_PREFIX) {
        return Ok(AppInvitationLookup::Invalid);
    }

    let row: Option<(Option<String>, String, Option<String>, String)> = query_as(
        "SELECT account.display_name, COALESCE(account.public_handle, account.public_account_number::TEXT), account.avatar_url, invite.expires_at \
         FROM cloud_app_invitations invite \
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id \
         WHERE invite.token_hash = $1 AND invite.revoked_at IS NULL",
    )
    .bind(hash_app_invite_token(token))
    .fetch_optional(pool)
    .await?;

    let Some((display_name, kordi_id, avatar_url, expires_at)) = row else {
        return Ok(AppInvitationLookup::Invalid);
    };
    let is_expired = DateTime::parse_from_rfc3339(&expires_at)
        .map(|value| value.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true);
    if is_expired {
        return Ok(AppInvitationLookup::Expired);
    }

    Ok(AppInvitationLookup::Valid(AppInvitationRecord {
        display_name,
        kordi_id,
        avatar_url,
        expires_at,
    }))
}

pub(super) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(super) fn configured_release_download_url() -> Option<String> {
    std::env::var("KORDI_RELEASE_CHANGELOG_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn safe_release_download_url(candidate: Option<&str>) -> Option<String> {
    let url = url::Url::parse(candidate?.trim()).ok()?;
    let homepage = url::Url::parse(&homepage_url()).expect("valid Kordi homepage URL");
    if url.scheme() != "https"
        || url.origin() != homepage.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() != 4
        || segments[0] != "updates"
        || segments[1] != "releases"
        || semver::Version::parse(segments[2]).is_err()
        || !segments[3].ends_with(".dmg")
    {
        return None;
    }
    Some(url.to_string())
}

pub(super) async fn create_app_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(APP_INVITATION_CREATE_LIMIT, &session.account_id)
        .await
    {
        return limited_response(retry_after);
    }

    let token = new_app_invite_token();
    let token_hash = hash_app_invite_token(&token);
    let invitation_id = format!("appinv_{}", uuid::Uuid::new_v4().simple());
    let created_at = Utc::now();
    let expires_at = created_at + ChronoDuration::days(APP_INVITE_LIFETIME_DAYS);

    if query(
        "INSERT INTO cloud_app_invitations \
         (invitation_id, inviter_account_id, token_hash, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&invitation_id)
    .bind(&session.account_id)
    .bind(&token_hash)
    .bind(created_at.to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not create invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    Json(AppInvitationResponse {
        invitation_id,
        invite_url: app_invite_url(&token),
        expires_at: expires_at.to_rfc3339(),
    })
    .into_response()
}

pub(super) async fn get_app_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_address_limit(
            INVITATION_VIEW_ADDRESS_LIMIT,
            client_ip(&headers, connect_info.as_ref()),
        )
        .await
    {
        return limited_response(retry_after);
    }
    let invitation = match lookup_app_invitation(state.db_pool(), &token).await {
        Ok(invitation) => invitation,
        Err(_) => {
            return err(
                "server_error",
                "Could not load invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    match invitation {
        AppInvitationLookup::Valid(record) => Json(AppInvitationPreviewResponse {
            inviter: AppInvitationInviterResponse {
                display_name: record.display_name,
                kordi_id: record.kordi_id,
                avatar_url: record.avatar_url,
            },
            expires_at: record.expires_at,
        })
        .into_response(),
        AppInvitationLookup::Invalid => err(
            "invalid_invitation",
            "This invitation link is invalid or was revoked.",
            StatusCode::NOT_FOUND,
        ),
        AppInvitationLookup::Expired => err(
            "invitation_expired",
            "This invitation has expired. Ask the sender for a new link.",
            StatusCode::GONE,
        ),
    }
}

pub(super) async fn app_invitation_landing(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_address_limit(
            INVITATION_VIEW_ADDRESS_LIMIT,
            client_ip(&headers, connect_info.as_ref()),
        )
        .await
    {
        return limited_response(retry_after);
    }

    let release_download_url = configured_release_download_url();
    match lookup_app_invitation(state.db_pool(), &token).await {
        Ok(AppInvitationLookup::Valid(record)) => {
            let inviter = record
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("A Kordi user");
            invitation_landing_html_with_browser_action(
                StatusCode::OK,
                &format!("{inviter} invited you to Kordi."),
                &format!(
                    "Join @{} in a shared workspace where people and agents work together.",
                    record.kordi_id
                ),
                None,
                configured_browser_app_url().await,
                release_download_url.as_deref(),
            )
        }
        Ok(AppInvitationLookup::Invalid) => invitation_landing_html(
            StatusCode::NOT_FOUND,
            "Invitation not available",
            "This link is invalid or has been revoked. Ask the sender for a new invitation.",
            release_download_url.as_deref(),
        ),
        Ok(AppInvitationLookup::Expired) => invitation_landing_html(
            StatusCode::GONE,
            "Invitation expired",
            "Ask the sender for a new invitation link.",
            release_download_url.as_deref(),
        ),
        Err(_) => invitation_landing_html(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invitation unavailable",
            "Kordi could not load this invitation. Please try again shortly.",
            release_download_url.as_deref(),
        ),
    }
}

pub(super) async fn revoke_app_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(invitation_id): axum::extract::Path<String>,
) -> Response {
    let revoked_at = Utc::now().to_rfc3339();
    let result = query(
        "UPDATE cloud_app_invitations SET revoked_at = $1 \
         WHERE invitation_id = $2 AND inviter_account_id = $3 AND revoked_at IS NULL",
    )
    .bind(&revoked_at)
    .bind(invitation_id.trim())
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(
            "invitation_missing",
            "Invitation was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not revoke invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

#[cfg(test)]
mod tests;
