use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const KORDI_FAVICON_DATA_URL: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Ccircle cx='18' cy='10' r='9' fill='%231a1714' fill-opacity='.62'/%3E%3Ccircle cx='11' cy='22' r='9' fill='%231a1714' fill-opacity='.82'/%3E%3Ccircle cx='25' cy='22' r='9' fill='%231a1714'/%3E%3C/svg%3E";

#[derive(Default)]
pub struct CloudOAuthLoopbackState {
    pending: Mutex<HashMap<String, oneshot::Receiver<Result<String, String>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOAuthLoopbackStart {
    request_id: String,
    redirect_url: String,
}

#[tauri::command]
pub async fn cloud_oauth_loopback_prepare(
    state: State<'_, CloudOAuthLoopbackState>,
) -> Result<CloudOAuthLoopbackStart, String> {
    let request_id = format!("cloud_oauth_{}", uuid::Uuid::new_v4().simple());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("Unable to start local OAuth callback listener: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Unable to read local OAuth callback address: {err}"))?
        .port();
    let redirect_url = format!("http://127.0.0.1:{port}/oauth/{request_id}");
    let (tx, rx) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .insert(request_id.clone(), rx);

    tokio::spawn(run_loopback_listener(listener, request_id.clone(), tx));

    Ok(CloudOAuthLoopbackStart {
        request_id,
        redirect_url,
    })
}

#[tauri::command]
pub async fn cloud_oauth_loopback_wait(
    state: State<'_, CloudOAuthLoopbackState>,
    request_id: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let rx = state
        .pending
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .remove(request_id.trim())
        .ok_or_else(|| "OAuth callback was not started.".to_string())?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(180_000).clamp(1_000, 600_000));
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("OAuth callback listener stopped before sign-in completed.".to_string()),
        Err(_) => Err("OAuth sign-in timed out. Try again.".to_string()),
    }
}

async fn run_loopback_listener(
    listener: TcpListener,
    request_id: String,
    tx: oneshot::Sender<Result<String, String>>,
) {
    let mut sender = Some(tx);
    let deadline = tokio::time::sleep(Duration::from_secs(5 * 60));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                if let Some(tx) = sender.take() {
                    let _ = tx.send(Err("OAuth sign-in timed out. Try again.".to_string()));
                }
                return;
            }
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue; };
                let completed = handle_loopback_connection(stream, &request_id, &mut sender).await;
                if completed {
                    return;
                }
            }
        }
    }
}

async fn handle_loopback_connection(
    mut stream: TcpStream,
    request_id: &str,
    sender: &mut Option<oneshot::Sender<Result<String, String>>>,
) -> bool {
    let mut buffer = vec![0_u8; 64 * 1024];
    let Ok(read) = stream.read(&mut buffer).await else {
        return false;
    };
    if read == 0 {
        return false;
    }
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut lines = request.lines();
    let first = lines.next().unwrap_or_default();

    if first.starts_with("GET ") {
        let html = completion_page_html(request_id);
        let _ = write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            html.as_bytes(),
        )
        .await;
        return false;
    }

    if first.starts_with("POST ") && first.contains(&format!("/complete/{request_id}")) {
        let body = request
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or_default()
            .trim()
            .to_string();
        let _ = write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", b"OK").await;
        if let Some(tx) = sender.take() {
            let _ = tx.send(Ok(body));
        }
        return true;
    }

    let _ = write_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"Not found",
    )
    .await;
    false
}

async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

fn completion_page_html(request_id: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en" data-status="loading">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <link rel="icon" type="image/svg+xml" href="{favicon}" />
  <title>Kordi sign-in</title>
  <style>{style}</style>
</head>
<body>
  <div class="page">
    <header>
      <div class="wrap">
        <div class="brand" aria-label="Kordi">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="10" r="9" fill="currentColor" opacity=".62"></circle>
            <circle cx="11" cy="22" r="9" fill="currentColor" opacity=".82"></circle>
            <circle cx="25" cy="22" r="9" fill="currentColor"></circle>
          </svg>
          <span>kordi</span>
        </div>
      </div>
    </header>
    <main class="wrap" role="status" aria-live="polite">
      <section class="copy">
        <h1 data-title-loading>Completing sign-in.</h1>
        <h1 data-title-success>Signed in.</h1>
        <h1 data-title-error>Couldn’t sign in.</h1>

        <p data-sub-loading>Finishing the secure browser handoff to Kordi.</p>
        <p data-sub-success>Your account is connected. You can close this window and return to Kordi.</p>
        <p data-sub-error>Return to Kordi and try signing in again.</p>
      </section>
    </main>
    <footer>&copy; Kordi 2026</footer>
  </div>
  <script>{script}</script>
</body>
</html>"#,
        style = completion_page_css(),
        script = completion_page_script(request_id),
        favicon = KORDI_FAVICON_DATA_URL,
    )
}

// This callback is served by a short-lived loopback listener, so it must remain
// self-contained. Its visual language mirrors Kordi's public web surfaces
// without loading external fonts or assets.
fn completion_page_css() -> &'static str {
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
      display: none;
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
      display: none;
      max-width: 43ch;
      margin: 18px 0 0;
      color: var(--ink-muted);
      font-size: 15px;
      line-height: 1.65;
      text-wrap: balance;
    }
    [data-status="loading"] [data-title-loading],
    [data-status="loading"] [data-sub-loading],
    [data-status="success"] [data-title-success],
    [data-status="success"] [data-sub-success],
    [data-status="error"]   [data-title-error],
    [data-status="error"]   [data-sub-error] { display: block; }
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

fn completion_page_script(request_id: &str) -> String {
    format!(
        r#"
    (function() {{
      const root = document.documentElement;
      // The page boots in `loading` state via the data attribute on <html>;
      // we toggle to `success` / `error` after the POST resolves so CSS can
      // swap the visible title + subtitle without any flash.
      function setStatus(next) {{ root.setAttribute('data-status', next); }}

      fetch('/complete/{request_id}', {{
        method: 'POST',
        headers: {{ 'content-type': 'text/plain' }},
        body: window.location.hash || '',
      }})
        .then(function(res) {{ setStatus(res && res.ok ? 'success' : 'error'); }})
        .catch(function() {{ setStatus('error'); }});
    }})();
    "#
    )
}

#[cfg(test)]
mod completion_page_tests {
    use super::{completion_page_html, KORDI_FAVICON_DATA_URL};

    #[test]
    fn renders_kordi_wordmark_and_boots_in_loading_state() {
        let html = completion_page_html("cloud_oauth_abc123");

        // Page boots into the loading state via the data attribute on <html>,
        // so the success / error markup is pre-rendered but hidden until JS
        // toggles the attribute. That keeps the layout stable across states.
        assert!(
            html.contains("data-status=\"loading\""),
            "page should boot in loading state"
        );
        assert!(
            !html.contains("auth-label"),
            "page should not render a visible label chip"
        );

        assert!(html.contains("<span>kordi</span>"));
        assert!(html.contains("rel=\"icon\" type=\"image/svg+xml\""));
        assert!(html.contains(KORDI_FAVICON_DATA_URL));
        assert_eq!(html.matches("<circle ").count(), 3);
        assert!(html.contains("&copy; Kordi 2026"));
        assert!(!html.contains("state-marker"));

        // All three copy blocks are pre-rendered so the swap between them is
        // just an attribute flip, never a layout shift.
        for title in [
            "data-title-loading",
            "data-title-success",
            "data-title-error",
        ] {
            assert!(html.contains(title), "missing title state: {title}");
        }
        for sub in ["data-sub-loading", "data-sub-success", "data-sub-error"] {
            assert!(html.contains(sub), "missing subtitle state: {sub}");
        }
    }

    #[test]
    fn copy_matches_brand_voice_for_each_state() {
        let html = completion_page_html("cloud_oauth_abc123");

        assert!(!html.contains("KORDI LOGIN"));
        assert!(html.contains("Completing sign-in"));
        assert!(html.contains("Signed in"));
        assert!(html.contains("Couldn’t sign in"));
        assert!(html
            .contains("Your account is connected. You can close this window and return to Kordi."));
        assert!(html.contains("Finishing the secure browser handoff to Kordi."));
        assert!(html.contains("Return to Kordi and try signing in again."));
        assert!(!html.contains("Kordi is ready in the app"));
        assert!(!html.contains("This window will update automatically"));
        assert!(!html.contains("No account changes were made"));
        assert!(!html.contains("Close window"));
        assert!(!html.contains("<button"));
        assert!(
            !html.contains("Authentication Successful") && !html.contains("Login Successful"),
            "cloud login callback should use direct signed-in copy"
        );
        assert!(
            !html.contains("READY"),
            "status should not use the large repeated pill treatment"
        );
        assert!(
            !html.contains("Kordi sign-in complete"),
            "success title should not repeat the wordmark"
        );
    }

    #[test]
    fn script_posts_to_complete_endpoint_with_request_id() {
        let html = completion_page_html("cloud_oauth_xyz789");
        assert!(
            html.contains("/complete/cloud_oauth_xyz789"),
            "completion POST should target the request-specific endpoint"
        );
        assert!(
            html.contains("method: 'POST'"),
            "completion ping must be a POST so the loopback server flips status"
        );
    }

    #[test]
    fn page_carries_brand_palette_and_dark_mode_support() {
        let html = completion_page_html("cloud_oauth_palette");

        // The callback uses the same warm paper, ink, rules, and simple
        // header/content/footer structure as Kordi's public web surfaces.
        assert!(
            html.contains("--paper: #faf9f7"),
            "light mode should use the Kordi paper surface"
        );
        assert!(
            html.contains("--paper: #191814"),
            "dark mode should use the Kordi dark paper surface"
        );
        assert!(html.contains("grid-template-rows: auto 1fr auto"));
        assert!(html.contains("text-align: center"));
        assert!(
            html.contains("prefers-color-scheme: dark"),
            "dark mode must be supported"
        );
        assert!(!html.contains("linear-gradient"));
        assert!(!html.contains("filter: blur"));
        assert!(!html.contains("animation:"));
    }

    #[test]
    fn uses_self_contained_kordi_typography_and_scale() {
        let html = completion_page_html("cloud_oauth_font");

        assert!(
            html.contains("-apple-system, BlinkMacSystemFont"),
            "body copy should use the platform system stack"
        );
        assert!(
            html.contains("\"Iowan Old Style\", \"Palatino Linotype\", Palatino, Georgia, serif"),
            "display copy should use the self-contained Kordi serif stack"
        );
        assert!(
            !html.contains("text-transform: uppercase"),
            "callback label should not force the kordi wordmark into capitals"
        );
        assert!(
            html.contains("font-size: clamp(48px, 8vw, 72px);"),
            "callback title should use the approved Kordi display scale"
        );
        assert!(
            html.contains("font-size: 15px;"),
            "callback subtitle should use the shared compact callback scale"
        );
        assert!(
            !html.contains("Avenir Next"),
            "callback page should not use the previous display font"
        );
    }

    #[test]
    fn page_has_no_external_network_or_banned_design_patterns() {
        let html = completion_page_html("cloud_oauth_selfcontained");

        // The loopback server can't proxy external assets and we don't want
        // the callback page to phone home, so the page must be self-contained.
        for forbidden in ["fonts.googleapis", "fonts.gstatic", "cdn.", "https://"] {
            assert!(
                !html.contains(forbidden),
                "callback page must not reference external URL: {forbidden}"
            );
        }

        // Anti-slop checks: gradient-fill text and side-stripe borders are
        // bans from the Kordi design context (.impeccable.md).
        assert!(!html.contains("background-clip: text"));
        assert!(!html.contains("border-left: 4px"));
        assert!(!html.contains("border-left: 3px"));
        assert!(!html.contains("class=\"card\""));
        assert!(
            !html.contains("<path"),
            "the removed status icon must stay removed"
        );
    }
}

#[cfg(test)]
mod completion_page_preview {
    use super::completion_page_html;
    use std::fs;

    // Gated on KORDI_RENDER_OAUTH_CALLBACK to keep CI runs from writing files.
    // Run with: KORDI_RENDER_OAUTH_CALLBACK=1 cargo test -p kordi-desktop --lib completion_page_preview -- --nocapture
    #[test]
    fn render_to_tmp() {
        if std::env::var("KORDI_RENDER_OAUTH_CALLBACK").is_err() {
            return;
        }
        let html = completion_page_html("preview");
        let path = std::env::temp_dir().join("kordi-oauth-callback.html");
        fs::write(&path, &html).expect("write preview");
        println!("preview: {}", path.display());
    }
}
