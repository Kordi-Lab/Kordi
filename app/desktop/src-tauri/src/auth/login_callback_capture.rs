//! Loopback capture for hosted OMP browser sign-ins.
//!
//! Some providers (ChatGPT, for example) send the browser to a fixed
//! `http://localhost:<port>/...` address after approval. The hosted OMP login
//! runs on the server and cannot receive that redirect, so the desktop app
//! listens on the port and hands the redirect's full address back to the page,
//! which submits it as the pasted redirect URL. The address carries a one-time
//! authorization code, so nothing here logs it.
//!
//! Only the provider's redirect ends a capture: a GET for the catalog's
//! callback path with a `code` or `error` parameter and a loopback `Host`.
//! Anything else is answered 404 (405 for other methods) and the capture keeps
//! listening, so a stray local request cannot use up the sign-in.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an answered browser gets to close its end before the connection is reset.
const PEER_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const LISTEN_BACKLOG: u32 = 16;
const REBIND_ATTEMPTS: u32 = 20;
const REBIND_DELAY: Duration = Duration::from_millis(50);
/// OMP's loopback redirect path when the catalog does not name one.
const DEFAULT_CALLBACK_PATH: &str = "/auth/callback";
const MAX_CALLBACK_PATH_BYTES: usize = 256;
const SIGNED_IN_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Kordi</title></head><body style=\"font-family:-apple-system,system-ui,sans-serif;margin:64px;text-align:center\"><p>Signed in. You can return to Kordi.</p></body></html>";
const NOT_ALLOWED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Kordi</title></head><body><p>Kordi only accepts the sign-in redirect here.</p></body></html>";
const NOT_FOUND_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Kordi</title></head><body><p>Kordi is waiting for the sign-in redirect at another address.</p></body></html>";

/// Why a capture ended without a redirect. The command returns the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureError {
    /// Another program holds the port, for example a Codex CLI login on this Mac.
    PortUnavailable,
    InvalidPort,
    InvalidCallbackPath,
    Cancelled,
    TimedOut,
}

impl CaptureError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::PortUnavailable => "port_unavailable",
            Self::InvalidPort => "invalid_port",
            Self::InvalidCallbackPath => "invalid_callback_path",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
        }
    }
}

/// The redirect a capture waits for: the loopback port and the callback path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallbackRoute {
    port: u16,
    path: String,
}

impl CallbackRoute {
    /// The route for `port` and the catalog's path, or OMP's default path when
    /// none is given. A path must be an origin-form path without a query.
    pub(crate) fn new(port: u16, path: Option<&str>) -> Result<Self, CaptureError> {
        if port == 0 {
            return Err(CaptureError::InvalidPort);
        }
        let path = path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or(DEFAULT_CALLBACK_PATH);
        let valid = path.starts_with('/')
            && path.len() <= MAX_CALLBACK_PATH_BYTES
            && path
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b'?' && byte != b'#');
        if !valid {
            return Err(CaptureError::InvalidCallbackPath);
        }
        Ok(Self {
            port,
            path: path.to_string(),
        })
    }
}

struct ActiveCapture {
    id: u64,
    cancel: oneshot::Sender<()>,
}

static ACTIVE_CAPTURE: Mutex<Option<ActiveCapture>> = Mutex::new(None);
static NEXT_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);

fn swap_active(next: Option<ActiveCapture>) -> Option<ActiveCapture> {
    let mut active = ACTIVE_CAPTURE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *active, next)
}

fn clear_active(id: u64) {
    let mut active = ACTIVE_CAPTURE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.as_ref().is_some_and(|capture| capture.id == id) {
        *active = None;
    }
}

/// Listens on `127.0.0.1:<port>` until the provider's redirect arrives at
/// `callback_path` (default `/auth/callback`) and returns its full address as
/// `http://localhost:<port><path-and-query>`. Fails with `port_unavailable`
/// when another program holds the port; ends with `cancelled` when stopped and
/// with `timed_out` after ten minutes.
#[tauri::command]
pub async fn start_login_callback_capture(
    port: u16,
    callback_path: Option<String>,
) -> Result<String, String> {
    let route = CallbackRoute::new(port, callback_path.as_deref()).map_err(|err| err.code())?;
    // One capture at a time: a new sign-in replaces the previous listener. The
    // cancel channel is registered before binding, so a stop that arrives while
    // the port is still being bound ends this capture instead of missing it.
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let id = NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed);
    let replaced = swap_active(Some(ActiveCapture {
        id,
        cancel: cancel_tx,
    }))
    .map(|previous| previous.cancel.send(()))
    .is_some();
    let attempts = if replaced { REBIND_ATTEMPTS } else { 1 };
    let bound = tokio::select! {
        _ = &mut cancel_rx => Err(CaptureError::Cancelled),
        bound = bind_with_retry(port, attempts) => bound,
    };
    let result = match bound {
        Ok(listener) => capture_callback(listener, route, cancel_rx, CAPTURE_TIMEOUT).await,
        Err(err) => Err(err),
    };
    clear_active(id);
    result.map_err(|err| err.code().to_string())
}

/// Stops the running capture, if any; its start call ends with `cancelled`.
#[tauri::command]
pub fn stop_login_callback_capture() {
    if let Some(active) = swap_active(None) {
        let _ = active.cancel.send(());
    }
}

/// Binds the loopback port without `SO_REUSEADDR`. With that option macOS
/// lets a `127.0.0.1` listener share a port another program holds on
/// `0.0.0.0` and take its loopback traffic; without it the bind fails with
/// `port_unavailable`, never a panic.
pub(crate) fn bind_capture_listener(port: u16) -> Result<TcpListener, CaptureError> {
    let socket = TcpSocket::new_v4().map_err(|_| CaptureError::PortUnavailable)?;
    socket
        .bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .map_err(|_| CaptureError::PortUnavailable)?;
    socket
        .listen(LISTEN_BACKLOG)
        .map_err(|_| CaptureError::PortUnavailable)
}

// A replaced capture releases its port once its task sees the cancel.
async fn bind_with_retry(port: u16, attempts: u32) -> Result<TcpListener, CaptureError> {
    let mut attempt = 1;
    loop {
        match bind_capture_listener(port) {
            Ok(listener) => return Ok(listener),
            Err(err) if attempt >= attempts => return Err(err),
            Err(_) => {
                attempt += 1;
                tokio::time::sleep(REBIND_DELAY).await;
            }
        }
    }
}

/// Serves connections until one carries the provider's redirect, answers it
/// with the signed-in page, and returns its full address. Browsers may open
/// idle connections first, so each connection is read on its own task.
pub(crate) async fn capture_callback(
    listener: TcpListener,
    route: CallbackRoute,
    mut cancel: oneshot::Receiver<()>,
    timeout: Duration,
) -> Result<String, CaptureError> {
    let route = Arc::new(route);
    let (found_tx, mut found_rx) = mpsc::channel::<String>(1);
    let mut connections = JoinSet::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut cancel => return Err(CaptureError::Cancelled),
            _ = &mut deadline => return Err(CaptureError::TimedOut),
            Some(target) = found_rx.recv() => return Ok(format!("http://localhost:{}{target}", route.port)),
            accepted = listener.accept() => {
                while connections.try_join_next().is_some() {}
                if let Ok((stream, _)) = accepted {
                    // A connection still open when the capture ends is reset rather
                    // than closed, so it leaves no TIME_WAIT that would block a rebind.
                    let _ = stream.set_zero_linger();
                    connections.spawn(serve_connection(stream, Arc::clone(&route), found_tx.clone()));
                }
            }
        }
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    route: Arc<CallbackRoute>,
    found: mpsc::Sender<String>,
) {
    let Ok(Some(head)) =
        tokio::time::timeout(REQUEST_READ_TIMEOUT, read_request_head(&mut stream)).await
    else {
        return;
    };
    match callback_target(&head, &route) {
        Ok(target) => {
            let target = target.to_string();
            // Answer before reporting: the capture drops every connection once it returns.
            respond(&mut stream, "200 OK", SIGNED_IN_PAGE).await;
            let _ = found.send(target).await;
        }
        Err(Rejection::NotFound) => respond(&mut stream, "404 Not Found", NOT_FOUND_PAGE).await,
        Err(Rejection::MethodNotAllowed) => {
            respond(&mut stream, "405 Method Not Allowed", NOT_ALLOWED_PAGE).await
        }
    }
}

async fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") && buffer.len() < MAX_REQUEST_BYTES
    {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    (!buffer.is_empty()).then(|| String::from_utf8_lossy(&buffer).into_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rejection {
    MethodNotAllowed,
    NotFound,
}

/// The origin-form target, such as `/auth/callback?code=…&state=…`, when the
/// request head is the provider's redirect: a GET for the callback path with a
/// `code` or `error` parameter, addressed to this loopback port.
fn callback_target<'a>(head: &'a str, route: &CallbackRoute) -> Result<&'a str, Rejection> {
    let mut lines = head.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let (method, target) = (
        request_line.next().unwrap_or_default(),
        request_line.next().unwrap_or_default(),
    );
    if method != "GET" {
        return Err(Rejection::MethodNotAllowed);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let host = lines.take_while(|line| !line.is_empty()).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("host")
            .then_some(value.trim())
    });
    let redirect = path == route.path
        && has_result_parameter(query)
        && host.is_some_and(|host| is_loopback_host(host, route.port));
    if redirect {
        Ok(target)
    } else {
        Err(Rejection::NotFound)
    }
}

/// An OAuth redirect carries a `code` on success or an `error` on refusal.
fn has_result_parameter(query: &str) -> bool {
    query.split('&').any(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == "code" && !value.is_empty()) || name == "error"
    })
}

/// `localhost` or `127.0.0.1`, with this port when a port is given. Any other
/// host means a page reached the port under a different name.
fn is_loopback_host(host: &str, port: u16) -> bool {
    let (name, host_port) = match host.rsplit_once(':') {
        Some((name, host_port)) => (name, Some(host_port)),
        None => (host, None),
    };
    (name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1")
        && host_port.is_none_or(|host_port| host_port.parse::<u16>() == Ok(port))
}

/// Writes the page, then waits for the browser to close first after
/// `Connection: close`: closing second leaves no TIME_WAIT on the capture port.
/// A client that stays open past the wait is reset.
async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(response.as_bytes()).await.is_err() || stream.flush().await.is_err() {
        return;
    }
    if peer_closed(stream).await {
        // Turning SO_LINGER off never blocks; only a nonzero linger would.
        #[allow(deprecated)]
        let _ = stream.set_linger(None);
    }
}

async fn peer_closed(stream: &mut TcpStream) -> bool {
    let mut sink = [0u8; 1024];
    let drained = async {
        loop {
            match stream.read(&mut sink).await {
                Ok(0) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    };
    tokio::time::timeout(PEER_CLOSE_TIMEOUT, drained)
        .await
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "login_callback_capture/tests.rs"]
mod tests;
