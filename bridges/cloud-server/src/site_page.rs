//! The kordi.ai page frame for pages the server renders itself: the group
//! and app invitation pages and the connector sign-in result.
//!
//! The pages use the home page's fonts, colors, type scale, buttons, header
//! and footer. They are served on the site's origin, so Geist loads from the
//! site's own font files; a system sans-serif stands in when the files are not
//! there. Styles are inline and the pages have no scripts.

/// The home page's Geist files, colors and shared elements.
pub(crate) const SITE_CSS: &str = r#"
    @font-face { font-family: Geist; src: url("/research-preview/public/assets/fonts/geist-400.ttf") format("truetype"); font-weight: 400; font-style: normal; font-display: swap; }
    @font-face { font-family: Geist; src: url("/research-preview/public/assets/fonts/geist-500.ttf") format("truetype"); font-weight: 500; font-style: normal; font-display: swap; }
    @font-face { font-family: Geist; src: url("/research-preview/public/assets/fonts/geist-600.ttf") format("truetype"); font-weight: 600; font-style: normal; font-display: swap; }
    :root { color-scheme: light; --paper: #fcfaf8; --paper-alt: #f5eeea; --ink: #191817; --muted: #6d6865; --rule: #e8ddd8; --cardinal: #8c1515; --deep-red: #651010; --button-ink: #fffaf6; --selected: #f0e0da; --body: Geist, "Helvetica Neue", sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { min-height: 100vh; margin: 0; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font: 400 1.0625rem/1.65 var(--body); font-kerning: normal; -webkit-font-smoothing: antialiased; }
    h1, h2, p { margin: 0; }
    h1 { overflow-wrap: anywhere; font-family: var(--body); font-size: clamp(2.5rem, 1.6rem + 2.6vw, 3.75rem); font-weight: 600; line-height: 1.06; letter-spacing: -.045em; text-wrap: balance; }
    a { color: var(--cardinal); text-underline-offset: 4px; }
    a:hover { color: var(--deep-red); }
    :focus-visible { outline: 2px solid var(--cardinal); outline-offset: 4px; }
    .wrap { width: min(100%, 1440px); margin-inline: auto; padding-inline: clamp(1.5rem, 6.5vw, 6rem); }
    .mast { min-height: 80px; display: flex; align-items: center; }
    .brand { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); text-decoration: none; }
    .brand:hover { color: var(--ink); }
    .brand svg { width: 32px; height: 32px; flex: none; }
    .brand span { font-size: 1.5rem; font-weight: 600; line-height: 1; letter-spacing: -.045em; }
    main { flex: 1 0 auto; }
    .button { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: .8rem 1.75rem; border: 1px solid var(--cardinal); border-radius: 999px; background: var(--cardinal); color: var(--button-ink); font: 500 1rem/1.45 var(--body); text-decoration: none; white-space: nowrap; cursor: pointer; transition: transform 160ms cubic-bezier(.23, 1, .32, 1), background-color 160ms ease, border-color 160ms ease; }
    .button:hover { color: var(--button-ink); background: var(--deep-red); border-color: var(--deep-red); transform: translateY(-2px); }
    .button:active { transform: scale(.98); }
    .button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; }
    .button-secondary { border-color: var(--ink); background: transparent; color: var(--ink); }
    .button-secondary:hover { color: var(--cardinal); background: #f6e9e5; border-color: var(--cardinal); }
    footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .45rem 1rem; padding-block: 32px 48px; }
    footer .brand svg { width: 28px; height: 28px; }
    footer .brand span { font-size: 1.25rem; }
    footer nav { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; }
    footer nav a { min-height: 44px; display: inline-flex; align-items: center; color: var(--muted); font-size: .875rem; text-decoration: none; white-space: nowrap; }
    @media (max-width: 900px) { .wrap { padding-inline: clamp(16px, 5vw, 4rem); } }
    @media (max-width: 680px) {
      .mast { justify-content: center; }
      h1 { font-size: clamp(2.125rem, 9vw, 2.75rem); }
      .button { padding: .75rem 1.25rem; font-size: .9375rem; }
      footer { justify-content: center; gap: 12px 24px; padding-block: 24px 72px; }
      footer nav { justify-content: center; gap: 16px; }
    }
    @media (prefers-reduced-motion: reduce) { .button { transition: none; } .button:hover, .button:active { transform: none; } }
"#;

/// The home page's bird: a dark body with a yellow beak. `id` names the
/// mask, so a page with two birds keeps its ids unique.
pub(crate) fn bird(id: &str) -> String {
    format!(
        "<svg viewBox='64 58 384 384' aria-hidden='true'><mask id='{id}' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'><ellipse cx='262' cy='292' rx='150' ry='136' fill='#fff'/><path d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='#fff' stroke='#fff' stroke-width='4' stroke-linejoin='round'/><circle cx='194' cy='266' r='17'/><path d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/></mask><g transform='translate(256,250) scale(0.94) translate(-270,-292)'><path d='M120,276 L82,294 L120,312Z' fill='#f7b32b' stroke='#f7b32b' stroke-width='12' stroke-linejoin='round'/><rect x='-100' y='-100' width='712' height='712' fill='#1f1a17' mask='url(#{id})'/></g></svg>"
    )
}

/// The home page's header: the bird and the wordmark. `home` is the escaped
/// home page URL ending in `/`.
pub(crate) fn site_header(home: &str) -> String {
    format!(
        r#"<header class="wrap mast"><a class="brand" href="{home}" aria-label="Kordi home">{}<span>kordi</span></a></header>"#,
        bird("kordi-bird-head")
    )
}

/// The home page's footer: the bird, the wordmark and the same links.
pub(crate) fn site_footer(home: &str) -> String {
    format!(
        r#"<footer class="wrap"><a class="brand" href="{home}">{}<span>kordi</span></a><nav aria-label="Footer"><a href="https://github.com/Kordi-AI/Kordi">GitHub</a><a href="https://github.com/Kordi-AI/Kordi/blob/main/LICENSE">MIT License</a><a href="{home}about">About</a><a href="{home}download">Download</a><a href="{home}privacy">Privacy policy</a><a href="{home}terms">Terms</a></nav></footer>"#,
        bird("kordi-bird-foot")
    )
}

/// A one-line page in the frame, for results such as a finished connector
/// sign-in. `title` and `message` are plain text.
pub(crate) fn message_page(title: &str, message: &str, home: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" sizes="512x512" href="/assets/favicon.png">
  <title>{title} · Kordi</title>
  <style>{SITE_CSS}
    .message {{ display: grid; align-content: center; justify-items: center; gap: 16px; padding-block: clamp(48px, 10vh, 96px); text-align: center; }}
    .message p {{ max-width: 44ch; color: var(--muted); font-size: 1.125rem; }}
  </style>
</head>
<body>
  {header}
  <main class="wrap message">
    <h1>{title}</h1>
    <p>{message}</p>
  </main>
  {footer}
</body>
</html>"#,
        title = escape(title),
        message = escape(message),
        header = site_header(home),
        footer = site_footer(home),
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_uses_the_home_page_fonts_and_no_serif() {
        assert!(SITE_CSS.contains("/research-preview/public/assets/fonts/geist-400.ttf"));
        assert!(SITE_CSS.contains("--body: Geist, \"Helvetica Neue\", sans-serif;"));
        assert!(!SITE_CSS.contains("Marcellus"));
        assert!(!SITE_CSS.contains("monospace"));
    }

    #[test]
    fn message_page_escapes_and_has_no_script() {
        let page = message_page("Connected", "Return to <Kordi> & go", "https://kordi.ai/");
        assert!(page.contains("Return to &lt;Kordi&gt; &amp; go"));
        assert!(page.contains(r#"href="https://kordi.ai/privacy">Privacy policy</a>"#));
        assert!(page.contains("mask='url(#kordi-bird-head)'"));
        assert!(page.contains("mask='url(#kordi-bird-foot)'"));
        assert!(!page.contains("<script"));
    }
}
