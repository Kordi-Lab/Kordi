//! The document around the group invitation page: the invitation landing
//! palette and header, with a centered card. Styles are inline and the page
//! has no scripts.

use super::*;

pub(super) fn page_shell(title: &str, content: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="{favicon_url}">
  <title>{title} · Kordi</title>
  <style>
    @font-face {{ font-family: "Marcellus"; src: url("/assets/fonts/marcellus-latin.woff2") format("woff2"); font-display: swap; }}
    :root {{ color-scheme: light dark; --paper: #faf9f7; --ink: #1a1714; --ink-2: #5c554d; --ink-3: #746d65; --rule: rgba(26, 23, 20, .1); }}
    * {{ box-sizing: border-box; }}
    body {{ min-height: 100vh; margin: 0; display: grid; grid-template-rows: auto 1fr; background: var(--paper); color: var(--ink); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    header {{ min-height: 68px; display: flex; align-items: center; padding-inline: 4rem; border-bottom: 1px solid var(--rule); }}
    .brand {{ display: inline-flex; align-items: center; gap: 9px; color: var(--ink); font-family: "Marcellus", Optima, Candara, serif; font-size: 23px; line-height: 1; text-decoration: none; }}
    .brand svg {{ width: 31px; height: 31px; }}
    main {{ display: grid; place-items: center; padding: 3rem 1rem 6rem; }}
    .card {{ width: min(100%, 400px); display: grid; justify-items: center; text-align: center; }}
    .tile {{ width: 56px; height: 56px; display: grid; place-items: center; border-radius: 16px; border: 1px solid var(--rule); color: var(--ink-2); }}
    .tile svg {{ width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }}
    h1 {{ margin: 1.25rem 0 0; overflow-wrap: anywhere; font-family: "Marcellus", Optima, Candara, serif; font-weight: 400; font-size: 2.1rem; line-height: 1.12; letter-spacing: -.02em; text-wrap: balance; }}
    p {{ margin: .6rem 0 0; color: var(--ink-2); font-size: .95rem; line-height: 1.5; }}
    .actions {{ width: 100%; display: grid; gap: .6rem; margin: 1.8rem 0 0; }}
    .button {{ min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: 6px; border: 1px solid var(--ink); font: inherit; font-size: 14px; font-weight: 500; text-decoration: none; cursor: pointer; }}
    .button-primary {{ background: var(--ink); color: var(--paper); }}
    .button-secondary {{ border-color: var(--rule); background: transparent; color: var(--ink); }}
    .button:focus-visible, .brand:focus-visible, .quiet a:focus-visible {{ outline: 2px solid var(--ink); outline-offset: 3px; }}
    .quiet {{ margin-top: 1.2rem; font-size: .82rem; color: var(--ink-3); }}
    .quiet a {{ color: var(--ink); text-underline-offset: 3px; }}
    .who {{ display: inline-flex; align-items: center; gap: 8px; margin-top: 1.2rem; padding: 6px 12px 6px 6px; border: 1px solid var(--rule); border-radius: 999px; font-size: .82rem; color: var(--ink-2); }}
    .who span:first-child {{ width: 22px; height: 22px; display: grid; place-items: center; border-radius: 999px; background: #3f6fb5; color: #fff; font-size: 10px; font-weight: 600; }}
    @media (prefers-color-scheme: dark) {{
      :root {{ --paper: #191814; --ink: #f2efe9; --ink-2: #b8b0a7; --ink-3: #8d857c; --rule: rgba(242, 239, 233, .1); }}
    }}
    @media (max-width: 600px) {{ header {{ padding-inline: 1.25rem; }} }}
  </style>
</head>
<body>
  <header>
    <a class="brand" href="{homepage}" aria-label="Kordi home">{bird}<span>kordi</span></a>
  </header>
  <main>
    <section class="card">
        {content}
    </section>
  </main>
</body>
</html>"#,
        favicon_url = KORDI_FAVICON_URL,
        title = escape_html(title),
        homepage = escape_html(&homepage_url()),
        bird = KORDI_BIRD_SVG,
    )
}
