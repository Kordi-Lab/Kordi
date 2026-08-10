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
    let Ok(request) = read_http_request(&mut stream).await else {
        return false;
    };
    let first = request.first_line.as_str();

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
        let body = request.body.trim().to_string();
        let outcome = if body.starts_with("#kordi_cloud_oauth=") {
            "session"
        } else if body.starts_with("#kordi_cloud_oauth_error=") {
            "error"
        } else if body.is_empty() {
            "empty"
        } else {
            "unknown"
        };
        if let Some(detail) = body.strip_prefix("#kordi_cloud_oauth_error=") {
            eprintln!(
                "[kordi] OAuth loopback completion received (outcome={outcome}, bytes={}, detail={detail}).",
                body.len()
            );
        } else {
            eprintln!(
                "[kordi] OAuth loopback completion received (outcome={outcome}, bytes={}).",
                body.len()
            );
        }
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

const MAX_LOOPBACK_REQUEST_BYTES: usize = 128 * 1024;

struct LoopbackHttpRequest {
    first_line: String,
    body: String,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<LoopbackHttpRequest, String> {
    let mut request = Vec::with_capacity(4 * 1024);
    let header_end = loop {
        read_more_request_bytes(stream, &mut request).await?;
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break header_end;
        }
    };
    let body_start = header_end + 4;
    let headers = std::str::from_utf8(&request[..header_end])
        .map_err(|_| "Local OAuth callback headers were invalid.".to_string())?;
    let first_line = headers.lines().next().unwrap_or_default().to_string();
    let content_length_header = http_header_value(headers, "content-length");
    let chunked = http_header_value(headers, "transfer-encoding").is_some_and(|value| {
        value
            .split(',')
            .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
    });
    if content_length_header.is_some() && chunked {
        return Err("Local OAuth callback used ambiguous HTTP framing.".to_string());
    }

    let body = if chunked {
        loop {
            match decode_chunked_body(&request[body_start..])? {
                Some(body) => break body,
                None => read_more_request_bytes(stream, &mut request).await?,
            }
        }
    } else {
        let content_length = content_length_header
            .map(|value| {
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "Local OAuth callback Content-Length was invalid.".to_string())
            })
            .transpose()?
            .unwrap_or(0);
        let total_len = body_start
            .checked_add(content_length)
            .ok_or_else(|| "Local OAuth callback request was too large.".to_string())?;
        if total_len > MAX_LOOPBACK_REQUEST_BYTES {
            return Err("Local OAuth callback request was too large.".to_string());
        }
        while request.len() < total_len {
            read_more_request_bytes(stream, &mut request).await?;
        }
        request[body_start..total_len].to_vec()
    };

    let body = String::from_utf8(body)
        .map_err(|_| "Local OAuth callback body was invalid.".to_string())?;
    Ok(LoopbackHttpRequest { first_line, body })
}

async fn read_more_request_bytes(
    stream: &mut TcpStream,
    request: &mut Vec<u8>,
) -> Result<(), String> {
    let mut chunk = [0_u8; 4 * 1024];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
        .await
        .map_err(|_| "Local OAuth callback request timed out.".to_string())?
        .map_err(|err| format!("Unable to read local OAuth callback: {err}"))?;
    if read == 0 {
        return Err("Local OAuth callback closed before the request was complete.".to_string());
    }
    request.extend_from_slice(&chunk[..read]);
    if request.len() > MAX_LOOPBACK_REQUEST_BYTES {
        return Err("Local OAuth callback request was too large.".to_string());
    }
    Ok(())
}

fn http_header_value<'a>(headers: &'a str, expected_name: &str) -> Option<&'a str> {
    headers.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case(expected_name)
            .then_some(value.trim())
    })
}

fn decode_chunked_body(encoded: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();

    loop {
        let Some(line_end) = encoded[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
        else {
            return Ok(None);
        };
        let size_line = std::str::from_utf8(&encoded[cursor..line_end])
            .map_err(|_| "Local OAuth callback chunk size was invalid.".to_string())?;
        let size =
            usize::from_str_radix(size_line.split(';').next().unwrap_or_default().trim(), 16)
                .map_err(|_| "Local OAuth callback chunk size was invalid.".to_string())?;
        let data_start = line_end + 2;
        if size == 0 {
            if encoded.len() < data_start + 2 {
                return Ok(None);
            }
            if &encoded[data_start..data_start + 2] == b"\r\n" {
                return Ok(Some(decoded));
            }
            return if encoded[data_start..]
                .windows(4)
                .any(|window| window == b"\r\n\r\n")
            {
                Ok(Some(decoded))
            } else {
                Ok(None)
            };
        }
        let data_end = data_start
            .checked_add(size)
            .ok_or_else(|| "Local OAuth callback request was too large.".to_string())?;
        let chunk_end = data_end
            .checked_add(2)
            .ok_or_else(|| "Local OAuth callback request was too large.".to_string())?;
        if encoded.len() < chunk_end {
            return Ok(None);
        }
        if &encoded[data_end..chunk_end] != b"\r\n" {
            return Err("Local OAuth callback chunk was invalid.".to_string());
        }
        decoded.extend_from_slice(&encoded[data_start..data_end]);
        if decoded.len() > MAX_LOOPBACK_REQUEST_BYTES {
            return Err("Local OAuth callback request was too large.".to_string());
        }
        cursor = chunk_end;
    }
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
#[path = "cloud_oauth_loopback/tests.rs"]
mod tests;
