//! The document around the group invitation page: the kordi.ai log-in and
//! sign-up layout ([`crate::site_story`]) with the invitation in place of the
//! form, and the home page's footer. Styles are inline and the page has no
//! scripts.

use super::landing::SIGN_IN_RETURN_PARAM;
use super::*;
use crate::site_story::{story_header, story_main, NavAccounts, STORY_CSS};

/// The card's own pieces: the group tile, the heading, its line, the actions
/// and the signed-in account chip.
const CARD_CSS: &str = r#"
    .x-auth-card { display: grid; justify-items: center; text-align: center; }
    .tile { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 16px; border: 1px solid var(--rule); background: #fcfbf9; color: var(--cardinal); }
    .tile svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .x-auth-card h1 { margin-top: 24px; font-size: clamp(1.75rem, 1.4rem + .9vw, 2.25rem); line-height: 1.15; letter-spacing: -.035em; }
    .x-auth-card > p { margin-top: 12px; color: var(--muted); font-size: 1.0625rem; line-height: 1.6; }
    .actions { width: 100%; display: grid; gap: 10px; margin: 28px 0 0; }
    .actions .button { width: 100%; }
    .x-auth-card > .quiet { margin-top: 28px; font-size: .9375rem; }
    .quiet a { font-weight: 500; }
    .who { display: inline-flex; align-items: center; gap: 8px; margin-top: 24px; padding: 6px 14px 6px 6px; border: 1px solid var(--rule); border-radius: 999px; color: var(--muted); font-size: .9375rem; }
    .who span:first-child { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 999px; background: var(--paper-alt); color: var(--ink); font-size: .75rem; font-weight: 500; }
    @media (max-width: 760px) { .x-auth-card h1 { margin-top: 20px; font-size: 1.375rem; } .x-auth-card > p { margin-top: 8px; font-size: 1rem; } }
"#;

/// `return_to` is this invitation's path for the header's Log in and Sign
/// up; without it the header has no account links.
pub(super) fn page_shell(title: &str, content: &str, return_to: Option<&str>) -> String {
    let home = escape_html(&homepage_url());
    let accounts = return_to.map(|path| {
        let back = escape_html(&format!(
            "{SIGN_IN_RETURN_PARAM}={}",
            path.replace('/', "%2F")
        ));
        (format!("/login?{back}"), format!("/register?{back}"))
    });
    let header = story_header(
        &home,
        accounts
            .as_ref()
            .map(|(login, register)| NavAccounts { login, register }),
    );
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="{favicon_url}">
  <title>{title} · Kordi</title>
  <style>{site_css}{STORY_CSS}{CARD_CSS}  </style>
</head>
<body class="interior-page x-auth-page">
  {header}
  {main}
  {footer}
</body>
</html>"#,
        favicon_url = KORDI_FAVICON_URL,
        title = escape_html(title),
        site_css = crate::site_page::SITE_CSS,
        main = story_main(content),
        footer = crate::site_page::site_footer(&home),
    )
}
