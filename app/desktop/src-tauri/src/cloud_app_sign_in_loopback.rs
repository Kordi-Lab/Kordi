//! Loopback redirect for browser sign-in (authorization code with PKCE,
//! RFC 8252). The browser returns to `http://127.0.0.1:<port>/auth/callback`
//! with `code` and `state` (or `error` and `state`) in the query. The
//! listener hands that query to the app only when `state` matches the
//! value the app generated, then serves a page that sends the user back.
//!
//! The pending and cancellation maps are shared with the older OAuth
//! loopback, so `cloud_oauth_loopback_wait` and `cloud_oauth_loopback_cancel`
//! serve both flows.

use std::time::Duration;

use tauri::State;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::cloud_oauth_loopback::{
    read_loopback_request, static_completion_page_html, write_response, CloudOAuthLoopbackStart,
    CloudOAuthLoopbackState,
};

pub(crate) const CALLBACK_PATH: &str = "/auth/callback";
const MAX_STATE_CHARS: usize = 512;
/// Authorization codes live for 60 seconds, but the user may take longer to
/// sign in or create an account on the page first.
const LISTENER_LIFETIME: Duration = Duration::from_secs(15 * 60);

#[tauri::command]
pub async fn cloud_app_sign_in_loopback_prepare(
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
    tokio::spawn(run_listener(listener, expected_state, tx, cancel_rx));
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
        CallbackOutcome::Completed { is_error, .. } => (
            "200 OK",
            HTML,
            static_completion_page_html(if *is_error { "error" } else { "success" }),
        ),
        CallbackOutcome::Rejected => (
            "400 Bad Request",
            HTML,
            static_completion_page_html("error"),
        ),
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
    fn completion_pages_need_no_script() {
        let page = static_completion_page_html("success");
        assert!(page.contains("data-status=\"success\""));
        assert!(page.contains("<script></script>"));
    }
}
