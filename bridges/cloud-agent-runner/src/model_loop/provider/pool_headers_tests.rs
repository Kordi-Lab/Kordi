//! A resource pool's provider payload, as the server hands it out, reaches an
//! OpenAI-compatible endpoint with its base URL, model and extra headers.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::client::AgentRuntimeRoute;

fn pool_material() -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "pip-service-openai".to_string(),
        provider: "openrouter".to_string(),
        auth_choice: "pip-service-api-key".to_string(),
        payload: json!({
            "apiKey": "synthetic-pool-key",
            "baseUrl": "https://gateway.example.test/api/v1",
            "model": "vendor/synthetic-model",
            "headers": {
                "http-referer": "https://app.example.test",
                "x-title": "Example",
                "authorization": "Bearer not-from-a-payload",
                "bad header": "dropped",
            },
        }),
    }
}

#[test]
fn payload_headers_are_kept_except_reserved_ones() {
    let auth = OpenAiProviderConfig::from_material(&pool_material()).unwrap();
    assert_eq!(
        auth.headers,
        BTreeMap::from([
            (
                "http-referer".to_string(),
                "https://app.example.test".to_string()
            ),
            ("x-title".to_string(), "Example".to_string()),
        ])
    );
    let mut plain = pool_material();
    plain.payload.as_object_mut().unwrap().remove("headers");
    assert!(OpenAiProviderConfig::from_material(&plain)
        .unwrap()
        .headers
        .is_empty());
}

/// Reads one HTTP request: the head as lowercase text and the JSON body.
async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "the client closed the request early");
        bytes.extend_from_slice(&buffer[..read]);
        let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
        let length: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .map(|value| value.trim().parse().unwrap())
            .unwrap_or(0);
        if bytes.len() >= end + 4 + length {
            let body = serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
            return (head, body);
        }
    }
}

#[tokio::test]
async fn a_pool_request_uses_its_base_url_model_and_headers() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        let chunks = [
            json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"Pool reply."},"finish_reason":null}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        ];
        let body = chunks
            .into_iter()
            .map(|mut chunk| {
                chunk["id"] = json!("fixture");
                chunk["object"] = json!("chat.completion.chunk");
                chunk["created"] = json!(1);
                chunk["model"] = json!("vendor/synthetic-model");
                format!("data: {chunk}\n\n")
            })
            .collect::<String>()
            + "data: [DONE]\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        request
    });

    let mut auth = OpenAiProviderConfig::from_material(&pool_material()).unwrap();
    auth.apply_runtime_route(
        &AgentRuntimeRoute {
            default_model: Some("vendor/synthetic-model".to_string()),
            thinking: None,
        },
        "openrouter",
    )
    .unwrap();
    // A pool gateway keeps its vendor-prefixed model id.
    assert_eq!(auth.model, "vendor/synthetic-model");
    // The runner refuses loopback endpoints from a payload, so the test
    // points the validated config at the mock server afterwards.
    auth.base_url = format!("http://127.0.0.1:{port}/api/v1");
    let reply = OpenAiCompatibleProvider::default()
        .next_response(
            &auth,
            &[
                json!({"role": "system", "content": "Synthetic instructions."}),
                json!({"role": "user", "content": "Synthetic input."}),
            ],
            &[],
        )
        .await
        .unwrap();
    assert!(matches!(reply, ModelProviderResponse::FinalText(text) if text == "Pool reply."));

    let (head, body) = server.await.unwrap();
    assert!(
        head.starts_with("post /api/v1/chat/completions "),
        "request line: {}",
        head.lines().next().unwrap_or_default()
    );
    assert!(head.contains("\r\nauthorization: bearer synthetic-pool-key"));
    assert!(head.contains("\r\nhttp-referer: https://app.example.test"));
    assert!(head.contains("\r\nx-title: example"));
    assert!(!head.contains("not-from-a-payload"));
    assert_eq!(body["model"], "vendor/synthetic-model");
}
