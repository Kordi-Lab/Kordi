use super::*;

// The command tests share the one active-capture slot, so they run one at a time.
static COMMAND_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn route(port: u16) -> CallbackRoute {
    CallbackRoute::new(port, None).unwrap()
}

/// Sends a request and reads the whole answer, closing its own end first like a browser.
async fn send(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

fn listening() -> (TcpListener, u16) {
    let listener = bind_capture_listener(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

fn get(target: &str, host: &str) -> String {
    format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\n\r\n")
}

#[test]
fn only_the_provider_redirect_is_accepted() {
    let route = CallbackRoute::new(1455, Some("/auth/callback")).unwrap();
    let accepted = [
        get("/auth/callback?code=abc&state=xyz", "localhost:1455"),
        get("/auth/callback?state=xyz&code=abc", "127.0.0.1:1455"),
        get("/auth/callback?error=access_denied&state=xyz", "LOCALHOST"),
        "GET /auth/callback?code=abc HTTP/1.1\nhost: localhost:1455\n\n".to_string(),
    ];
    for head in &accepted {
        assert!(callback_target(head, &route).is_ok(), "{head}");
    }
    assert_eq!(
        callback_target(&accepted[0], &route),
        Ok("/auth/callback?code=abc&state=xyz")
    );

    let not_found = [
        get("/", "localhost:1455"),
        get("/favicon.ico", "localhost:1455"),
        get("/auth/callback", "localhost:1455"),
        get("/auth/callback?state=xyz", "localhost:1455"),
        get("/auth/callback?code=&state=xyz", "localhost:1455"),
        get("/auth/callback/extra?code=abc", "localhost:1455"),
        get("/auth/callback?code=abc", "attacker.example:1455"),
        get("/auth/callback?code=abc", "localhost.attacker.example"),
        get("/auth/callback?code=abc", "localhost:8080"),
        "GET /auth/callback?code=abc HTTP/1.1\r\n\r\n".to_string(),
    ];
    for head in &not_found {
        assert_eq!(
            callback_target(head, &route),
            Err(Rejection::NotFound),
            "{head}"
        );
    }
    assert_eq!(
        callback_target(
            "POST /auth/callback?code=abc HTTP/1.1\r\nHost: localhost:1455\r\n\r\n",
            &route
        ),
        Err(Rejection::MethodNotAllowed)
    );
}

#[test]
fn the_callback_path_comes_from_the_catalog_or_defaults() {
    assert_eq!(
        CallbackRoute::new(1455, None).unwrap().path,
        "/auth/callback"
    );
    assert_eq!(
        CallbackRoute::new(1455, Some("  ")).unwrap().path,
        "/auth/callback"
    );
    assert_eq!(
        CallbackRoute::new(8085, Some("/oauth2callback"))
            .unwrap()
            .path,
        "/oauth2callback"
    );
    for invalid in ["auth/callback", "/auth?x=1", "/auth#x", "/auth callback"] {
        assert_eq!(
            CallbackRoute::new(1455, Some(invalid)),
            Err(CaptureError::InvalidCallbackPath),
            "{invalid}"
        );
    }
    assert_eq!(CallbackRoute::new(0, None), Err(CaptureError::InvalidPort));
}

#[tokio::test]
async fn stray_requests_are_refused_and_the_redirect_still_arrives() {
    let (listener, port) = listening();
    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let capture = tokio::spawn(capture_callback(
        listener,
        route(port),
        cancel_rx,
        Duration::from_secs(5),
    ));

    // An idle preconnect, another method, another path and another host do not end the capture.
    let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let host = format!("localhost:{port}");
    let rejected = send(
        port,
        &format!("POST /auth/callback HTTP/1.1\r\nHost: {host}\r\n\r\n"),
    )
    .await;
    assert!(rejected.starts_with("HTTP/1.1 405"));
    for stray in [
        get("/", &host),
        get("/auth/callback", &host),
        get("/auth/callback?code=stolen", "attacker.example"),
    ] {
        assert!(
            send(port, &stray).await.starts_with("HTTP/1.1 404"),
            "{stray}"
        );
    }

    let response = send(
        port,
        &get("/auth/callback?code=test-code&state=test-state", &host),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(response.contains("Signed in. You can return to Kordi."));
    assert_eq!(
        capture.await.unwrap(),
        Ok(format!(
            "http://localhost:{port}/auth/callback?code=test-code&state=test-state"
        ))
    );
    // Neither the answered browser nor the idle connection keeps the port.
    assert!(bind_with_retry(port, REBIND_ATTEMPTS).await.is_ok());
}

#[tokio::test]
async fn a_busy_port_is_an_error() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    assert_eq!(
        bind_capture_listener(port).err(),
        Some(CaptureError::PortUnavailable)
    );
}

#[tokio::test]
async fn cancel_and_timeout_release_the_port() {
    let (listener, port) = listening();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let capture = tokio::spawn(capture_callback(
        listener,
        route(port),
        cancel_rx,
        Duration::from_secs(5),
    ));
    cancel_tx.send(()).unwrap();
    assert_eq!(capture.await.unwrap(), Err(CaptureError::Cancelled));
    let listener = bind_capture_listener(port).unwrap();

    let (_cancel_tx, cancel_rx) = oneshot::channel();
    let result =
        capture_callback(listener, route(port), cancel_rx, Duration::from_millis(50)).await;
    assert_eq!(result, Err(CaptureError::TimedOut));
    assert!(bind_capture_listener(port).is_ok());
}

#[tokio::test]
async fn the_command_rejects_bad_input_and_a_busy_port() {
    let _serial = COMMAND_TESTS.lock().await;
    assert_eq!(
        start_login_callback_capture(0, None).await,
        Err("invalid_port".to_string())
    );
    assert_eq!(
        start_login_callback_capture(1455, Some("auth".to_string())).await,
        Err("invalid_callback_path".to_string())
    );
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    assert_eq!(
        start_login_callback_capture(port, None).await,
        Err("port_unavailable".to_string())
    );
    stop_login_callback_capture();
}

#[tokio::test]
async fn a_stop_during_the_bind_retry_ends_the_new_capture() {
    let _serial = COMMAND_TESTS.lock().await;
    let (free, free_port) = listening();
    drop(free);
    let first = tokio::spawn(start_login_callback_capture(free_port, None));
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The replacement retries a busy port for about a second; a stop in that window ends it.
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let busy_port = taken.local_addr().unwrap().port();
    let started = std::time::Instant::now();
    let second = tokio::spawn(start_login_callback_capture(busy_port, None));
    tokio::time::sleep(Duration::from_millis(150)).await;
    stop_login_callback_capture();

    assert_eq!(first.await.unwrap(), Err("cancelled".to_string()));
    assert_eq!(second.await.unwrap(), Err("cancelled".to_string()));
    assert!(started.elapsed() < Duration::from_millis(800));
    assert!(swap_active(None).is_none(), "nothing keeps the slot");
}
