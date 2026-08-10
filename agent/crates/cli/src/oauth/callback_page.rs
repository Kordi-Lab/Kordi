pub const KORDI_FAVICON_DATA_URL: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Ccircle cx='18' cy='10' r='9' fill='%231a1714' fill-opacity='.62'/%3E%3Ccircle cx='11' cy='22' r='9' fill='%231a1714' fill-opacity='.82'/%3E%3Ccircle cx='25' cy='22' r='9' fill='%231a1714'/%3E%3C/svg%3E";

pub fn kordi_callback_page_css() -> &'static str {
    r#"
    :root {
      color-scheme: light dark;
      --paper: #faf9f7;
      --ink: #1a1714;
      --ink-muted: #655e56;
      --footer-ink: #81786f;
      --rule: rgba(26, 23, 20, .09);
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: var(--paper);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: geometricPrecision;
    }

    .page {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .wrap { width: min(calc(100% - 4.25rem), 520px); margin-inline: auto; }
    header { min-height: 68px; display: flex; align-items: center; border-bottom: 1px solid var(--rule); }
    header .wrap { width: min(calc(100% - 4.25rem), 1312px); }
    .brand {
      width: fit-content;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      font-size: 24px;
      line-height: 1;
    }
    .brand svg { width: 30px; height: 30px; flex: 0 0 auto; }
    main { display: flex; align-items: center; padding-block: 3.5rem 4.5rem; }
    .copy { width: 100%; }
    h1 {
      max-width: 11ch;
      margin: 0;
      color: var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      font-size: clamp(48px, 8vw, 72px);
      font-weight: 400;
      line-height: .98;
      letter-spacing: -.035em;
      text-wrap: balance;
    }
    p {
      max-width: 43ch;
      margin: 18px 0 0;
      color: var(--ink-muted);
      font-size: 15px;
      line-height: 1.65;
      text-wrap: balance;
    }
    footer {
      padding: 16px 34px 18px;
      border-top: 1px solid var(--rule);
      color: var(--footer-ink);
      font-size: 11px;
      text-align: center;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #191814;
        --ink: #f2efe9;
        --ink-muted: #b8b0a7;
        --footer-ink: #938b82;
        --rule: rgba(242, 239, 233, .09);
      }
    }
    @media (max-width: 520px) {
      .wrap, header .wrap { width: calc(100% - 3.5rem); }
      main { align-items: flex-start; padding-block: 5.5rem 3.5rem; }
      h1 { font-size: clamp(48px, 16vw, 62px); }
    }
    "#
}

pub fn kordi_callback_brand_html() -> &'static str {
    r#"<div class="brand" aria-label="Kordi">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="10" r="9" fill="currentColor" opacity=".62"></circle>
            <circle cx="11" cy="22" r="9" fill="currentColor" opacity=".82"></circle>
            <circle cx="25" cy="22" r="9" fill="currentColor"></circle>
          </svg>
          <span>kordi</span>
        </div>"#
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn render_kordi_callback_page(title: &str, body: &str) -> String {
    let title = html_escape(title);
    let body = html_escape(body);
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <link rel="icon" type="image/svg+xml" href="{favicon}" />
  <title>{title} · Kordi</title>
  <style>{style}</style>
</head>
<body>
  <div class="page">
    <header><div class="wrap">{brand}</div></header>
    <main class="wrap" role="status">
      <section class="copy">
        <h1>{title}</h1>
        <p>{body}</p>
      </section>
    </main>
    <footer>&copy; Kordi 2026</footer>
  </div>
</body>
</html>"#,
        favicon = KORDI_FAVICON_DATA_URL,
        style = kordi_callback_page_css(),
        brand = kordi_callback_brand_html(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_page_uses_the_shared_brand_surface_without_a_card() {
        let html = render_kordi_callback_page("Signed in.", "Return to Kordi.");

        assert!(html.contains("<header>"));
        assert!(html.contains("<footer>"));
        assert!(html.contains("<span>kordi</span>"));
        assert!(html.contains("Signed in."));
        assert!(!html.contains("border-radius"));
        assert!(!html.contains("box-shadow"));
    }

    #[test]
    fn callback_page_escapes_status_copy() {
        let html = render_kordi_callback_page("<Signed>", "Try 'again' & return");

        assert!(html.contains("&lt;Signed&gt;"));
        assert!(html.contains("Try &#39;again&#39; &amp; return"));
        assert!(!html.contains("<Signed>"));
    }

    #[test]
    fn render_to_tmp() {
        if std::env::var("KORDI_RENDER_PROVIDER_OAUTH_CALLBACK").is_err() {
            return;
        }
        let html = render_kordi_callback_page(
            "Signed in.",
            "Your account is connected. You can close this window and return to Kordi.",
        );
        let path = std::env::temp_dir().join("kordi-provider-oauth-callback.html");
        std::fs::write(&path, html).expect("write callback preview");
        println!("preview: {}", path.display());
    }
}
