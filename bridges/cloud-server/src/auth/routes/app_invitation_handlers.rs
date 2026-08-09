use super::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

const APP_INVITE_TOKEN_PREFIX: &str = "kordi_ai_";
const APP_INVITE_LIFETIME_DAYS: i64 = 7;
const KORDI_HOMEPAGE_URL: &str = "https://kordi.ai/";

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

fn safe_release_download_url(candidate: Option<&str>) -> Option<String> {
    let url = url::Url::parse(candidate?.trim()).ok()?;
    let homepage = url::Url::parse(KORDI_HOMEPAGE_URL).expect("valid Kordi homepage URL");
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

fn invitation_landing_document(
    title: &str,
    message: &str,
    release_download_url: Option<&str>,
) -> String {
    invitation_landing_document_with_open_action(title, message, None, release_download_url)
}

pub(super) fn invitation_landing_document_with_open_action(
    title: &str,
    message: &str,
    open_action: Option<(&str, &str)>,
    release_download_url: Option<&str>,
) -> String {
    let escaped_title = escape_html(title);
    let escaped_message = escape_html(message);
    let download_url = safe_release_download_url(release_download_url);
    let open_action = open_action
        .map(|(label, url)| {
            format!(
                r#"<a class="button button-primary" href="{}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4h9v9M16 4 5 15"></path></svg>
          {}
        </a>"#,
                escape_html(url),
                escape_html(label),
            )
        })
        .unwrap_or_default();
    let download_class = if open_action.is_empty() {
        "button button-primary"
    } else {
        "button button-secondary"
    };
    let download_action = download_url
        .as_deref()
        .map(|url| {
            format!(
                r#"<a class="{download_class}" href="{}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m0 0 4-4m-4 4L6 8M3 15v2h14v-2"></path></svg>
          Download Kordi for Mac
        </a>"#,
                escape_html(url)
            )
        })
        .unwrap_or_default();
    let learn_more_class = if download_url.is_some() || !open_action.is_empty() {
        "button button-secondary"
    } else {
        "button button-primary"
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escaped_title} · Kordi</title>
  <style>
    @font-face {{ font-family: "Marcellus"; src: url("/assets/fonts/marcellus-latin.woff2") format("woff2"); font-display: swap; }}
    :root {{ color-scheme: light dark; --paper: #faf9f7; --ink: #1a1714; --ink-2: #5c554d; --ink-3: #746d65; --rule: rgba(26, 23, 20, .1); }}
    * {{ box-sizing: border-box; }}
    html, body {{ min-height: 100%; }}
    body {{ min-height: 100vh; margin: 0; background: var(--paper); color: var(--ink); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .page {{ min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }}
    .wrap {{ width: min(calc(100% - 8rem), 1312px); margin-inline: auto; }}
    header {{ min-height: 68px; display: flex; align-items: center; border-bottom: 1px solid var(--rule); }}
    .brand {{ width: fit-content; display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font-family: "Marcellus", Optima, Candara, serif; font-size: 23px; line-height: 1; text-decoration: none; }}
    .brand svg {{ width: 31px; height: 31px; flex: 0 0 auto; }}
    main {{ display: flex; align-items: center; padding-block: clamp(4.5rem, 12vh, 8rem); }}
    .content {{ max-width: 760px; min-width: 0; }}
    h1 {{ max-width: 12ch; margin: 0; overflow-wrap: anywhere; color: var(--ink); font-family: "Marcellus", Optima, Candara, serif; font-size: clamp(3.15rem, 6vw, 5.75rem); font-weight: 400; line-height: .98; letter-spacing: -.035em; text-wrap: balance; }}
    p {{ max-width: 39ch; margin: 1.6rem 0 0; color: var(--ink-2); font-size: 1.0625rem; line-height: 1.72; }}
    .actions {{ display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; margin-top: 2.35rem; }}
    .button {{ min-height: 46px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding-inline: 18px; border: 1px solid var(--ink); border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none; transition: transform 180ms cubic-bezier(.22, 1, .36, 1), box-shadow 180ms cubic-bezier(.22, 1, .36, 1); }}
    .button svg {{ width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; }}
    .button-primary {{ background: var(--ink); color: var(--paper); }}
    .button-secondary {{ border-color: var(--rule); background: transparent; color: var(--ink); }}
    .button:hover {{ transform: translateY(-2px); box-shadow: 0 7px 18px -8px rgba(26, 23, 20, .4); }}
    .button:focus-visible, .brand:focus-visible {{ outline: 2px solid var(--ink); outline-offset: 3px; }}
    footer {{ padding-block: 1.4rem 1.6rem; border-top: 1px solid var(--rule); color: var(--ink-3); font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; font-size: .69rem; letter-spacing: .08em; }}
    @media (prefers-color-scheme: dark) {{
      :root {{ --paper: #191814; --ink: #f2efe9; --ink-2: #b8b0a7; --ink-3: #8d857c; --rule: rgba(242, 239, 233, .1); }}
      .button:hover {{ box-shadow: 0 7px 18px -8px rgba(0, 0, 0, .8); }}
    }}
    @media (max-width: 600px) {{
      .wrap {{ width: calc(100% - 2.5rem); }}
      main {{ padding-block: 3.5rem; }}
      h1 {{ max-width: 11ch; font-size: clamp(2.7rem, 13vw, 4rem); }}
      .actions {{ display: grid; }}
      .button {{ width: 100%; }}
    }}
    @media (prefers-reduced-motion: reduce) {{ .button {{ transition: none; }} }}
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="wrap">
        <a class="brand" href="{KORDI_HOMEPAGE_URL}" aria-label="Kordi home">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="10" r="9" fill="currentColor" opacity=".62"></circle>
            <circle cx="11" cy="22" r="9" fill="currentColor" opacity=".82"></circle>
            <circle cx="25" cy="22" r="9" fill="currentColor"></circle>
          </svg>
          <span>kordi</span>
        </a>
      </div>
    </header>
    <main class="wrap">
      <section class="content">
        <h1>{escaped_title}</h1>
        <p>{escaped_message}</p>
        <div class="actions">
          {open_action}
          {download_action}
          <a class="{learn_more_class}" href="{KORDI_HOMEPAGE_URL}">Learn more</a>
        </div>
      </section>
    </main>
    <footer class="wrap">&copy; Kordi 2026</footer>
  </div>
</body>
</html>"#
    )
}

fn invitation_landing_html(
    status: StatusCode,
    title: &str,
    message: &str,
    release_download_url: Option<&str>,
) -> Response {
    invitation_landing_html_with_open_action(status, title, message, None, release_download_url)
}

pub(super) fn invitation_landing_html_with_open_action(
    status: StatusCode,
    title: &str,
    message: &str,
    open_action: Option<(&str, &str)>,
    release_download_url: Option<&str>,
) -> Response {
    let body = match open_action {
        Some(action) => invitation_landing_document_with_open_action(
            title,
            message,
            Some(action),
            release_download_url,
        ),
        None => invitation_landing_document(title, message, release_download_url),
    };

    (
        status,
        [
            ("cache-control", "no-store"),
            (
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

    let release_download_url = configured_release_download_url();
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
                &format!("{inviter} invited you to Kordi."),
                "A shared workspace where people and agents work together.",
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
