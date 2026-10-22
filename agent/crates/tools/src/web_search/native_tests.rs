use super::*;
use kordi_provider::{
    Provider,
    registry::{ApiType, CostConfig, Model},
};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

struct MockProvider {
    calls: Mutex<Vec<(CompletionRequest, RequestOptions)>>,
    events: Vec<StreamEvent>,
    wait: bool,
}
#[async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &str {
        "openai"
    }
    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let cancel = options.cancel.clone();
        self.calls.lock().unwrap().push((request, options));
        if self.wait {
            cancel.cancelled().await;
        }
        for event in &self.events {
            let _ = tx.send(event.clone());
        }
        Ok(())
    }
}
fn fixture() -> (WebSearchRuntime, Arc<MockProvider>, WebSearchInput) {
    let provider = Arc::new(MockProvider {
        calls: Mutex::new(vec![]),
        wait: false,
        events: vec![
            StreamEvent::TextDelta {
                text: "Synthetic summary".into(),
            },
            StreamEvent::ServerToolResult {
                tool_use_id: "search".into(),
                name: "web_search".into(),
                is_error: false,
                result: json!({"sources":[{"url":"https://example.com/source","title":"Source"},
                    {"url":"https://example.com/source"},{"url":"javascript:alert(1)"}]}),
            },
            StreamEvent::Done,
        ],
    });
    let runtime = WebSearchRuntime {
        provider: provider.clone(),
        model: Model {
            id: "gpt-5.5".into(),
            name: "Synthetic".into(),
            provider: "openai".into(),
            api: ApiType::OpenaiResponses,
            context_window: 10000,
            max_tokens: 4096,
            reasoning: true,
            input: vec![],
            base_url: None,
            cost: CostConfig::default(),
        },
        api_key: "synthetic-token".into(),
        auth_mode: ProviderAuthMode::OAuth,
        auth_account_id: Some("synthetic-account".into()),
        base_url: "https://example.com/backend-api".into(),
        headers: HashMap::from([("x-test".into(), "selected".into())]),
        enabled: true,
    };
    (
        runtime,
        provider,
        WebSearchInput {
            query: "synthetic query".into(),
            allowed_domains: None,
            blocked_domains: None,
        },
    )
}

#[tokio::test]
async fn native_precedes_fallback_and_keeps_selected_route_and_sources() {
    let (runtime, provider, input) = fixture();
    let ctx = ToolContext {
        web_search: Some(runtime),
        ..Default::default()
    };
    let result = WebSearchTool
        .execute(
            serde_json::to_value(&input).unwrap(),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let details = result.details.unwrap();
    assert_eq!(details["backend"], "provider-native");
    assert_eq!(
        details["results"][1]["content"].as_array().unwrap().len(),
        1
    );
    let calls = provider.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (request, options) = &calls[0];
    assert_eq!(request.model, "gpt-5.5");
    assert_eq!(request.messages.len(), 1);
    assert_eq!(options.api_key, "synthetic-token");
    assert_eq!(
        options.auth_account_id.as_deref(),
        Some("synthetic-account")
    );
    assert_eq!(options.base_url, "https://example.com/backend-api");
    assert_eq!(options.headers["x-test"], "selected");
    assert_eq!(options.max_retries, 0);
}

#[test]
fn unsupported_routes_and_filters_use_fallback_without_switching_models() {
    let (mut runtime, _, mut input) = fixture();
    assert!(supports(&runtime, &input));
    input.blocked_domains = Some(vec!["example.com".into()]);
    assert!(!supports(&runtime, &input));
    runtime.model.provider = "anthropic".into();
    assert!(supports(&runtime, &input));
    assert_eq!(
        request(&runtime, &input).tools[0]["function"]["search_options"]["blocked_domains"],
        json!(["example.com"])
    );
    runtime.model.provider = "google".into();
    assert!(!supports(&runtime, &input));
    input.blocked_domains = None;
    runtime.auth_mode = ProviderAuthMode::ApiKey;
    assert!(supports(&runtime, &input));
    runtime.model.provider = "custom".into();
    assert!(!supports(&runtime, &input));
    runtime.model.provider = "openai".into();
    assert!(!supports(&runtime, &input)); // API key on an unknown endpoint
    runtime.enabled = false;
    assert!(!supports(&runtime, &input));
}

#[test]
fn ungrounded_text_and_stream_errors_are_not_search_successes() {
    let (_, _, input) = fixture();
    assert!(
        collect(
            vec![StreamEvent::TextDelta {
                text: "Answer from memory".into()
            }],
            &input,
            Instant::now()
        )
        .is_err()
    );
    let error = collect(
        vec![StreamEvent::ServerToolResult {
            tool_use_id: "s".into(),
            name: "web_search".into(),
            is_error: true,
            result: json!({"secret":"never print this"}),
        }],
        &input,
        Instant::now(),
    )
    .unwrap_err();
    assert!(!error.to_string().contains("never print"));
}

#[tokio::test]
async fn cancellation_interrupts_native_search() {
    let (mut runtime, _, input) = fixture();
    let provider = Arc::new(MockProvider {
        calls: Mutex::new(vec![]),
        events: vec![],
        wait: true,
    });
    runtime.provider = provider.clone();
    let cancel = CancellationToken::new();
    let cancel_task = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel_task.cancel();
    });
    let error = tokio::time::timeout(
        Duration::from_secs(1),
        search(&runtime, &input, cancel, Instant::now()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(provider.calls.lock().unwrap()[0].1.cancel.is_cancelled());
}

#[tokio::test]
async fn native_failures_are_reported_without_a_fallback_request() {
    let (mut runtime, _, input) = fixture();
    let provider = Arc::new(MockProvider {
        calls: Mutex::new(vec![]),
        wait: false,
        events: vec![StreamEvent::ServerToolResult {
            tool_use_id: "search".into(),
            name: "web_search".into(),
            is_error: true,
            result: json!({"error": "synthetic secret"}),
        }],
    });
    runtime.provider = provider.clone();
    let ctx = ToolContext {
        web_search: Some(runtime),
        ..Default::default()
    };
    let error = WebSearchTool
        .execute(
            serde_json::to_value(input).unwrap(),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Native web search failed"));
    assert!(!error.to_string().contains("synthetic secret"));
    assert_eq!(provider.calls.lock().unwrap().len(), 1);
}
