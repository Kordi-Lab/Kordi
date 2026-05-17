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
      <div class="wordmark" aria-label="Kordi">Kordi</div>

      <div class="status-line" data-status-loading>
        <span class="status-icon">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="8" cy="8" r="6" opacity="0.18" />
            <path d="M8 2 a6 6 0 0 1 6 6" />
          </svg>
        </span>
        <span>Completing sign-in</span>
      </div>

      <div class="status-line status-success" data-status-success>
        <span class="status-icon">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 8.4 6.6 11.4 12.6 5.2" />
          </svg>
        </span>
        <span>Signed in</span>
      </div>

      <div class="status-line status-error" data-status-error>
        <span class="status-icon">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
            <path d="M5 5 11 11 M11 5 5 11" />
          </svg>
        </span>
        <span>Sign-in failed</span>
      </div>

      <div class="copy">
        <h1 class="title" data-title-loading>Finishing authentication</h1>
        <h1 class="title" data-title-success>Authentication complete</h1>
        <h1 class="title" data-title-error>Authentication failed</h1>

        <p class="subtitle" data-sub-loading>Checking the browser handoff with the desktop app.</p>
        <p class="subtitle" data-sub-success>You can close this tab and continue in Kordi.</p>
        <p class="subtitle" data-sub-error>Return to Kordi and start sign-in again.</p>
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

// Self-contained palette. All tokens are mirrored from the in-app
// `--app-cloud-login-*` variables so the loopback page reads as the same
// product, but we inline the values because the loopback HTTP server
// has no access to the bundled stylesheet. Hue 82 (warm saffron) tints
// every neutral toward the Kordi brand; status accents stay
// monochromatic per state. See `.impeccable.md` Design Context.
fn completion_page_css() -> &'static str {
    r#"
    :root {
      color-scheme: light dark;
      --page-bg: oklch(0.965 0.018 82);
      --page-veil: oklch(0.995 0.006 82 / 0.72);
      --grain: oklch(0.42 0.02 82 / 0.045);
      --grain-blend: multiply;
      --surface: oklch(0.992 0.008 82);
      --surface-lift: oklch(1 0 0 / 0.78);
      --border: oklch(0.62 0.035 82 / 0.24);
      --shadow-ambient: oklch(0.36 0.035 82 / 0.12);
      --shadow-contact: oklch(0.30 0.028 82 / 0.10);
      --ink-strong: oklch(0.18 0.018 82);
      --ink: oklch(0.32 0.016 82);
      --ink-soft: oklch(0.50 0.018 82);
      --ink-faint: oklch(0.58 0.016 82);
      --rule: oklch(0.70 0.025 82 / 0.26);

      --state-bg: oklch(0.94 0.026 82);
      --state-border: oklch(0.58 0.040 82 / 0.20);
      --state-ink: oklch(0.30 0.018 82);
      --success-bg: oklch(0.91 0.055 154);
      --success-border: oklch(0.62 0.12 154 / 0.30);
      --success-ink: oklch(0.34 0.12 154);
      --error-bg: oklch(0.93 0.048 28);
      --error-border: oklch(0.62 0.14 28 / 0.32);
      --error-ink: oklch(0.42 0.14 28);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: oklch(0.155 0.014 250);
        --page-veil: oklch(0.18 0.014 250 / 0.70);
        --grain: oklch(1 0 0 / 0.04);
        --grain-blend: screen;
        --surface: oklch(0.205 0.014 250);
        --surface-lift: oklch(1 0 0 / 0.055);
        --border: oklch(0.44 0.022 250 / 0.34);
        --shadow-ambient: oklch(0 0 0 / 0.42);
        --shadow-contact: oklch(0 0 0 / 0.28);
        --ink-strong: oklch(0.96 0.010 82);
        --ink: oklch(0.78 0.012 250);
        --ink-soft: oklch(0.64 0.014 250);
        --ink-faint: oklch(0.53 0.014 250);
        --rule: oklch(0.48 0.018 250 / 0.34);

        --state-bg: oklch(0.25 0.014 250);
        --state-border: oklch(0.48 0.018 250 / 0.36);
        --state-ink: oklch(0.78 0.014 250);
        --success-bg: oklch(0.30 0.070 154 / 0.58);
        --success-border: oklch(0.62 0.13 154 / 0.42);
        --success-ink: oklch(0.88 0.12 154);
        --error-bg: oklch(0.30 0.10 28 / 0.58);
        --error-border: oklch(0.62 0.16 28 / 0.42);
        --error-ink: oklch(0.88 0.12 28);
      }
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: "Avenir Next", "SF Pro Text", "Segoe UI", sans-serif;
      font-feature-settings: "kern", "ss01", "cv11";
      color: var(--ink);
      background:
        radial-gradient(circle at 50% 46%, var(--page-veil), transparent 34rem),
        linear-gradient(135deg, oklch(0.985 0.012 82) 0%, var(--page-bg) 54%, oklch(0.935 0.020 82) 100%);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background:
          radial-gradient(circle at 50% 42%, oklch(0.34 0.055 250 / 0.22), transparent 32rem),
          linear-gradient(135deg, oklch(0.18 0.014 250) 0%, var(--page-bg) 60%, oklch(0.105 0.012 250) 100%);
      }
    }

    .page {
      position: relative;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
      overflow: hidden;
    }
    .page-grain {
      position: absolute;
      inset: -20%;
      pointer-events: none;
      background-image:
        repeating-linear-gradient(8deg, var(--grain) 0 1px, transparent 1px 10px),
        radial-gradient(circle at 50% 45%, transparent 0 18rem, oklch(0.34 0.03 82 / 0.035) 42rem);
      mix-blend-mode: var(--grain-blend);
      opacity: 0.72;
      transform: rotate(-1deg);
    }

    .card {
      position: relative;
      width: min(430px, calc(100vw - 48px));
      padding: 28px 30px 30px;
      overflow: hidden;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow:
        inset 0 1px 0 var(--surface-lift),
        0 28px 70px -38px var(--shadow-ambient),
        0 10px 28px -22px var(--shadow-contact);
      display: grid;
      gap: 18px;
      animation: card-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .card::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: inherit;
      background: linear-gradient(180deg, oklch(1 0 0 / 0.24), transparent 44%);
    }
    .wordmark,
    .status-line,
    .copy { position: relative; z-index: 1; }
    @keyframes card-enter {
      from { opacity: 0; transform: translate3d(0, 5px, 0) scale(0.994); }
      to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }

    .wordmark {
      font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
      font-size: 18px;
      font-weight: 760;
      letter-spacing: -0.035em;
      color: var(--ink-strong);
      line-height: 1;
    }

    .status-line {
      display: none;
      align-items: center;
      gap: 8px;
      color: var(--state-ink);
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.01em;
      animation: text-fade 280ms cubic-bezier(0.22, 1, 0.36, 1) both 70ms;
    }
    .status-icon {
      display: inline-flex;
      width: 18px;
      height: 18px;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--state-bg);
      color: currentColor;
    }
    .status-success { color: var(--success-ink); }
    .status-success .status-icon { background: var(--success-bg); }
    .status-error { color: var(--error-ink); }
    .status-error .status-icon { background: var(--error-bg); }

    [data-status="loading"] [data-status-loading],
    [data-status="success"] [data-status-success],
    [data-status="error"]   [data-status-error] { display: inline-flex; }
    [data-status="loading"] .status-icon svg { animation: spin 1.1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .copy {
      display: grid;
      gap: 10px;
      padding-top: 2px;
    }
    .title {
      display: none;
      margin: 0;
      font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
      font-size: clamp(30px, 5vw, 38px);
      line-height: 1.04;
      font-weight: 760;
      letter-spacing: -0.042em;
      color: var(--ink-strong);
      animation: text-fade 300ms cubic-bezier(0.22, 1, 0.36, 1) both 110ms;
    }
    .subtitle {
      display: none;
      margin: 0;
      max-width: 28ch;
      font-size: 15px;
      line-height: 1.55;
      color: var(--ink-soft);
      animation: text-fade 300ms cubic-bezier(0.22, 1, 0.36, 1) both 160ms;
    }
    [data-status="loading"] [data-title-loading],
    [data-status="loading"] [data-sub-loading],
    [data-status="success"] [data-title-success],
    [data-status="success"] [data-sub-success],
    [data-status="error"]   [data-title-error],
    [data-status="error"]   [data-sub-error] { display: block; }

    @keyframes text-fade {
      from { opacity: 0; transform: translate3d(0, 2px, 0); }
      to   { opacity: 1; transform: translate3d(0, 0, 0); }
    }

    @media (max-width: 420px) {
      .page { padding: 18px; }
      .card { width: 100%; padding: 24px; border-radius: 22px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card, .status-line, .title, .subtitle { animation: none; }
      [data-status="loading"] .status-icon svg { animation: none; }
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
            html.contains(">Kordi</div>"),
            "wordmark should render Kordi"
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

        assert!(html.contains("Finishing authentication"));
        assert!(html.contains("Authentication complete"));
        assert!(html.contains("Authentication failed"));
        assert!(html.contains("You can close this tab and continue in Kordi."));
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

        // OKLCH tokens tinted toward Kordi's warm saffron hue (82) — matches
        // the in-app `--app-cloud-login-*` palette without depending on the
        // bundled stylesheet (loopback HTTP server can't reach it).
        assert!(
            html.contains("oklch(0.965 0.018 82)"),
            "light page bg should be the refined brand cream"
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
