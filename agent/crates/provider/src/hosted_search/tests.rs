use super::*;
use crate::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions};
use std::collections::HashMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

async fn serve(events: Vec<Value>) -> (String, tokio::task::JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (header, end, length) = loop {
            let mut chunk = [0u8; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                break (header, end + 4, length);
            }
        };
        while bytes.len() < end + length {
            let mut chunk = [0u8; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        let request = serde_json::from_slice(&bytes[end..end + length]).unwrap();
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        (header, request)
    });
    (base, task)
}
fn request() -> CompletionRequest {
    CompletionRequest {
        system_prompt: "Search with sources.".into(),
        messages: vec![json!({"role":"user","content":"synthetic query"})],
        tools: vec![
            json!({"type":"function","function":{"name":"web_search","search_options":{"allowed_domains":["example.com"]}}}),
        ],
        extra_tool_schemas: vec![],
        model: "gpt-5.5".into(),
        max_tokens: Some(4096),
        stream: true,
        thinking: None,
    }
}
fn options(base_url: String) -> RequestOptions {
    RequestOptions {
        provider: "openai".into(),
        api_key: "synthetic-token".into(),
        auth_mode: ProviderAuthMode::OAuth,
        auth_account_id: Some("synthetic-account".into()),
        base_url,
        headers: HashMap::from([("x-selected-route".into(), "fixture".into())]),
        cancel: CancellationToken::new(),
        retry_callback: None,
        max_retries: 0,
        retry_base_delay_ms: 0,
        max_retry_delay_ms: 0,
    }
}
#[tokio::test]
async fn codex_native_search_uses_selected_auth_and_preserves_sources() {
    let (base,server)=serve(vec![
        json!({"type":"response.output_item.done","item":{"type":"web_search_call","action":{"sources":[{"url":"https://example.com/source","title":"Source"}]}}}),
        json!({"type":"response.output_text.delta","delta":"Summary"}),
        json!({"type":"response.completed","response":{"output":[]}}),
    ]).await;
    let events = crate::openai::OpenAiProvider::new()
        .complete(request(), options(base))
        .await
        .unwrap();
    let (header, body) = server.await.unwrap();
    assert!(header.starts_with("POST /codex/responses "));
    assert!(
        header
            .to_lowercase()
            .contains("authorization: bearer synthetic-token")
    );
    assert!(
        header
            .to_lowercase()
            .contains("chatgpt-account-id: synthetic-account")
    );
    assert!(header.contains("x-selected-route: fixture"));
    assert_eq!(body["model"], "gpt-5.5");
    assert_eq!(body["tool_choice"], json!({"type":"web_search"}));
    assert_eq!(
        body["tools"][0]["filters"]["allowed_domains"],
        json!(["example.com"])
    );
    assert!(
        body["include"]
            .as_array()
            .unwrap()
            .contains(&json!("web_search_call.action.sources"))
    );
    assert!(events.iter().any(|event|matches!(event,StreamEvent::ServerToolResult {result,..} if result["sources"][0]["url"]=="https://example.com/source")));
}
#[test]
fn terminal_annotations_are_preserved_and_regular_calls_are_unchanged() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    responses_sources(
        &json!({"response":{"output":[{"type":"message","content":[{"annotations":[{"type":"url_citation","url":"https://example.com/citation","title":"Citation"}]}]}]}}),
        &tx,
    );
    assert!(
        matches!(rx.try_recv().unwrap(),StreamEvent::ServerToolResult {result,..} if result["sources"][0]["url"]=="https://example.com/citation")
    );
    let mut body = json!({"tools":[{"type":"web_search"}],"tool_choice":"auto"});
    let original = body.clone();
    configure_responses(&mut body, &[json!({"function":{"name":"web_search"}})]);
    assert_eq!(body, original);
}

#[tokio::test]
async fn anthropic_native_filters_and_sources_survive_transport() {
    let (base,server)=serve(vec![json!({"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":"search","content":[{"type":"web_search_result","url":"https://example.com/source","title":"Source"}]}}),json!({"type":"message_stop"})]).await;
    let mut req = request();
    req.model = "claude-sonnet-4-6".into();
    let mut opts = options(base);
    opts.auth_mode = ProviderAuthMode::ApiKey;
    opts.provider = "anthropic".into();
    let events = crate::anthropic::AnthropicProvider::new()
        .complete(req, opts)
        .await
        .unwrap();
    let (_, body) = server.await.unwrap();
    assert_eq!(body["tools"][0]["type"], "web_search_20250305");
    assert_eq!(body["tools"][0]["allowed_domains"], json!(["example.com"]));
    assert_eq!(body["tools"][0]["max_uses"], 1);
    assert!(events.iter().any(|event|matches!(event,StreamEvent::ServerToolResult {result,..} if result["content"][0]["url"]=="https://example.com/source")));
}

#[tokio::test]
async fn google_native_grounding_sources_survive_transport() {
    let (base,server)=serve(vec![json!({"candidates":[{"content":{"parts":[{"text":"Summary"}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.com/source","title":"Source"}}]}}]})]).await;
    let mut req = request();
    req.model = "gemini-2.5-flash".into();
    let mut opts = options(base);
    opts.auth_mode = ProviderAuthMode::ApiKey;
    opts.provider = "google".into();
    let events = crate::google::GoogleProvider::new()
        .complete(req, opts)
        .await
        .unwrap();
    let (_, body) = server.await.unwrap();
    assert_eq!(body["tools"][0], json!({"google_search":{}}));
    assert!(events.iter().any(|event|matches!(event,StreamEvent::ServerToolResult {result,..} if result["sources"][0]["url"]=="https://example.com/source")));
}
