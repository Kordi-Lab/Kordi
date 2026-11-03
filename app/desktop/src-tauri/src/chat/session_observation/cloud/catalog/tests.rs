use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn conversation(id: &str) -> Value {
    json!({"id":id,"legacy_session_id":id,"kind":"group",
        "group_title":"Synthetic Grounding Group","shared_title":"Channel 1",
        "updated_at":"2026-01-02T00:00:00Z",
        "members":[{"account_id":"owner","display_name":"Synthetic Owner","membership_state":"active"}]})
}

fn request(query: &str) -> SearchSessionsRequest {
    SearchSessionsRequest {
        query: query.into(),
        limit: None,
        include_messages: None,
        before_sequence: None,
    }
}

fn read_request(id: &str) -> ReadSessionRequest {
    serde_json::from_value(json!({"sessionId":id,"mode":"index","limit":8})).unwrap()
}

fn catalog(base: String, active: Arc<AtomicBool>) -> OwnerCatalog {
    OwnerCatalog {
        base,
        owner: "owner".into(),
        client: reqwest::Client::new(),
        token: Arc::new(move || {
            if active.load(Ordering::SeqCst) {
                Ok("synthetic-token".into())
            } else {
                Err(unavailable())
            }
        }),
    }
}

async fn respond(listener: &tokio::net::TcpListener, status: &str, body: Value) -> String {
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
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn matches_group_channel_and_active_participant_without_transcript_hydration() {
    let mut c = conversation("cloud-only");
    c["members"]
        .as_array_mut()
        .unwrap()
        .push(json!({"display_name":"Former Person","membership_state":"left"}));
    for query in [
        "Grounding",
        "Channel1",
        "Synthetic Owner",
        "grounding group channel 1",
    ] {
        let result = search(&[c.clone()], &request(query));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].session_id, "cloud-only");
        assert_eq!(result[0].title, "Synthetic Grounding Group / Channel 1");
        assert!(result[0].snippets.is_empty());
        assert_eq!(result[0].participants, vec!["Synthetic Owner"]);
    }
    assert!(search(&[c.clone()], &request("Former Person")).is_empty());
    assert!(search(&[c], &request("unrelated")).is_empty());
}

#[test]
fn discovery_is_bounded_and_requires_an_observable_session_id() {
    let mut entries = (0..30)
        .map(|n| conversation(&format!("session-{n:02}")))
        .collect::<Vec<_>>();
    entries[0]["legacy_session_id"] = Value::Null;
    let mut query = request("Grounding");
    query.limit = Some(100);
    let result = search(&entries, &query);
    assert_eq!(result.len(), 20);
    assert_eq!(result[0].session_id, "session-01");
    query.limit = Some(1);
    assert_eq!(search(&entries, &query).len(), 1);
    assert!(search(&entries, &request("  ")).is_empty());
}

#[test]
fn catalog_is_only_available_to_the_authenticated_owner() {
    let mut identity: kordi_cli::desktop_runtime::DesktopChatContextMessage =
        serde_json::from_value(json!({
            "id":"identity","authorName":"Runtime","authorKind":"system","text":json!({
                "requestId":"request","agentId":"agent","agentName":"Synthetic Agent",
                "ownerAccountId":"owner","ownerName":"Synthetic Owner",
                "requesterAccountId":"owner","requesterName":"Synthetic Owner"
            }).to_string()
        }))
        .unwrap();
    assert!(owner_identity(Some(&identity), "owner"));
    assert!(owner_identity(None, "owner"));
    assert!(!owner_identity(None, ""));
    assert!(!owner_identity(Some(&identity), "other"));
    identity.text = identity.text.replace(
        "\"requesterAccountId\":\"owner\"",
        "\"requesterAccountId\":\"other\"",
    );
    assert!(!owner_identity(Some(&identity), "owner"));
    identity.text = "malformed".into();
    assert!(!owner_identity(Some(&identity), "owner"));
}

#[tokio::test]
async fn discovers_cloud_only_group_then_reads_fresh_image_references() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let request = respond(
                &listener,
                "200 OK",
                json!({"conversations":[conversation("cloud-only")]}),
            )
            .await;
            assert!(request.starts_with("GET /v2/chat/sync/bootstrap "));
            assert!(request.contains("Bearer synthetic-token"));
        }
        let request=respond(&listener,"200 OK",json!({
            "session":{"sessionId":"cloud-only","title":"Channel 1","kind":"group","participants":[]},
            "window":{"hasMoreBefore":false,"hasMoreAfter":false},
            "messages":[{"messageId":"new-unread","sender":"Synthetic Person","role":"human","sequenceNum":99,
                "attachments":[{"messageId":"new-unread","attachmentId":"new-image","messageVersion":3,"mimeType":"image/png","sizeBytes":74}]}]
        })).await;
        assert!(request.starts_with("POST /v1/cloud/agent-runs/desktop/read-context "));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["sessionId"], "cloud-only");
        assert_eq!(body["arguments"]["mode"], "index");
        assert_eq!(body["tool"], "read_session");
        assert!(body.get("sourceRequestId").is_none());
    });
    let owner = catalog(base, Arc::new(AtomicBool::new(true)));
    let matches = search(&owner.conversations().await.unwrap(), &request("Grounding"));
    let response = owner
        .read(read_request(&matches[0].session_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.messages[0].message_id, "new-unread");
    assert_eq!(
        response.messages[0].attachments[0].attachment_id,
        "new-image"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn removed_and_deleted_conversations_are_not_discoverable_or_readable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut left = conversation("left");
        left["members"][0]["membership_state"] = json!("left");
        for _ in 0..2 {
            respond(
                &listener,
                "200 OK",
                json!({"conversations":[left,conversation("deleted")],
                "session_visibility":{"deletedSessionIds":["deleted"]}}),
            )
            .await;
        }
    });
    let owner = catalog(base, Arc::new(AtomicBool::new(true)));
    assert!(owner.conversations().await.unwrap().is_empty());
    assert!(owner.read(read_request("left")).await.unwrap().is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn authorization_failure_and_logout_return_errors_instead_of_empty_results() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        respond(&listener, "403 Forbidden", json!({"error":"forbidden"})).await;
    });
    let active = Arc::new(AtomicBool::new(true));
    let owner = catalog(base, active.clone());
    assert!(owner
        .conversations()
        .await
        .unwrap_err()
        .to_string()
        .contains("unavailable"));
    server.await.unwrap();
    active.store(false, Ordering::SeqCst);
    assert!(owner.read(read_request("cloud-only")).await.is_err());
}

#[tokio::test]
async fn attachment_mode_preserves_fresh_image_media_and_version() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        respond(
            &listener,
            "200 OK",
            json!({"conversations":[conversation("cloud-only")]}),
        )
        .await;
        let request = respond(&listener, "200 OK", json!({
            "session":{"sessionId":"cloud-only","title":"Channel 1","kind":"group","participants":[]},
            "window":{"hasMoreBefore":false,"hasMoreAfter":false},"messages":[],
            "media":[{"type":"image","mime_type":"image/png","data":"synthetic-image-payload"}]
        })).await;
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["arguments"]["mode"], "attachment");
        assert_eq!(body["arguments"]["attachmentId"], "new-image");
        assert_eq!(body["arguments"]["expectedVersion"], 3);
        assert_eq!(body["arguments"]["messageIds"], json!(["new-unread"]));
    });
    let owner = catalog(base, Arc::new(AtomicBool::new(true)));
    let mut request = read_request(" cloud-only ");
    request.mode = Some("attachment".into());
    request.attachment_id = Some("new-image".into());
    request.expected_version = Some(3);
    request.message_ids = Some(vec!["new-unread".into()]);
    let response = owner.read(request).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(response.media).unwrap(),
        json!([
            {"type":"image","mime_type":"image/png","data":"synthetic-image-payload"}
        ])
    );
    server.await.unwrap();
}

#[tokio::test]
async fn logout_during_catalog_request_discards_the_response() {
    use std::sync::atomic::AtomicUsize;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        respond(
            &listener,
            "200 OK",
            json!({"conversations":[conversation("cloud-only")]}),
        )
        .await;
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let source = calls.clone();
    let mut owner = catalog(base, Arc::new(AtomicBool::new(true)));
    owner.token = Arc::new(move || {
        if source.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok("synthetic-token".into())
        } else {
            Err(unavailable())
        }
    });
    assert!(owner.conversations().await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.await.unwrap();
}
