//! Loopback redirect for browser sign-in (authorization code with PKCE,
//! RFC 8252). The browser returns to `http://127.0.0.1:<port>/auth/callback`
//! with `code` and `state` (or `error` and `state`) in the query. The
//! listener hands that query to the app only when `state` matches the
//! value the app generated, serves a short page in the browser, and brings
//! the Kordi window back to the front.
//!
//! The pending and cancellation maps are shared with the older OAuth
//! loopback, so `cloud_oauth_loopback_wait` and `cloud_oauth_loopback_cancel`
//! serve both flows.

use std::time::Duration;

use tauri::State;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::cloud_oauth_loopback::{
    read_loopback_request, write_response, CloudOAuthLoopbackStart, CloudOAuthLoopbackState,
};

pub(crate) const CALLBACK_PATH: &str = "/auth/callback";
const MAX_STATE_CHARS: usize = 512;
/// Authorization codes live for 60 seconds, but the user may take longer to
/// sign in or create an account on the page first.
const LISTENER_LIFETIME: Duration = Duration::from_secs(15 * 60);

#[tauri::command]
pub async fn cloud_app_sign_in_loopback_prepare(
    app: tauri::AppHandle,
    state: State<'_, CloudOAuthLoopbackState>,
    expected_state: String,
) -> Result<CloudOAuthLoopbackStart, String> {
    let expected_state = expected_state.trim().to_string();
    if expected_state.is_empty() || expected_state.len() > MAX_STATE_CHARS {
        return Err("Browser sign-in needs a valid state value.".to_string());
    }
    let request_id = format!("cloud_app_sign_in_{}", uuid::Uuid::new_v4().simple());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("Unable to start the sign-in callback listener: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Unable to read the sign-in callback address: {err}"))?
        .port();
    let (tx, rx) = oneshot::channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "Sign-in callback state is unavailable.".to_string())?
        .insert(request_id.clone(), rx);
    state
        .cancellations
        .lock()
        .map_err(|_| "Sign-in callback state is unavailable.".to_string())?
        .insert(request_id.clone(), cancel_tx);
    // The browser now has focus; land the user back in Kordi once it returns.
    let bring_back = move || crate::window_lifecycle::bring_main_window_to_front(&app);
    tokio::spawn(run_listener(
        listener,
        expected_state,
        tx,
        cancel_rx,
        bring_back,
    ));
    Ok(CloudOAuthLoopbackStart {
        request_id,
        redirect_url: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
    })
}

async fn run_listener(
    listener: TcpListener,
    expected_state: String,
    tx: oneshot::Sender<Result<String, String>>,
    cancel_rx: oneshot::Receiver<()>,
    on_completed: impl FnOnce(),
) {
    let mut sender = Some(tx);
    let deadline = tokio::time::sleep(LISTENER_LIFETIME);
    tokio::pin!(deadline);
    tokio::pin!(cancel_rx);
    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                if let Some(tx) = sender.take() {
                    let _ = tx.send(Err("Browser sign-in was canceled.".to_string()));
                }
                return;
            }
            _ = &mut deadline => {
                if let Some(tx) = sender.take() {
                    let _ = tx.send(Err("Browser sign-in timed out. Try again.".to_string()));
                }
                return;
            }
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue; };
                if let Some(query) = handle_connection(stream, &expected_state).await {
                    if let Some(tx) = sender.take() {
                        let _ = tx.send(Ok(query));
                    }
                    on_completed();
                    return;
                }
            }
        }
    }
}

/// Serves one request. Returns the callback query once a request carries
/// the expected `state` together with a `code` or an `error`.
async fn handle_connection(mut stream: TcpStream, expected_state: &str) -> Option<String> {
    let request = tokio::time::timeout(Duration::from_secs(10), read_loopback_request(&mut stream))
        .await
        .ok()
        .flatten()?;
    let outcome = classify_request(&request, expected_state);
    const HTML: &str = "text/html; charset=utf-8";
    let (status, content_type, body) = match &outcome {
        CallbackOutcome::Completed { is_error, .. } => ("200 OK", HTML, completion_page(!is_error)),
        CallbackOutcome::Rejected => ("400 Bad Request", HTML, completion_page(false)),
        CallbackOutcome::NotFound => (
            "404 Not Found",
            "text/plain; charset=utf-8",
            "Not found".to_string(),
        ),
    };
    let _ = write_response(&mut stream, status, content_type, body.as_bytes()).await;
    match outcome {
        CallbackOutcome::Completed { query, .. } => Some(query),
        _ => None,
    }
}

/// The browser tab after the redirect: one line and a hint in system colors,
/// with no external assets. A signed-in tab tries to close itself, which
/// browsers allow only for tabs a script opened.
pub(crate) fn completion_page(signed_in: bool) -> String {
    let (status, title, hint, script) = if signed_in {
        (
            "success",
            "Signed in to Kordi",
            "You can close this tab.",
            "<script>setTimeout(function () { window.close(); }, 800);</script>",
        )
    } else {
        (
            "error",
            "Could not sign in to Kordi",
            "Return to Kordi and try again.",
            "",
        )
    };
    format!(
        r#"<!doctype html>
<html lang="en" data-status="{status}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>
:root {{ --bg: #f7f7f8; --ink: #17181c; --muted: #6b6f78; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #151619; --ink: #f2f3f5; --muted: #9a9ea8; }} }}
html, body {{ height: 100%; margin: 0; }}
body {{ display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }}
main {{ padding: 24px; text-align: center; }}
h1 {{ margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }}
p {{ margin: 6px 0 0; color: var(--muted); font-size: 13px; }}
</style>
</head>
<body>
<main role="status"><h1>{title}</h1><p>{hint}</p></main>
{script}
</body>
</html>"#
    )
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CallbackOutcome {
    Completed {
        query: String,
        is_error: bool,
    },
    /// The callback path with a missing or foreign state, or no result.
    Rejected,
    NotFound,
}

pub(crate) fn classify_request(request: &str, expected_state: &str) -> CallbackOutcome {
    let first = request.lines().next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return CallbackOutcome::NotFound;
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return CallbackOutcome::NotFound;
    }
    let mut state = None;
    let mut has_code = false;
    let mut has_error = false;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let Some(value) = decode_component(value) else {
            return CallbackOutcome::Rejected;
        };
        match key {
            "state" if state.is_none() => state = Some(value),
            "state" => return CallbackOutcome::Rejected,
            "code" => has_code = !value.is_empty(),
            "error" => has_error = !value.is_empty(),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) || has_code == has_error {
        return CallbackOutcome::Rejected;
    }
    CallbackOutcome::Completed {
        query: query.to_string(),
        is_error: has_error,
    }
}

/// Decodes one `application/x-www-form-urlencoded` value.
fn decode_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' => {
                let hex = value.get(index + 1..index + 3)?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                index += 2;
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    }

    #[test]
    fn accepts_a_code_with_the_expected_state() {
        assert_eq!(
            classify_request(&get("/auth/callback?code=kac_1&state=s1"), "s1"),
            CallbackOutcome::Completed {
                query: "code=kac_1&state=s1".to_string(),
                is_error: false
            }
        );
    }

    #[test]
    fn accepts_an_error_with_the_expected_state() {
        assert_eq!(
            classify_request(&get("/auth/callback?error=access_denied&state=s1"), "s1"),
            CallbackOutcome::Completed {
                query: "error=access_denied&state=s1".to_string(),
                is_error: true
            }
        );
    }

    #[test]
    fn rejects_foreign_missing_or_repeated_state() {
        for target in [
            "/auth/callback?code=kac_1&state=other",
            "/auth/callback?code=kac_1",
            "/auth/callback?code=kac_1&state=s1&state=s1",
            "/auth/callback?state=s1",
            "/auth/callback?code=kac_1&error=access_denied&state=s1",
        ] {
            assert_eq!(
                classify_request(&get(target), "s1"),
                CallbackOutcome::Rejected,
                "{target}"
            );
        }
    }

    #[test]
    fn decodes_percent_encoded_state() {
        assert!(matches!(
            classify_request(&get("/auth/callback?code=c&state=a%2Bb+c"), "a+b c"),
            CallbackOutcome::Completed { .. }
        ));
        assert_eq!(
            classify_request(&get("/auth/callback?code=c&state=%zz"), "s1"),
            CallbackOutcome::Rejected
        );
    }

    #[test]
    fn ignores_other_paths_and_methods() {
        assert_eq!(
            classify_request(&get("/favicon.ico"), "s1"),
            CallbackOutcome::NotFound
        );
        assert_eq!(
            classify_request(&get("/auth/callback/extra?code=c&state=s1"), "s1"),
            CallbackOutcome::NotFound
        );
        assert_eq!(
            classify_request("POST /auth/callback?code=c&state=s1 HTTP/1.1\r\n\r\n", "s1"),
            CallbackOutcome::NotFound
        );
    }

    #[test]
    fn completion_pages_are_minimal_and_self_contained() {
        let signed_in = completion_page(true);
        assert!(signed_in.contains("data-status=\"success\""));
        assert!(signed_in.contains("<h1>Signed in to Kordi</h1><p>You can close this tab.</p>"));
        assert!(signed_in.contains("window.close()"));
        assert!(signed_in.contains("prefers-color-scheme: dark"));

        let failed = completion_page(false);
        assert!(failed.contains("data-status=\"error\""));
        assert!(failed
            .contains("<h1>Could not sign in to Kordi</h1><p>Return to Kordi and try again.</p>"));
        assert!(!failed.contains("<script"), "an error page stays open");

        for page in [signed_in, failed] {
            for external in ["http:", "https:", "src=", "href=", "@import", "url("] {
                assert!(!page.contains(external), "{external}");
            }
        }
    }

    async fn request(port: u16, target: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(get(target).as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn a_valid_callback_completes_and_brings_kordi_back() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let brought_back = Arc::new(AtomicUsize::new(0));
        let counter = brought_back.clone();
        let task = tokio::spawn(run_listener(
            listener,
            "s1".to_string(),
            tx,
            cancel_rx,
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
            },
        ));

        let foreign = request(port, "/auth/callback?code=kac_1&state=other").await;
        assert!(foreign.starts_with("HTTP/1.1 400"));
        assert!(foreign.contains("Could not sign in to Kordi"));
        assert!(request(port, "/favicon.ico")
            .await
            .starts_with("HTTP/1.1 404"));
        assert_eq!(brought_back.load(Ordering::SeqCst), 0);

        let signed_in = request(port, "/auth/callback?code=kac_1&state=s1").await;
        assert!(signed_in.starts_with("HTTP/1.1 200"));
        assert!(signed_in.contains("Signed in to Kordi"));
        task.await.unwrap();
        assert_eq!(rx.await.unwrap(), Ok("code=kac_1&state=s1".to_string()));
        assert_eq!(brought_back.load(Ordering::SeqCst), 1);
    }
}
