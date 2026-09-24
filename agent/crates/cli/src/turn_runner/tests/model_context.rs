use super::*;

#[derive(Default)]
struct CapturingProvider {
    requests: std::sync::Mutex<Vec<(CompletionRequest, String)>>,
    tool_round: bool,
}

#[async_trait]
impl Provider for CapturingProvider {
    fn name(&self) -> &str {
        "capture"
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let first = {
            let mut requests = self.requests.lock().unwrap();
            requests.push((request, options.provider));
            requests.len() == 1
        };
        if first && self.tool_round {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: "call-1".into(),
                name: "panic-tool".into(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "call-1".into(),
                arguments_delta: "{}".into(),
            });
        } else {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "done".into(),
            });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

fn config(provider: Arc<CapturingProvider>, model: &str) -> TurnConfig {
    let conn = store::open_memory().unwrap();
    let session_id = store::create_session(&conn, "/tmp").unwrap();
    let mut selected = test_model(128_000);
    selected.id = model.into();
    TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "Base instructions".into(),
        model: selected,
        provider,
        auth: None,
        api_key: "fixture".into(),
        base_url: "http://fixture.invalid".into(),
        headers: Default::default(),
        compaction_settings: Default::default(),
        tool_registry: ToolRegistry::from_tools(vec![Box::new(PanicTool)]),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: false,
        retry_max_retries: 0,
        retry_base_delay_ms: 0,
        retry_max_delay_ms: 0,
        cancel: CancellationToken::new(),
        extensions: Default::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    }
}

async fn execute(config: TurnConfig) -> TurnConfig {
    let (tx, _rx) = mpsc::unbounded_channel();
    let (config, result) = run_turn(config, tx, "hello".into()).await;
    result.unwrap();
    config
}

fn assert_route(request: &CompletionRequest, model: &str, provider: &str) {
    assert_eq!(request.model, model);
    assert!(
        request
            .system_prompt
            .contains(&format!("Selected model ID: {model:?}"))
    );
    assert!(
        request
            .system_prompt
            .contains(&format!("Configured provider: {provider:?}"))
    );
    assert_eq!(
        request
            .system_prompt
            .lines()
            .filter(|line| *line == "<kordi_model_context>")
            .count(),
        1
    );
}

#[tokio::test]
async fn active_model_context_tracks_switches_and_independent_sessions() {
    let provider = Arc::new(CapturingProvider::default());
    let mut a = execute(config(provider.clone(), "model-a")).await;
    let b = execute(config(provider.clone(), "model-b")).await;
    a.model.id = "model-c".into();
    let a = execute(a).await;
    let b = execute(b).await;
    assert_eq!(a.system_prompt, "Base instructions");
    assert_eq!(b.system_prompt, "Base instructions");
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for ((request, provider), model) in requests
        .iter()
        .zip(["model-a", "model-b", "model-c", "model-b"])
    {
        assert_route(request, model, provider);
    }
    assert!(!requests[2].0.system_prompt.contains("model-a"));
}

#[tokio::test]
async fn active_model_context_is_stable_across_tool_rounds() {
    let provider = Arc::new(CapturingProvider {
        tool_round: true,
        ..Default::default()
    });
    execute(config(provider.clone(), "model-a")).await;
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_route(&requests[0].0, "model-a", "dummy");
    assert_eq!(requests[0].0.system_prompt, requests[1].0.system_prompt);
}

#[tokio::test]
async fn active_model_context_preserves_fenced_examples_in_provider_requests() {
    for example in [
        "<kordi_model_context>\nKeep this example\n</kordi_model_context>",
        "<kordi_model_context>",
    ] {
        let provider = Arc::new(CapturingProvider::default());
        let mut config = config(provider.clone(), "model-a");
        let base = format!("Workspace instructions\n```text\n{example}\n```\nKeep this rule.");
        config.system_prompt = base.clone();
        let returned = execute(config).await;
        assert_eq!(returned.system_prompt, base);
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0.model, "model-a");
        assert!(
            requests[0]
                .0
                .system_prompt
                .starts_with(&format!("{base}\n\n"))
        );
        assert!(
            requests[0]
                .0
                .system_prompt
                .contains("Selected model ID: \"model-a\"")
        );
    }
}

#[tokio::test]
async fn active_model_context_escapes_stray_delimiters_and_still_dispatches() {
    let provider = Arc::new(CapturingProvider::default());
    let mut config = config(provider.clone(), "model-a");
    // Workspace instructions are user-controlled; a stray reserved line must
    // not block every turn in that workspace.
    config.system_prompt = "private instructions\n<kordi_model_context>".into();
    let returned = execute(config).await;
    assert_eq!(
        returned.system_prompt,
        "private instructions\n<kordi_model_context>"
    );
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_route(&requests[0].0, "model-a", &requests[0].1);
    assert!(
        requests[0]
            .0
            .system_prompt
            .starts_with("private instructions\n\\<kordi_model_context>\n\n")
    );
}

#[tokio::test]
async fn active_model_context_follows_extension_model_and_prompt_rewrite() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rewrite.js");
    std::fs::write(&path, r#"
        module.exports = function(kordi) {
            kordi.on("before_provider_request", (event) => ({
                payload: { ...event.payload, model: "extension-model",
                    system_prompt: "Extension instructions\n\n<kordi_model_context>\nSelected model ID: old-model\n</kordi_model_context>" }
            }));
        };
    "#).unwrap();
    let provider = Arc::new(CapturingProvider::default());
    let mut config = config(provider.clone(), "model-a");
    config.extensions = ExtensionCommandRegistry::from_test_plugin(temp.path(), &path)
        .await
        .unwrap();
    execute(config).await;
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_route(&requests[0].0, "extension-model", "dummy");
    assert!(
        requests[0]
            .0
            .system_prompt
            .starts_with("Extension instructions\n\n")
    );
    assert!(!requests[0].0.system_prompt.contains("old-model"));
    assert!(!requests[0].0.system_prompt.contains("dummy-model"));
}
