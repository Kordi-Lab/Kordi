//! The document around the group invitation page: the kordi.ai home page's
//! type, colors, header and footer, with a centered card. Styles are inline
//! and the page has no scripts.

use super::*;

pub(super) fn page_shell(title: &str, content: &str) -> String {
    let home = escape_html(&homepage_url());
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="{favicon_url}">
  <title>{title} · Kordi</title>
  <style>{site_css}
    main {{ display: grid; place-items: center; padding-block: clamp(40px, 8vh, 80px) 56px; }}
    .card {{ width: min(100%, 480px); display: grid; justify-items: center; text-align: center; }}
    .tile {{ width: 56px; height: 56px; display: grid; place-items: center; border-radius: 16px; border: 1px solid var(--rule); background: #fcfbf9; color: var(--cardinal); }}
    .tile svg {{ width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }}
    .card h1 {{ margin-top: 24px; font-size: clamp(2rem, 1rem + 2.6vw, 3.25rem); line-height: 1.1; letter-spacing: -.04em; }}
    .card > p {{ margin-top: 16px; color: var(--muted); font-size: 1.125rem; line-height: 1.6; }}
    .actions {{ width: 100%; display: grid; gap: 10px; margin: 32px 0 0; }}
    .actions .button {{ width: 100%; }}
    .card > .quiet {{ margin-top: 24px; color: var(--muted); font-size: .9375rem; }}
    .quiet a {{ font-weight: 500; }}
    .who {{ display: inline-flex; align-items: center; gap: 8px; margin-top: 24px; padding: 6px 14px 6px 6px; border: 1px solid var(--rule); border-radius: 999px; color: var(--muted); font-size: .9375rem; }}
    .who span:first-child {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: 999px; background: var(--paper-alt); color: var(--ink); font-size: .75rem; font-weight: 500; }}
    @media (max-width: 680px) {{ .card h1 {{ font-size: clamp(1.75rem, 7.4vw, 2.25rem); }} }}
  </style>
</head>
<body>
  {header}
  <main class="wrap">
    <section class="card">
        {content}
    </section>
  </main>
  {footer}
</body>
</html>"#,
        favicon_url = KORDI_FAVICON_URL,
        title = escape_html(title),
        site_css = crate::site_page::SITE_CSS,
        header = crate::site_page::site_header(&home),
        footer = crate::site_page::site_footer(&home),
    )
}
