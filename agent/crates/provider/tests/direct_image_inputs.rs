#[path = "support/images.rs"]
mod fixtures;

use base64::Engine;
use kordi_provider::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions};
use kordi_provider::{
    anthropic::AnthropicProvider, google::GoogleProvider, openai::OpenAiProvider,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug)]
enum Route {
    Chat,
    OAuth,
    Anthropic,
    Google,
}

impl Route {
    fn provider(self) -> Box<dyn Provider> {
        match self {
            Self::Chat | Self::OAuth => Box::new(OpenAiProvider::new()),
            Self::Anthropic => Box::new(AnthropicProvider::new()),
            Self::Google => Box::new(GoogleProvider::new()),
        }
    }

    fn options(self, base_url: String) -> RequestOptions {
        RequestOptions {
            provider: "image-fixture".into(),
            api_key: String::new(),
            base_url,
            auth_mode: if matches!(self, Self::OAuth) {
                ProviderAuthMode::OAuth
            } else {
                ProviderAuthMode::ApiKey
            },
            auth_account_id: matches!(self, Self::OAuth).then(|| "fixture-account".into()),
            headers: Default::default(),
            cancel: CancellationToken::new(),
            retry_callback: None,
            max_retries: 0,
            retry_base_delay_ms: 0,
            max_retry_delay_ms: 0,
        }
    }
}

fn image(bytes: &[u8]) -> Value {
    json!({"type":"image", "source": {
        "type":"base64", "media_type":"image/png",
        "data": base64::engine::general_purpose::STANDARD.encode(bytes)
    }})
}

fn request(content: Value) -> CompletionRequest {
    CompletionRequest {
        system_prompt: String::new(),
        messages: vec![json!({"role":"user", "content":content})],
        tools: vec![],
        extra_tool_schemas: vec![],
        model: "fixture-model".into(),
        max_tokens: Some(8),
        stream: true,
        thinking: None,
    }
}

#[tokio::test]
async fn outgoing_requests_preserve_active_model_context() {
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        let mut request = request(json!("hello"));
        request.system_prompt = kordi_provider::with_active_model_context(
            "Keep these instructions",
            &request.model,
            "fixture-provider",
        );
        let expected = request.system_prompt.clone();
        let (body, result) = capture(route, request, false).await;
        result.unwrap();
        let actual = match route {
            Route::Chat => &body["messages"][0]["content"],
            Route::OAuth => &body["instructions"],
            Route::Anthropic => &body["system"][0]["text"],
            Route::Google => &body["systemInstruction"]["parts"][0]["text"],
        };
        assert_eq!(actual, &json!(expected), "{route:?}");
    }
}

async fn capture(
    route: Route,
    request: CompletionRequest,
    reject: bool,
) -> (Value, Result<(), String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (header_end, length) = loop {
            let mut chunk = [0; 4096];
            let size = socket.read(&mut chunk).await.unwrap();
            assert!(size > 0);
            bytes.extend_from_slice(&chunk[..size]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < header_end + length {
            let mut chunk = [0; 4096];
            let size = socket.read(&mut chunk).await.unwrap();
            assert!(size > 0);
            bytes.extend_from_slice(&chunk[..size]);
        }
        let body: Value = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
        let (status, content_type, response) = if reject {
            (
                "400 Bad Request",
                "application/json",
                r#"{"error":{"message":"Selected model does not support image inputs. Select an image-capable model."}}"#,
            )
        } else {
            ("200 OK", "text/event-stream", "data: [DONE]\n\n")
        };
        socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
        body
    });
    let result = timeout(
        Duration::from_secs(5),
        route.provider().complete(request, route.options(base)),
    )
    .await
    .unwrap()
    .map(|_| ())
    .map_err(|e| e.to_string());
    let body = timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    (body, result)
}

fn expected_blocks(route: Route, blocks: &[Value]) -> Value {
    json!(blocks.iter().map(|b| {
        if b["type"] == "text" {
            return match route {
                Route::OAuth => json!({"type":"input_text", "text":b["text"]}),
                Route::Google => json!({"text":b["text"]}),
                _ => b.clone(),
            };
        }
        let source = &b["source"];
        let url = format!("data:{};base64,{}",source["media_type"].as_str().unwrap(),source["data"].as_str().unwrap());
        match route {
            Route::Chat => json!({"type":"image_url", "image_url":{"url":url}}),
            Route::OAuth => json!({"type":"input_image", "image_url":url,"detail":"high"}),
            Route::Anthropic => b.clone(),
            Route::Google => json!({"inlineData":{"mimeType":source["media_type"],"data":source["data"]}}),
        }
    }).collect::<Vec<_>>())
}

#[tokio::test]
async fn outgoing_requests_preserve_single_and_multiple_images_with_text_order() {
    let red = image(fixtures::RED_BLUE);
    let green = image(fixtures::GREEN_WHITE);
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        for blocks in [
            vec![red.clone()],
            vec![
                json!({"type":"text","text":"Compare"}),
                red.clone(),
                json!({"type":"text","text":"with"}),
                green.clone(),
            ],
        ] {
            let (body, result) = capture(route, request(json!(blocks)), false).await;
            assert!(result.is_ok(), "{route:?}: {result:?}");
            let mut actual = match route {
                Route::OAuth => body["input"][0]["content"].clone(),
                Route::Google => body["contents"][0]["parts"].clone(),
                _ => body["messages"][0]["content"].clone(),
            };
            if matches!(route, Route::Anthropic) {
                for block in actual.as_array_mut().unwrap() {
                    block.as_object_mut().unwrap().remove("cache_control");
                }
            }
            assert_eq!(actual, expected_blocks(route, &blocks), "{route:?}");
        }
        let (body, result) = capture(route, request(json!("text only")), false).await;
        assert!(result.is_ok());
        assert!(body.to_string().contains("text only"));
        assert!(!body.to_string().contains("base64"));
    }
}

#[tokio::test]
async fn invalid_direct_images_fail_before_network_and_do_not_expose_payloads() {
    let valid = image(fixtures::RED_BLUE);
    let mut invalid = valid.clone();
    invalid["source"]["data"] = json!("private-invalid-payload!");
    let mut missing = valid.clone();
    missing["source"].as_object_mut().unwrap().remove("data");
    let mut unsupported = valid.clone();
    unsupported["source"]["media_type"] = json!("video/mp4");
    let mut source = valid.clone();
    source["source"]["type"] = json!("url");
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        for block in [&invalid, &missing, &unsupported, &source] {
            let error = route
                .provider()
                .complete(
                    request(json!([block])),
                    route.options("http://127.0.0.1:1".into()),
                )
                .await
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("Cannot send image in message 1, content block 1"),
                "{route:?}: {error}"
            );
            assert!(!error.contains("private-invalid-payload"));
        }
    }
}

#[tokio::test]
async fn openai_routes_preserve_image_urls_and_detail_without_fetching_them() {
    for route in [Route::Chat, Route::OAuth] {
        let url = "https://example.com/marker.png";
        let blocks = json!([{"type":"image_url","image_url":{"url":url,"detail":"low"}}]);
        let (body, result) = capture(route, request(blocks.clone()), false).await;
        assert!(result.is_ok());
        if matches!(route, Route::Chat) {
            assert_eq!(body["messages"][0]["content"], blocks);
        } else {
            assert_eq!(
                body["input"][0]["content"],
                json!([{"type":"input_image","image_url":url,"detail":"low"}])
            );
        }
    }
}

#[tokio::test]
async fn validation_preserves_anthropic_url_sources() {
    let block =
        json!({"type":"image", "source":{"type":"url","url":"https://example.com/marker.png"}});
    let (body, result) = capture(Route::Anthropic, request(json!([block])), false).await;
    assert!(result.is_ok());
    assert_eq!(body["messages"][0]["content"][0]["source"], block["source"]);
}

#[tokio::test]
async fn tool_images_reach_final_requests_and_stay_associated_with_their_call() {
    let red = image(fixtures::RED_BLUE);
    let green = image(fixtures::GREEN_WHITE);
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        let mut req = request(json!("Inspect both files"));
        let content = json!([
            {"type":"text","text":"first marker"}, red,
            {"type":"text","text":"second marker"}, green
        ]);
        req.messages.extend([
            json!({"role":"assistant","tool_calls":[
                {"id":"call_image","type":"function","function":{"name":"read","arguments":"{}"}},
                {"id":"call_text","type":"function","function":{"name":"read","arguments":"{}"}}
            ]}),
            json!({"role":"tool","name":"read","tool_call_id":"call_image","content":content}),
            json!({"role":"tool","name":"read","tool_call_id":"call_text","content":"plain result"}),
            json!({"role":"user","content":"Now compare them"}),
        ]);
        let (body, result) = capture(route, req, false).await;
        assert!(result.is_ok(), "{route:?}: {result:?}");
        let serialized = body.to_string();
        for data in [&red["source"]["data"], &green["source"]["data"]] {
            assert_eq!(
                serialized.matches(data.as_str().unwrap()).count(),
                1,
                "{route:?}"
            );
        }
        match route {
            Route::OAuth => {
                assert_eq!(body["input"][3]["call_id"], "call_image");
                assert_eq!(body["input"][3]["output"][1]["type"], "input_image");
                assert_eq!(body["input"][3]["output"][3]["type"], "input_image");
            }
            Route::Anthropic => assert_eq!(body["messages"][2]["content"][0]["content"], content),
            Route::Chat => {
                assert_eq!(body["messages"][2]["role"], "tool");
                assert_eq!(body["messages"][3]["tool_call_id"], "call_text");
                assert_eq!(body["messages"][4]["role"], "user");
                assert!(
                    body["messages"][4]["content"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("call_image")
                );
                assert_eq!(body["messages"][4]["content"][2]["type"], "image_url");
                assert_eq!(body["messages"][5]["content"], "Now compare them");
            }
            Route::Google => {
                assert_eq!(
                    body["contents"][3]["parts"][0]["functionResponse"]["response"]["content"],
                    "plain result"
                );
                assert!(
                    body["contents"][4]["parts"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("call_image")
                );
                assert_eq!(
                    body["contents"][4]["parts"][2]["inlineData"]["data"],
                    red["source"]["data"]
                );
            }
        }
    }
}

#[tokio::test]
async fn unsupported_model_errors_are_reported_without_a_text_only_retry() {
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        let (_, result) = capture(route, request(json!([image(fixtures::RED_BLUE)])), true).await;
        let error = result.unwrap_err();
        assert!(
            error.contains("Select an image-capable model"),
            "{route:?}: {error}"
        );
    }
}

#[tokio::test]
async fn text_followup_keeps_the_original_image_in_the_first_user_message() {
    let blocks = vec![image(fixtures::RED_BLUE)];
    for route in [Route::Chat, Route::OAuth, Route::Anthropic, Route::Google] {
        let mut input = request(json!(blocks));
        input
            .messages
            .push(json!({"role":"assistant","content":"What should I inspect?"}));
        input
            .messages
            .push(json!({"role":"user","content":"Describe the picture I sent."}));
        let (body, result) = capture(route, input, false).await;
        assert!(result.is_ok(), "{route:?}: {result:?}");
        let mut actual = match route {
            Route::OAuth => body["input"][0]["content"].clone(),
            Route::Google => body["contents"][0]["parts"].clone(),
            _ => body["messages"][0]["content"].clone(),
        };
        if matches!(route, Route::Anthropic) {
            for block in actual.as_array_mut().unwrap() {
                block.as_object_mut().unwrap().remove("cache_control");
            }
        }
        assert_eq!(actual, expected_blocks(route, &blocks), "{route:?}");
        assert!(body.to_string().contains("Describe the picture I sent."));
    }
}
