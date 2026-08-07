use super::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

const APP_INVITE_TOKEN_PREFIX: &str = "kordi_ai_";
const APP_INVITE_LIFETIME_DAYS: i64 = 7;

struct AppInvitationRecord {
    display_name: Option<String>,
    public_account_number: i64,
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
    let public_base =
        std::env::var("KORDI_PUBLIC_APP_URL").unwrap_or_else(|_| "https://kordi.ai".to_string());
    format!("{}/i/{token}", public_base.trim_end_matches('/'))
}

async fn lookup_app_invitation(
    pool: &PgPool,
    token: &str,
) -> Result<AppInvitationLookup, sqlx_core::Error> {
    if !token.starts_with(APP_INVITE_TOKEN_PREFIX) {
        return Ok(AppInvitationLookup::Invalid);
    }

    let row: Option<(Option<String>, i64, Option<String>, String)> = query_as(
        "SELECT account.display_name, account.public_account_number, account.avatar_url, invite.expires_at \
         FROM cloud_app_invitations invite \
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id \
         WHERE invite.token_hash = $1 AND invite.revoked_at IS NULL",
    )
    .bind(hash_app_invite_token(token))
    .fetch_optional(pool)
    .await?;

    let Some((display_name, public_account_number, avatar_url, expires_at)) = row else {
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
        public_account_number,
        avatar_url,
        expires_at,
    }))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn invitation_landing_html(
    status: StatusCode,
    title: &str,
    message: &str,
    kordi_id: Option<i64>,
) -> Response {
    let escaped_title = escape_html(title);
    let escaped_message = escape_html(message);
    let handle = kordi_id
        .map(|value| format!("<p class=\"handle\">@{value:09}</p>"))
        .unwrap_or_default();
    let body = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escaped_title} · Kordi</title>
  <style>
    :root {{ color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #111827; color: #f8fafc; }}
    main {{ width: min(100%, 440px); padding: 36px; border: 1px solid rgba(255,255,255,.12); border-radius: 24px; background: #182235; box-shadow: 0 24px 80px rgba(0,0,0,.28); }}
    .mark {{ display: grid; width: 44px; height: 44px; place-items: center; border-radius: 14px; background: #34d399; color: #06281d; font-weight: 800; }}
    h1 {{ margin: 24px 0 8px; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; }}
    p {{ margin: 0; color: #aebbd0; font-size: 15px; line-height: 1.6; }}
    .handle {{ margin-top: 8px; color: #6ee7b7; font-weight: 650; letter-spacing: .04em; }}
    a {{ display: flex; min-height: 46px; margin-top: 28px; align-items: center; justify-content: center; border-radius: 999px; background: #f8fafc; color: #111827; font-weight: 700; text-decoration: none; }}
    a:focus-visible {{ outline: 3px solid #6ee7b7; outline-offset: 3px; }}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">K</div>
    <h1>{escaped_title}</h1>
    <p>{escaped_message}</p>
    {handle}
    <a href="/updates/releases/latest/Kordi.dmg">Get Kordi</a>
  </main>
</body>
</html>"#
    );

    (
        status,
        [
            ("cache-control", "no-store"),
            (
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
        ],
        Html(body),
    )
        .into_response()
}

pub(super) async fn create_app_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
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
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
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
                kordi_id: record.public_account_number.to_string(),
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
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }

    match lookup_app_invitation(state.db_pool(), &token).await {
        Ok(AppInvitationLookup::Valid(record)) => {
            let inviter = record
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("A Kordi user");
            invitation_landing_html(
                StatusCode::OK,
                &format!("{inviter} invited you to Kordi"),
                "A shared workspace where people and agents work together.",
                Some(record.public_account_number),
            )
        }
        Ok(AppInvitationLookup::Invalid) => invitation_landing_html(
            StatusCode::NOT_FOUND,
            "Invitation not available",
            "This link is invalid or has been revoked. Ask the sender for a new invitation.",
            None,
        ),
        Ok(AppInvitationLookup::Expired) => invitation_landing_html(
            StatusCode::GONE,
            "Invitation expired",
            "Ask the sender for a new invitation link.",
            None,
        ),
        Err(_) => invitation_landing_html(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invitation unavailable",
            "Kordi could not load this invitation. Please try again shortly.",
            None,
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
mod tests {
    use super::{
        escape_html, hash_app_invite_token, new_app_invite_token, APP_INVITE_TOKEN_PREFIX,
    };

    #[test]
    fn app_invite_tokens_are_opaque_and_hash_stably() {
        let first = new_app_invite_token();
        let second = new_app_invite_token();
        assert!(first.starts_with(APP_INVITE_TOKEN_PREFIX));
        assert_ne!(first, second);
        assert_eq!(hash_app_invite_token(&first), hash_app_invite_token(&first));
        assert_ne!(
            hash_app_invite_token(&first),
            hash_app_invite_token(&second)
        );
        assert!(!hash_app_invite_token(&first).contains(&first));
    }

    #[test]
    fn invitation_landing_escapes_inviter_names() {
        assert_eq!(
            escape_html("<Shuyang & 'friends'>"),
            "&lt;Shuyang &amp; &#39;friends&#39;&gt;"
        );
    }
}
