//! Shared invitation landing markup, actions, and response security headers.

use super::*;

pub(super) fn invitation_landing_document(
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
    invitation_landing_document_with_actions(
        title,
        message,
        open_action,
        None,
        release_download_url,
    )
}

pub(super) fn invitation_landing_document_with_actions(
    title: &str,
    message: &str,
    open_action: Option<(&str, &str)>,
    browser_url: Option<&str>,
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
    let browser_action = browser_url
        .map(|url| {
            format!(
                r#"<a class="button button-secondary" href="{}">Open in browser</a>"#,
                escape_html(url),
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

    let homepage = escape_html(&homepage_url());
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="{favicon_url}">
  <title>{escaped_title} · Kordi</title>
  <style>{site_css}
    main {{ display: flex; align-items: center; padding-block: clamp(48px, 10vh, 112px); }}
    .content {{ max-width: 760px; min-width: 0; }}
    .content h1 {{ max-width: 16ch; font-size: clamp(2.5rem, 1.4rem + 3.6vw, 4.25rem); }}
    .content p {{ max-width: 44ch; margin-top: 24px; color: var(--muted); font-size: clamp(1.125rem, 1rem + .45vw, 1.375rem); font-weight: 500; line-height: 1.45; }}
    .actions {{ display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 32px; }}
    @media (max-width: 680px) {{
      .content h1 {{ font-size: clamp(2.125rem, 9vw, 2.75rem); }}
      .content p {{ font-size: 1.0625rem; }}
      .actions {{ display: grid; }}
      .button {{ width: 100%; }}
    }}
  </style>
</head>
<body>
  {header}
  <main class="wrap">
    <section class="content">
      <h1>{escaped_title}</h1>
      <p>{escaped_message}</p>
      <div class="actions">
        {open_action}
        {browser_action}
        {download_action}
        <a class="{learn_more_class}" href="{homepage}">Learn more</a>
      </div>
    </section>
  </main>
  {footer}
</body>
</html>"#,
        favicon_url = KORDI_FAVICON_URL,
        site_css = crate::site_page::SITE_CSS,
        header = crate::site_page::site_header(&homepage),
        footer = crate::site_page::site_footer(&homepage),
    )
}

pub(super) fn invitation_landing_html(
    status: StatusCode,
    title: &str,
    message: &str,
    release_download_url: Option<&str>,
) -> Response {
    invitation_landing_html_with_open_action(status, title, message, None, release_download_url)
}

pub(in crate::auth::routes) fn invitation_landing_html_with_open_action(
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

    invitation_landing_response(status, body)
}

pub(in crate::auth::routes) fn invitation_landing_html_with_browser_action(
    status: StatusCode,
    title: &str,
    message: &str,
    open_action: Option<(&str, &str)>,
    browser_url: Option<&str>,
    release_download_url: Option<&str>,
) -> Response {
    invitation_landing_response(
        status,
        invitation_landing_document_with_actions(
            title,
            message,
            open_action,
            browser_url,
            release_download_url,
        ),
    )
}

fn invitation_landing_response(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            ("cache-control", "no-store"),
            (
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
        ],
        Html(body),
    )
        .into_response()
}
