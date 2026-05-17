use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

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
  <title>Kordi sign-in</title>
  <style>{style}</style>
</head>
<body>
  <div class="page" aria-hidden="false">
    <div class="page-grain" aria-hidden="true"></div>
    <main class="card" role="status" aria-live="polite">
      <div class="auth-label">KORDI AUTHENTICATION</div>

      <span class="state-marker" data-status-loading aria-hidden="true"></span>
      <span class="state-marker" data-status-success aria-hidden="true"></span>
      <span class="state-marker" data-status-error aria-hidden="true"></span>

      <div class="copy">
        <h1 class="title" data-title-loading>Completing Authentication</h1>
        <h1 class="title" data-title-success>Authentication Successful</h1>
        <h1 class="title" data-title-error>Authentication Failed</h1>

        <p class="subtitle" data-sub-loading>Finishing the browser handoff with Kordi.</p>
        <p class="subtitle" data-sub-success>You can close this tab and return to Kordi.</p>
        <p class="subtitle" data-sub-error>Return to Kordi and try signing in again.</p>
      </div>
    </main>
  </div>
  <script>{script}</script>
</body>
</html>"#,
        style = completion_page_css(),
        script = completion_page_script(request_id),
    )
}

// Self-contained callback page matching OAuth provider confirmation pages:
// a dark ambient canvas, one centered confirmation card, and no external
// assets. It intentionally avoids the in-app cream surface because this page
// lives in the browser after provider auth rather than inside the desktop UI.
fn completion_page_css() -> &'static str {
    r#"
    :root {
      color-scheme: dark light;
      --page-bg: oklch(0.145 0.006 250);
      --page-bg-deep: oklch(0.105 0.004 250);
      --glow-a: oklch(0.72 0.010 250 / 0.34);
      --glow-b: oklch(0.50 0.012 250 / 0.18);
      --surface: oklch(0.165 0.006 250 / 0.78);
      --surface-top: oklch(0.22 0.006 250 / 0.22);
      --border: oklch(0.50 0.006 250 / 0.26);
      --label-border: oklch(0.72 0.010 250 / 0.22);
      --label-bg: oklch(0.28 0.006 250 / 0.22);
      --ink-strong: oklch(0.985 0.004 250);
      --ink-soft: oklch(0.82 0.010 250);
      --ink-muted: oklch(0.70 0.010 250);
      --shadow: oklch(0 0 0 / 0.34);
    }

    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; }
    }

    @media (prefers-color-scheme: light) {
      :root {
        --page-bg: oklch(0.18 0.006 250);
        --page-bg-deep: oklch(0.12 0.004 250);
      }
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: var(--ink-soft);
      background:
        radial-gradient(circle at 50% 23%, oklch(0.86 0 0 / 0.20), transparent 24rem),
        radial-gradient(circle at 42% 42%, oklch(0.66 0.006 250 / 0.22), transparent 30rem),
        linear-gradient(180deg, var(--page-bg) 0%, var(--page-bg-deep) 78%);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: geometricPrecision;
    }

    .page {
      position: relative;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      overflow: hidden;
    }
    .page::before {
      content: "";
      position: absolute;
      width: min(900px, 78vw);
      height: min(520px, 52vh);
      left: 50%;
      top: 33%;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background:
        radial-gradient(circle at 50% 44%, var(--glow-a), transparent 58%),
        radial-gradient(circle at 46% 66%, var(--glow-b), transparent 72%);
      filter: blur(52px);
      opacity: 0.92;
      pointer-events: none;
    }
    .page-grain {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: radial-gradient(circle at 50% 50%, transparent 0 42%, oklch(0 0 0 / 0.34) 100%);
    }

    .card {
      position: relative;
      width: min(740px, calc(100vw - 64px));
      min-height: 250px;
      padding: 50px 64px 48px;
      overflow: hidden;
      display: grid;
      justify-items: center;
      align-content: center;
      gap: 26px;
      text-align: center;
      background:
        linear-gradient(180deg, var(--surface-top), transparent 42%),
        var(--surface);
      border: 1px solid var(--border);
      border-radius: 42px;
      box-shadow:
        inset 0 1px 0 oklch(1 0 0 / 0.045),
        0 30px 86px -44px var(--shadow),
        0 8px 28px -22px oklch(0 0 0 / 0.80);
      animation: card-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes card-enter {
      from { opacity: 0; transform: translate3d(0, 6px, 0) scale(0.996); }
      to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }

    .auth-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 7px 18px 6px;
      border: 1px solid var(--label-border);
      border-radius: 999px;
      background: var(--label-bg);
      color: var(--ink-soft);
      font-size: 14px;
      line-height: 1;
      font-weight: 640;
      letter-spacing: 0.20em;
      text-transform: uppercase;
    }

    .state-marker { display: none; }
    .copy {
      display: grid;
      justify-items: center;
      gap: 20px;
    }
    .title {
      display: none;
      margin: 0;
      color: var(--ink-strong);
      font-size: clamp(34px, 4vw, 50px);
      line-height: 1.04;
      font-weight: 780;
      letter-spacing: -0.055em;
      animation: text-fade 300ms cubic-bezier(0.22, 1, 0.36, 1) both 90ms;
    }
    .subtitle {
      display: none;
      margin: 0;
      max-width: 26ch;
      color: var(--ink-soft);
      font-size: clamp(18px, 2vw, 23px);
      line-height: 1.55;
      font-weight: 570;
      letter-spacing: -0.018em;
      text-wrap: balance;
      animation: text-fade 300ms cubic-bezier(0.22, 1, 0.36, 1) both 140ms;
    }
    [data-status="loading"] [data-title-loading],
    [data-status="loading"] [data-sub-loading],
    [data-status="success"] [data-title-success],
    [data-status="success"] [data-sub-success],
    [data-status="error"]   [data-title-error],
    [data-status="error"]   [data-sub-error] { display: block; }

    @keyframes text-fade {
      from { opacity: 0; transform: translate3d(0, 3px, 0); }
      to   { opacity: 1; transform: translate3d(0, 0, 0); }
    }

    @media (max-width: 640px) {
      .page { padding: 20px; }
      .card {
        width: 100%;
        min-height: 230px;
        padding: 38px 28px 36px;
        border-radius: 34px;
      }
      .auth-label { font-size: 12px; letter-spacing: 0.16em; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card, .title, .subtitle { animation: none; }
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
      // swap the visible pill + title + subtitle without any flash.
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
    use super::completion_page_html;

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
            html.contains("KORDI AUTHENTICATION"),
            "page should render the compact authentication label"
        );

        // All three state blocks must be present so the swap between them is
        // just an attribute flip, never a layout shift.
        for status in [
            "data-status-loading",
            "data-status-success",
            "data-status-error",
        ] {
            assert!(html.contains(status), "missing status state: {status}");
        }
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

        assert!(html.contains("Completing Authentication"));
        assert!(html.contains("Authentication Successful"));
        assert!(html.contains("Authentication Failed"));
        assert!(html.contains("You can close this tab and return to Kordi."));
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

        // The OAuth callback should align with provider callback pages: dark,
        // centered, and quiet by default, with a blurred ambient field behind
        // a single confirmation card.
        assert!(
            html.contains("--page-bg: oklch(0.145 0.006 250)"),
            "default page bg should be the dark callback surface"
        );
        assert!(
            html.contains("filter: blur(52px)"),
            "page should carry the soft blurred provider-callback glow"
        );
        assert!(
            html.contains("prefers-color-scheme: dark"),
            "dark mode must be supported"
        );
        assert!(
            html.contains("prefers-reduced-motion: reduce"),
            "reduced motion must collapse animations"
        );
    }

    #[test]
    fn uses_provider_callback_system_font_stack() {
        let html = completion_page_html("cloud_oauth_font");

        assert!(
            html.contains("-apple-system, BlinkMacSystemFont"),
            "callback page should use the same system font stack as the provider-style confirmation page"
        );
        assert!(
            !html.contains("Avenir Next"),
            "callback page should not use the previous Kordi in-app display font"
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
