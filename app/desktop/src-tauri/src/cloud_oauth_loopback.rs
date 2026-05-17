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

      <div class="pill" data-pill-loading>
        <span class="pill-icon">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="8" cy="8" r="6" opacity="0.18" />
            <path d="M8 2 a6 6 0 0 1 6 6" />
          </svg>
        </span>
        <span class="pill-label">Signing in</span>
      </div>

      <div class="pill pill-success" data-pill-success>
        <span class="pill-icon">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 8.4 6.6 11.4 12.6 5.2" />
          </svg>
        </span>
        <span class="pill-label">Signed in</span>
      </div>

      <div class="pill pill-error" data-pill-error>
        <span class="pill-icon">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M5 5 11 11 M11 5 5 11" />
          </svg>
        </span>
        <span class="pill-label">Sign-in failed</span>
      </div>

      <h1 class="title" data-title-loading>Signing you in to Kordi</h1>
      <h1 class="title" data-title-success>Kordi sign-in complete</h1>
      <h1 class="title" data-title-error>Couldn't finish sign-in</h1>

      <p class="subtitle" data-sub-loading>Hold on — handing you back to the desktop app.</p>
      <p class="subtitle" data-sub-success>Return to the Kordi desktop app to continue.</p>
      <p class="subtitle" data-sub-error>Head back to Kordi and try again.</p>

      <p class="hint">You can close this browser tab.</p>
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
      --bg: oklch(0.955 0.026 82);
      --grain: oklch(0.35 0.03 82 / 0.05);
      --grain-blend: multiply;
      --grain-opacity: 0.18;
      --card-bg: oklch(0.985 0.012 82);
      --card-border: oklch(0.62 0.05 82 / 0.22);
      --card-inset: oklch(1 0 0 / 0.42);
      --card-shadow: 0 24px 60px -28px oklch(0.30 0.04 82 / 0.30),
                     0 4px 14px -10px oklch(0.30 0.04 82 / 0.18);
      --ink-strong: oklch(0.19 0.018 82);
      --ink: oklch(0.32 0.018 82);
      --ink-soft: oklch(0.46 0.022 82);
      --ink-faint: oklch(0.55 0.022 82);
      --wordmark-ink: oklch(0.22 0.022 82);

      --pill-bg: oklch(0.94 0.024 82);
      --pill-border: oklch(0.62 0.05 82 / 0.18);
      --pill-ink: oklch(0.32 0.018 82);

      --pill-success-bg: oklch(0.94 0.06 154);
      --pill-success-border: oklch(0.66 0.13 154 / 0.32);
      --pill-success-ink: oklch(0.38 0.13 154);

      --pill-error-bg: oklch(0.95 0.05 28);
      --pill-error-border: oklch(0.66 0.17 28 / 0.30);
      --pill-error-ink: oklch(0.44 0.17 28);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-dark: #0d0f13;
        --grain: rgba(255, 255, 255, 0.045);
        --grain-blend: screen;
        --grain-opacity: 0.28;
        --card-bg: oklch(0.20 0.012 246);
        --card-border: oklch(0.40 0.018 246 / 0.32);
        --card-inset: oklch(1 0 0 / 0.06);
        --card-shadow: 0 30px 80px -34px oklch(0 0 0 / 0.55),
                       0 6px 20px -12px oklch(0 0 0 / 0.40);
        --ink-strong: oklch(0.96 0.012 82);
        --ink: oklch(0.78 0.012 246);
        --ink-soft: oklch(0.62 0.014 246);
        --ink-faint: oklch(0.50 0.014 246);
        --wordmark-ink: oklch(0.97 0.014 82);

        --pill-bg: oklch(0.24 0.014 246);
        --pill-border: oklch(0.42 0.018 246 / 0.36);
        --pill-ink: oklch(0.78 0.014 246);

        --pill-success-bg: oklch(0.30 0.07 154 / 0.55);
        --pill-success-border: oklch(0.62 0.13 154 / 0.42);
        --pill-success-ink: oklch(0.88 0.12 154);

        --pill-error-bg: oklch(0.30 0.10 28 / 0.55);
        --pill-error-border: oklch(0.62 0.16 28 / 0.42);
        --pill-error-ink: oklch(0.88 0.12 28);
      }
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-feature-settings: "ss01", "cv11";
      color: var(--ink);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background:
          radial-gradient(circle at 14% 12%, oklch(0.55 0.10 246 / 0.10), transparent 36%),
          radial-gradient(circle at 86% 18%, oklch(0.58 0.14 355 / 0.06), transparent 30%),
          linear-gradient(180deg, #0f1115 0%, #0d0f13 52%, #090b0f 100%);
      }
    }

    .page {
      position: relative;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
    }
    .page-grain {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: repeating-linear-gradient(
        7deg,
        var(--grain) 0 1px,
        transparent 1px 9px
      );
      mix-blend-mode: var(--grain-blend);
      opacity: var(--grain-opacity);
    }

    .card {
      position: relative;
      width: min(380px, 100%);
      padding: 28px 28px 24px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 22px;
      box-shadow:
        inset 0 1px 0 var(--card-inset),
        var(--card-shadow);
      display: grid;
      gap: 14px;
      justify-items: start;
      text-align: left;
      animation: card-enter 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes card-enter {
      from { opacity: 0; transform: translate3d(0, 6px, 0); }
      to   { opacity: 1; transform: translate3d(0, 0, 0); }
    }

    .wordmark {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: var(--wordmark-ink);
      line-height: 1;
      padding-bottom: 4px;
    }

    .pill {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      border: 1px solid var(--pill-border);
      background: var(--pill-bg);
      color: var(--pill-ink);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      animation: pill-enter 360ms cubic-bezier(0.22, 1, 0.36, 1) both 80ms;
    }
    .pill-icon {
      display: inline-flex;
      width: 14px;
      height: 14px;
      align-items: center;
      justify-content: center;
    }
    .pill-success { background: var(--pill-success-bg); border-color: var(--pill-success-border); color: var(--pill-success-ink); }
    .pill-error   { background: var(--pill-error-bg);   border-color: var(--pill-error-border);   color: var(--pill-error-ink); }

    [data-status="loading"] [data-pill-loading],
    [data-status="success"] [data-pill-success],
    [data-status="error"]   [data-pill-error] { display: inline-flex; }

    [data-status="loading"] .pill-icon svg { animation: spin 1.1s linear infinite; }

    @keyframes pill-enter {
      from { opacity: 0; transform: scale(0.94); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .title {
      display: none;
      margin: 2px 0 0;
      font-size: 22px;
      line-height: 1.18;
      font-weight: 600;
      letter-spacing: -0.018em;
      color: var(--ink-strong);
      animation: text-fade 360ms cubic-bezier(0.22, 1, 0.36, 1) both 140ms;
    }
    .subtitle {
      display: none;
      margin: -4px 0 0;
      font-size: 14px;
      line-height: 1.55;
      color: var(--ink-soft);
      max-width: 32ch;
      animation: text-fade 360ms cubic-bezier(0.22, 1, 0.36, 1) both 200ms;
    }
    [data-status="loading"] [data-title-loading],
    [data-status="loading"] [data-sub-loading],
    [data-status="success"] [data-title-success],
    [data-status="success"] [data-sub-success],
    [data-status="error"]   [data-title-error],
    [data-status="error"]   [data-sub-error] { display: block; }

    .hint {
      margin: 8px 0 0;
      font-size: 12px;
      line-height: 1.45;
      color: var(--ink-faint);
      letter-spacing: 0.005em;
      animation: text-fade 360ms cubic-bezier(0.22, 1, 0.36, 1) both 260ms;
    }
    @keyframes text-fade {
      from { opacity: 0; transform: translate3d(0, 2px, 0); }
      to   { opacity: 1; transform: translate3d(0, 0, 0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .card, .pill, .title, .subtitle, .hint { animation: none; }
      [data-status="loading"] .pill-icon svg { animation: none; }
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
        assert!(html.contains("data-status=\"loading\""), "page should boot in loading state");
        assert!(html.contains(">Kordi</div>"), "wordmark should render Kordi");

        // All three state blocks must be present so the swap between them is
        // just an attribute flip, never a layout shift.
        for pill in ["data-pill-loading", "data-pill-success", "data-pill-error"] {
            assert!(html.contains(pill), "missing pill state: {pill}");
        }
        for title in ["data-title-loading", "data-title-success", "data-title-error"] {
            assert!(html.contains(title), "missing title state: {title}");
        }
        for sub in ["data-sub-loading", "data-sub-success", "data-sub-error"] {
            assert!(html.contains(sub), "missing subtitle state: {sub}");
        }
    }

    #[test]
    fn copy_matches_brand_voice_for_each_state() {
        let html = completion_page_html("cloud_oauth_abc123");

        assert!(html.contains("Signing you in to Kordi"));
        assert!(html.contains("Kordi sign-in complete"));
        assert!(html.contains("Couldn't finish sign-in"));
        assert!(html.contains("Return to the Kordi desktop app"));
        assert!(html.contains("You can close this browser tab"));
    }

    #[test]
    fn script_posts_to_complete_endpoint_with_request_id() {
        let html = completion_page_html("cloud_oauth_xyz789");
        assert!(html.contains("/complete/cloud_oauth_xyz789"),
            "completion POST should target the request-specific endpoint");
        assert!(html.contains("method: 'POST'"),
            "completion ping must be a POST so the loopback server flips status");
    }

    #[test]
    fn page_carries_brand_palette_and_dark_mode_support() {
        let html = completion_page_html("cloud_oauth_palette");

        // OKLCH tokens tinted toward Kordi's warm saffron hue (82) — matches
        // the in-app `--app-cloud-login-*` palette without depending on the
        // bundled stylesheet (loopback HTTP server can't reach it).
        assert!(html.contains("oklch(0.955 0.026 82)"), "light page bg should be the brand cream");
        assert!(html.contains("prefers-color-scheme: dark"), "dark mode must be supported");
        assert!(html.contains("prefers-reduced-motion: reduce"), "reduced motion must collapse animations");
    }

    #[test]
    fn page_has_no_external_network_or_banned_design_patterns() {
        let html = completion_page_html("cloud_oauth_selfcontained");

        // The loopback server can't proxy external assets and we don't want
        // the callback page to phone home, so the page must be self-contained.
        for forbidden in ["fonts.googleapis", "fonts.gstatic", "cdn.", "https://"] {
            assert!(!html.contains(forbidden),
                "callback page must not reference external URL: {forbidden}");
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
