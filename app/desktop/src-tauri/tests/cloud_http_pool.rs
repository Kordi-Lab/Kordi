#[path = "support/http_fixture.rs"]
mod fixture;
use fixture::{Desktop, Server};
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, mpsc},
    thread,
    time::{Duration, Instant},
};

fn request(app: &Desktop, server: &Server, path: &str, token: &str, overrides: Value) -> Value {
    let mut config = json!({"method":"GET","url":server.url(path),"headers":[["authorization",token]],"data":null});
    config
        .as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    app.invoke("fetch", json!({"clientConfig":config})).unwrap()
}
fn response(app: &Desktop, rid: Value) -> Value {
    let res = app.invoke("fetch_send", json!({"rid":rid})).unwrap();
    let body = app.drain(&res["rid"]);
    if res["status"] == 200 {
        assert_eq!(body, b"ok");
    }
    res
}

#[test]
fn native_http_reuses_connections_without_reusing_request_authorization() {
    let server = Server::new();
    let app = Desktop::new();
    for (path, token) in [
        ("/first", "Bearer fixture-one"),
        ("/second", "Bearer fixture-two"),
    ] {
        assert_eq!(
            response(&app, request(&app, &server, path, token, json!({})))["status"],
            200
        );
    }
    let requests = server.requests.lock().unwrap();
    assert!(requests[0]
        .to_lowercase()
        .contains("authorization: bearer fixture-one"));
    assert!(requests[1]
        .to_lowercase()
        .contains("authorization: bearer fixture-two"));
    assert!(requests[1].contains("fixture_session=one"));
    drop(requests);
    assert_eq!(
        server.connections.load(Ordering::SeqCst),
        1,
        "sequential requests should use the same TCP connection"
    );
    let denied = app.invoke("fetch", json!({"clientConfig":{"method":"GET","url":"https://example.invalid/private","headers":[],"data":null}}));
    assert!(
        denied.is_err(),
        "a warm client must still enforce the URL scope"
    );
    let limited = response(
        &app,
        request(&app, &server, "/redirect", "", json!({"maxRedirections":0})),
    );
    assert_eq!(
        limited["status"], 302,
        "explicit request settings must not use the default client"
    );
    let normal = response(&app, request(&app, &server, "/redirect", "", json!({})));
    assert_eq!(
        normal["status"], 200,
        "custom settings must not change the cached client's defaults"
    );
}

#[test]
fn cancelling_a_request_does_not_cancel_later_requests() {
    let server = Server::new();
    let app = Desktop::new();
    let rid = request(&app, &server, "/slow", "", json!({}));
    let window = app.window();
    let send_rid = rid.clone();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        tx.send(fixture::raw(&window, "fetch_send", json!({"rid":send_rid})).is_err())
            .unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.requests.lock().unwrap().is_empty() {
        assert!(
            Instant::now() < deadline,
            "request did not reach the test server"
        );
        thread::sleep(Duration::from_millis(5));
    }
    app.invoke("fetch_cancel", json!({"rid":rid})).unwrap();
    assert!(rx
        .recv_timeout(Duration::from_secs(5))
        .expect("cancelled request must finish"));
    worker.join().unwrap();
    assert_eq!(
        response(&app, request(&app, &server, "/after", "", json!({})))["status"],
        200
    );
}

#[test]
fn cancelling_a_response_body_leaves_the_client_usable() {
    let server = Server::new();
    let app = Desktop::new();
    let rid = request(&app, &server, "/stream", "", json!({}));
    let res = app.invoke("fetch_send", json!({"rid":rid})).unwrap();
    app.invoke("fetch_cancel_body", json!({"rid":res["rid"]}))
        .unwrap();
    assert_eq!(
        response(&app, request(&app, &server, "/after", "", json!({})))["status"],
        200
    );
}

#[test]
fn separate_app_instances_do_not_share_connections_or_cookies() {
    let server = Server::new();
    let first = Desktop::new();
    let second = Desktop::new();
    response(&first, request(&first, &server, "/first", "", json!({})));
    response(&second, request(&second, &server, "/second", "", json!({})));
    assert_eq!(server.connections.load(Ordering::SeqCst), 2);
    assert!(!server.requests.lock().unwrap()[1].contains("fixture_session"));
}

// Opt-in measurement only: CI never needs a shared backend or private targets.
#[test]
#[ignore = "requires an explicitly selected, already-running development loopback tunnel"]
fn measure_development_tunnel_connection_reuse() {
    let origin =
        std::env::var("KORDI_HTTP_BENCHMARK_ORIGIN").expect("set the approved loopback origin");
    let url = reqwest::Url::parse(&origin).expect("valid loopback origin");
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(url.port().is_some());
    assert!(url.username().is_empty() && url.password().is_none());
    assert!(url.query().is_none() && url.fragment().is_none() && url.path() == "/");
    let app = Desktop::new();
    let sample = |fresh: bool| {
        let mut config = json!({"method":"GET","url":url.join("health").unwrap().as_str(),"headers":[],"data":null});
        // A request-specific timeout intentionally bypasses the default pool,
        // reproducing the old per-request client without changing global state.
        if fresh {
            config["connectTimeout"] = json!(10_000);
        }
        let start = Instant::now();
        let rid = app.invoke("fetch", json!({"clientConfig":config})).unwrap();
        let response = app.invoke("fetch_send", json!({"rid":rid})).unwrap();
        assert_eq!(response["status"], 200);
        let body: Value = serde_json::from_slice(&app.drain(&response["rid"])).unwrap();
        assert_eq!(body["ok"], true);
        start.elapsed().as_millis()
    };
    sample(false);
    let mut pooled = Vec::new();
    let mut fresh = Vec::new();
    for _ in 0..8 {
        fresh.push(sample(true));
        pooled.push(sample(false));
    }
    eprintln!("native HTTP milliseconds: fresh={fresh:?}; reused={pooled:?}");
}
