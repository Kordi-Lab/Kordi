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

    let homepage = homepage_url();
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="{favicon_url}">
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
        <a class="brand" href="{homepage}" aria-label="Kordi home">
          <svg viewBox='64 58 384 384' aria-hidden='true'><mask id='kordi-bird-cut' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'><ellipse cx='262' cy='292' rx='150' ry='136' fill='#fff'/><path d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='#fff' stroke='#fff' stroke-width='4' stroke-linejoin='round'/><circle cx='194' cy='266' r='17'/><path d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/></mask><g transform='translate(256,250) scale(0.94) translate(-270,-292)'><path d='M120,276 L82,294 L120,312Z' fill='currentColor' stroke='currentColor' stroke-width='12' stroke-linejoin='round'/><rect x='-100' y='-100' width='712' height='712' fill='currentColor' mask='url(#kordi-bird-cut)'/></g></svg>
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
          {browser_action}
          {download_action}
          <a class="{learn_more_class}" href="{homepage}">Learn more</a>
        </div>
      </section>
    </main>
    <footer class="wrap">&copy; Kordi 2026</footer>
  </div>
</body>
</html>"#,
        favicon_url = KORDI_FAVICON_URL,
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
