//! The `/g/<token>` page a group invitation link opens in a browser.
//!
//! Signed out, it names the inviter and the group and offers sign-up and
//! log-in pages that return here. Signed in on the web, a form POST claims
//! the invitation for the account and then opens the app or, when this
//! server serves it, the browser application, which offers the same join
//! prompt; nothing is claimed when the page loads. Expired or unusable links
//! never name the inviter.

use super::pending::{claim_for_account, inviter_name, is_group_member, ClaimOutcome};
use super::*;

const USERS_ICON: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>"#;
const LINK_ICON: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>"#;

/// The sign-in pages read the path to return to from this query parameter.
pub(super) const SIGN_IN_RETURN_PARAM: &str = "next";

/// The form field that names where the signed-in page continues after the
/// claim. Only [`CONTINUE_ON_WEB`] picks the browser application; any other
/// value opens the app.
pub(super) const CONTINUE_FIELD: &str = "continue";
pub(super) const CONTINUE_ON_WEB: &str = "web";

pub(super) enum LandingView {
    SignedOut {
        inviter: String,
        group: String,
        member_count: usize,
        token: String,
    },
    SignedIn {
        group: String,
        viewer: Option<String>,
        token: String,
        csrf: String,
        download_url: Option<String>,
        web: bool,
    },
    Member {
        group: String,
        token: String,
        web: bool,
    },
    Expired,
    TooManyPending {
        token: String,
        web: bool,
    },
    Retry {
        token: String,
    },
    Unavailable,
}

fn member_line(count: usize) -> String {
    if count == 1 {
        "1 member on Kordi".to_string()
    } else {
        format!("{count} members on Kordi")
    }
}

fn initials(name: &str) -> String {
    name.split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect()
}

fn link(class: &str, href: &str, label: &str) -> String {
    format!(
        r#"<a class="{class}" href="{}">{}</a>"#,
        escape_html(href),
        escape_html(label)
    )
}

/// "Open the app" for a claimed invitation, with "Continue on the web" when
/// the browser application is served. Both are plain links: nothing is left
/// to claim.
fn open_app_actions(token: &str, web: bool) -> String {
    let web = if web {
        link(
            "button button-secondary",
            BROWSER_APP_PATH,
            "Continue on the web",
        )
    } else {
        String::new()
    };
    format!(
        r#"<div class="actions">{}{web}</div>"#,
        link(
            "button button-primary",
            &group_invite_deep_link(token),
            "Open the app"
        )
    )
}

fn open_app_quiet(token: &str) -> String {
    format!(
        r#"<p class="quiet">Have Kordi? <a href="{}">Open the app</a></p>"#,
        escape_html(&group_invite_deep_link(token))
    )
}

/// The page's body: icon, heading, line and actions for one state.
pub(super) fn landing_content(view: &LandingView) -> (String, String) {
    let card = |icon: &str, title: &str, line: Option<&str>, rest: &str| {
        let line = line
            .map(|line| format!("<p>{}</p>", escape_html(line)))
            .unwrap_or_default();
        format!(
            r#"<span class="tile">{icon}</span>
        <h1>{}</h1>
        {line}
        {rest}"#,
            escape_html(title)
        )
    };
    match view {
        LandingView::SignedOut {
            inviter,
            group,
            member_count,
            token,
        } => {
            let back = format!("%2Fg%2F{token}");
            let title = format!("{inviter} invited you to {group}");
            let actions = format!(
                r#"<div class="actions">{}{}</div>
        {}"#,
                link(
                    "button button-primary",
                    &format!("/register?{SIGN_IN_RETURN_PARAM}={back}"),
                    "Sign up"
                ),
                link(
                    "button button-secondary",
                    &format!("/login?{SIGN_IN_RETURN_PARAM}={back}"),
                    "Log in"
                ),
                open_app_quiet(token),
            );
            let line = member_line(*member_count);
            (
                title.clone(),
                card(USERS_ICON, &title, Some(&line), &actions),
            )
        }
        LandingView::SignedIn {
            group,
            viewer,
            token,
            csrf,
            download_url,
            web,
        } => {
            let who = viewer
                .as_deref()
                .map(|name| {
                    format!(
                        r#"<span class="who"><span>{}</span><span>{}</span></span>"#,
                        escape_html(&initials(name)),
                        escape_html(name)
                    )
                })
                .unwrap_or_default();
            let download = download_url
                .as_deref()
                .map(|url| link("button button-secondary", url, "Download for Mac"))
                .unwrap_or_default();
            // Both buttons submit the same claim; the button's value picks
            // where to continue afterwards.
            let web_button = if *web {
                format!(
                    r#"<button class="button button-secondary" type="submit" name="{CONTINUE_FIELD}" value="{CONTINUE_ON_WEB}">Continue on the web</button>"#
                )
            } else {
                String::new()
            };
            let rest = format!(
                r#"{who}
        <form class="actions" method="post" action="/g/{}">
          <input type="hidden" name="csrf" value="{}">
          <button class="button button-primary" type="submit" name="{CONTINUE_FIELD}" value="app">Open Kordi</button>
          {web_button}
          {download}
        </form>"#,
                escape_html(token),
                escape_html(csrf),
            );
            let title = format!("Join {group}");
            let (heading, line) = if *web {
                (
                    title.as_str(),
                    "Open it in the app or on the web.".to_string(),
                )
            } else {
                (
                    "Open Kordi to join",
                    format!("{group} is waiting in the app."),
                )
            };
            (title.clone(), card(USERS_ICON, heading, Some(&line), &rest))
        }
        LandingView::Member { group, token, web } => {
            let title = format!("You're in {group}");
            let actions = open_app_actions(token, *web);
            (title.clone(), card(USERS_ICON, &title, None, &actions))
        }
        LandingView::Expired => (
            "This link expired".to_string(),
            card(
                LINK_ICON,
                "This link expired",
                Some("Ask the sender for a new one."),
                &format!(
                    r#"<p class="quiet"><a href="{}">Go to Kordi</a></p>"#,
                    escape_html(&homepage_url())
                ),
            ),
        ),
        LandingView::TooManyPending { token, web } => (
            "Too many invitations".to_string(),
            card(
                USERS_ICON,
                "Too many invitations waiting",
                Some("Join or dismiss one in Kordi first."),
                &open_app_actions(token, *web),
            ),
        ),
        LandingView::Retry { token } => (
            "Try again".to_string(),
            card(
                LINK_ICON,
                "Try again",
                Some("Reload this page and try again."),
                &format!(
                    r#"<div class="actions">{}</div>"#,
                    link("button button-primary", &format!("/g/{token}"), "Reload")
                ),
            ),
        ),
        LandingView::Unavailable => (
            "Something went wrong".to_string(),
            card(
                LINK_ICON,
                "Something went wrong",
                Some("Try again shortly."),
                "",
            ),
        ),
    }
}

pub(super) fn landing_document(view: &LandingView) -> String {
    let (title, content) = landing_content(view);
    // Only a signed-out visitor is offered the header's Log in and Sign up,
    // and they return to this invitation.
    let return_to = match view {
        LandingView::SignedOut { token, .. } => Some(format!("/g/{token}")),
        _ => None,
    };
    super::landing_page::page_shell(&title, &content, return_to.as_deref())
}

pub(super) fn landing_response(status: StatusCode, view: &LandingView) -> Response {
    // The form posts to this origin and then redirects to the app's scheme,
    // so `form-action` allows both. `same-origin` keeps the `Origin` header
    // on that POST, which the CSRF check requires.
    let csp = format!(
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; \
         base-uri 'none'; form-action 'self' {}:; frame-ancestors 'none'",
        crate::distribution::callback_scheme()
    );
    let mut response = (status, Html(landing_document(view))).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        ("cache-control", "no-store".to_string()),
        ("content-security-policy", csp),
        ("referrer-policy", "same-origin".to_string()),
        ("x-content-type-options", "nosniff".to_string()),
        ("x-frame-options", "DENY".to_string()),
    ] {
        if let Ok(value) = value.parse() {
            headers.insert(name, value);
        }
    }
    response
}

async fn viewer_name(pool: &PgPool, account_id: &str) -> Option<String> {
    let row: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(pool)
            .await
            .ok()?;
    row?.0
        .map(|name| name.trim().chars().take(80).collect::<String>())
        .filter(|name| !name.is_empty())
}

/// `GET /g/:token`
pub(crate) async fn group_invitation_landing(
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
    let pool = state.db_pool();
    let record = match lookup_group_invitation(pool, &token).await {
        Ok(GroupInvitationLookup::Valid(record)) => {
            match refresh_group_invitation_record(pool, *record).await {
                Ok(Some(record)) => record,
                Ok(None) => return landing_response(StatusCode::NOT_FOUND, &LandingView::Expired),
                Err(_) => {
                    return landing_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &LandingView::Unavailable,
                    )
                }
            }
        }
        Ok(GroupInvitationLookup::Invalid) => {
            return landing_response(StatusCode::NOT_FOUND, &LandingView::Expired)
        }
        Ok(GroupInvitationLookup::Expired) => {
            return landing_response(StatusCode::GONE, &LandingView::Expired)
        }
        Err(_) => {
            return landing_response(StatusCode::INTERNAL_SERVER_ERROR, &LandingView::Unavailable)
        }
    };
    let group = record.snapshot.group_title.clone();
    let session = signed_in_web_session(&state, &headers).await;
    let web = session.is_some() && configured_browser_app_url().await.is_some();
    let view = match session {
        Some((session, _)) if is_group_member(&record, &session.account_id) => {
            LandingView::Member { group, token, web }
        }
        _ if !group_invitation_has_capacity(&record.snapshot) => {
            return landing_response(StatusCode::CONFLICT, &LandingView::Expired)
        }
        Some((session, csrf)) => LandingView::SignedIn {
            group,
            viewer: viewer_name(pool, &session.account_id).await,
            token,
            csrf,
            download_url: safe_release_download_url(configured_release_download_url().as_deref()),
            web,
        },
        None => LandingView::SignedOut {
            inviter: inviter_name(&record),
            group,
            member_count: record.snapshot.participants.len(),
            token,
        },
    };
    landing_response(StatusCode::OK, &view)
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClaimForm {
    csrf: String,
    #[serde(default, rename = "continue")]
    destination: Option<String>,
}

impl ClaimForm {
    fn continues_on_web(&self) -> bool {
        self.destination.as_deref() == Some(CONTINUE_ON_WEB)
    }
}

/// Where a successful claim continues: the browser application's fixed path
/// or the app's deep link for this token, never a location from the request.
pub(super) fn claim_redirect_target(token: &str, on_web: bool) -> String {
    if on_web {
        BROWSER_APP_PATH.to_string()
    } else {
        group_invite_deep_link(token)
    }
}

/// `POST /g/:token`: the signed-in page's form. Claims the invitation for
/// the web session's account, then opens the app or the browser application.
pub(crate) async fn claim_group_invitation_from_page(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    axum::extract::Path(token): axum::extract::Path<String>,
    axum::Form(form): axum::Form<ClaimForm>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_address_limit(
            INVITATION_PAGE_CLAIM_ADDRESS_LIMIT,
            client_ip(&headers, connect_info.as_ref()),
        )
        .await
    {
        return limited_response(retry_after);
    }
    let Ok(session) = form_web_session(&state, &headers, &form.csrf).await else {
        let token = token
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        return landing_response(StatusCode::FORBIDDEN, &LandingView::Retry { token });
    };
    let on_web = form.continues_on_web();
    match claim_for_account(state.db_pool(), &token, &session.account_id).await {
        Ok(ClaimOutcome::Claimed(_) | ClaimOutcome::AlreadyMember { .. }) => {
            super::super::app_sign_in_handlers::no_store(
                Redirect::to(&claim_redirect_target(&token, on_web)).into_response(),
            )
        }
        Ok(ClaimOutcome::Unavailable | ClaimOutcome::GroupFull) => {
            landing_response(StatusCode::GONE, &LandingView::Expired)
        }
        Ok(ClaimOutcome::TooManyPending) => landing_response(
            StatusCode::TOO_MANY_REQUESTS,
            &LandingView::TooManyPending {
                token,
                web: configured_browser_app_url().await.is_some(),
            },
        ),
        Err(_) => landing_response(StatusCode::INTERNAL_SERVER_ERROR, &LandingView::Unavailable),
    }
}
