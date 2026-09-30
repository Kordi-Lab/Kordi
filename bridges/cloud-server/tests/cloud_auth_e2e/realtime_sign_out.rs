//! Open v1 gateway and v2 realtime sockets over a loopback listener, sign
//! one session out over HTTP, and check that only that session's sockets
//! close.

use super::*;

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use kordi_cloud_server::server::router_with_rate_limiter;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Synthetic cursor secret for this test process only.
const TEST_CURSOR_SECRET: &str = "realtime-sign-out-test-cursor-secret-0123456789";
/// Sockets re-check their session every 2 seconds; allow scheduling slack.
const CLOSE_DEADLINE: Duration = Duration::from_secs(6);

async fn serve(router: axum::Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    address
}

async fn open_v1(address: SocketAddr, token: &str) -> Socket {
    let (mut socket, _) = connect_async(format!("ws://{address}/v1/cloud/ws?token={token}"))
        .await
        .expect("v1 socket connects");
    let first = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("v1 socket greets the client")
        .expect("v1 socket stays open")
        .unwrap();
    let Message::Text(body) = first else {
        panic!("expected a text greeting, got {first:?}");
    };
    assert!(body.contains("connected"), "unexpected greeting {body}");
    socket
}

async fn open_v2(router: &axum::Router, address: SocketAddr, token: &str) -> Socket {
    let ticket = router
        .clone()
        .oneshot(post_with_token("/v2/chat/realtime/ticket", token))
        .await
        .unwrap();
    assert_eq!(ticket.status(), StatusCode::CREATED);
    let ticket = read_json(ticket).await;
    let bootstrap = router
        .clone()
        .oneshot(get_with_token("/v2/chat/sync/bootstrap", token))
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::OK);
    let bootstrap = read_json(bootstrap).await;

    let (mut socket, _) = connect_async(format!(
        "ws://{address}/v2/chat/realtime?ticket={}",
        ticket["ticket"].as_str().unwrap()
    ))
    .await
    .expect("v2 socket connects");
    socket
        .send(Message::Text(
            json!({
                "type": "connect",
                "protocol_version": 2,
                "device_id": ticket["device_id"],
                "cursor": bootstrap["next_cursor"],
            })
            .to_string(),
        ))
        .await
        .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("v2 socket says hello")
            .expect("v2 socket stays open")
            .unwrap();
        if let Message::Text(body) = &frame {
            let value: serde_json::Value = serde_json::from_str(body).unwrap();
            if value["type"] == "hello" {
                return socket;
            }
        }
    }
}

/// Reads frames until the server closes the socket. Returns how long that
/// took, or `None` when the socket is still open at `deadline`.
async fn wait_for_close(socket: &mut Socket, deadline: Duration) -> Option<Duration> {
    let started = tokio::time::Instant::now();
    loop {
        let remaining = deadline.checked_sub(started.elapsed())?;
        match tokio::time::timeout(remaining, socket.next()).await {
            Err(_) => return None,
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => {
                return Some(started.elapsed());
            }
            Ok(Some(Ok(_))) => {}
        }
    }
}

#[tokio::test]
async fn signing_out_closes_that_sessions_v1_and_v2_sockets() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CHAT_SYNC_CURSOR_SECRET", TEST_CURSOR_SECRET);
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = router_with_rate_limiter(
        state,
        CloudRateLimiter::memory(CloudRateLimitConfig {
            per_ip_limit: 10_000,
            ..CloudRateLimitConfig::production()
        }),
    );
    let address = serve(router.clone()).await;
    let (target, _) = signup_account(&router, "realtime-sign-out").await;
    let (control, _) = signup_account(&router, "realtime-stays-open").await;

    let mut target_v1 = open_v1(address, &target).await;
    let mut target_v2 = open_v2(&router, address, &target).await;
    let mut control_v1 = open_v1(address, &control).await;
    let mut control_v2 = open_v2(&router, address, &control).await;

    let logout = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/auth/logout", &target))
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);

    let (v1_closed, v2_closed) = tokio::join!(
        wait_for_close(&mut target_v1, CLOSE_DEADLINE),
        wait_for_close(&mut target_v2, CLOSE_DEADLINE),
    );
    assert!(
        v1_closed.is_some(),
        "the v1 gateway socket must close after its session signs out"
    );
    assert!(
        v2_closed.is_some(),
        "the v2 realtime socket must close after its session signs out"
    );

    // Another revalidation cycle passes without closing the other session.
    let (control_v1_closed, control_v2_closed) = tokio::join!(
        wait_for_close(&mut control_v1, Duration::from_millis(2_500)),
        wait_for_close(&mut control_v2, Duration::from_millis(2_500)),
    );
    assert_eq!(
        control_v1_closed, None,
        "other sessions keep their v1 socket"
    );
    assert_eq!(
        control_v2_closed, None,
        "other sessions keep their v2 socket"
    );
}
