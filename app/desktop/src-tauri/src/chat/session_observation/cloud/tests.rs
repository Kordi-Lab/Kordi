use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn endpoint_is_scoped_and_encodes_the_run_identifier() {
    assert_eq!(
        endpoint("http://127.0.0.1:17081", "run-fixture"),
        "http://127.0.0.1:17081/v1/cloud/agent-runs/desktop/run-fixture/context"
    );
    assert!(endpoint("https://example.com", "run/other").contains("run%2Fother/context"));
}

#[tokio::test]
async fn history_uses_the_cloud_lease_without_a_local_canonical_session() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() < end + 4 + length {
                    continue;
                }
                assert!(header.contains("Bearer fixture-token"));
                let request: Value = serde_json::from_slice(&bytes[end + 4..]).unwrap();
                assert_eq!(request["claimId"], "fixture-claim");
                assert_eq!(request["arguments"]["sessionId"], "cloud-only-session");
                break;
            }
        }
        let response=json!({"session":{"sessionId":"cloud-only-session","title":"Cloud chat","kind":"group","participants":[]},"window":{"aroundMessageId":null,"hasMoreBefore":false,"hasMoreAfter":false},"messages":[{"messageId":"message-1","sender":"Person","role":"human","sequenceNum":1,"attachments":[{"messageId":"message-1","attachmentId":"image-1","messageVersion":2,"mimeType":"image/png","sizeBytes":74}]}]}).to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
    });
    let logged_in = Arc::new(AtomicBool::new(true));
    let active = logged_in.clone();
    let observation = Arc::new(CloudObservation {
        lease: DesktopCloudExecutionLease {
            session_id: "cloud-only-session".into(),
            run_id: "run-fixture".into(),
            claim_id: "fixture-claim".into(),
            owner_account_id: "fixture-owner".into(),
        },
        scope: "cloud-only-session".into(),
        endpoint: endpoint(&base, "run-fixture"),
        client: reqwest::Client::new(),
        token: Arc::new(move || {
            if active.load(Ordering::SeqCst) {
                Ok("fixture-token".into())
            } else {
                Err(unavailable())
            }
        }),
    });
    let runtime = runtime(observation, None);
    let preview = attachment_preview(&runtime, "cloud-only-session").await;
    assert!(preview.contains("image-1"));
    assert!(preview.contains("messageVersion"));
    assert!(!preview.contains("fixture-token"));
    assert!(!preview.contains("fixture-claim"));
    server.await.unwrap();
    logged_in.store(false, Ordering::SeqCst);
    assert!(attachment_preview(&runtime, "cloud-only-session")
        .await
        .contains("could not be loaded"));
    assert!(attachment_preview(&runtime, "another-session")
        .await
        .contains("could not be loaded"));
}
