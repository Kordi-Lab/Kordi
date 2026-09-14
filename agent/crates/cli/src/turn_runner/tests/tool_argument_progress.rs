use super::*;

struct WhitespaceLoopProvider {
    calls: AtomicUsize,
    dropped: Arc<std::sync::atomic::AtomicBool>,
}

struct StreamDrop(Arc<std::sync::atomic::AtomicBool>);
impl Drop for StreamDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl Provider for WhitespaceLoopProvider {
    fn name(&self) -> &str {
        "synthetic"
    }
    async fn complete(
        &self,
        _: CompletionRequest,
        _: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        Ok(vec![])
    }
    async fn stream(
        &self,
        _: CompletionRequest,
        _: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _drop = StreamDrop(self.dropped.clone());
        let _ = tx.send(StreamEvent::ToolCallStart {
            id: "looping-call".into(),
            name: "bash".into(),
        });
        let _ = tx.send(StreamEvent::ToolCallDelta {
            id: "looping-call".into(),
            arguments_delta: "{".into(),
        });
        for _ in 0..9 {
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: "looping-call".into(),
                arguments_delta: " ".repeat(1024),
            });
            tokio::task::yield_now().await;
        }
        std::future::pending::<()>().await;
        Ok(())
    }
}

#[tokio::test]
async fn runaway_tool_argument_stream_stops_without_waiting_for_provider_or_executing_tool() {
    let conn = store::open_memory().unwrap();
    let session_id = store::create_session(&conn, "/tmp").unwrap();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let provider = Arc::new(WhitespaceLoopProvider {
        calls: AtomicUsize::new(0),
        dropped: dropped.clone(),
    });
    let config = TurnConfig {
        conn: wrap_conn(conn),
        session_id,
        system_prompt: "system".into(),
        model: test_model(128_000),
        provider: provider.clone(),
        auth: None,
        api_key: "synthetic".into(),
        base_url: "http://dummy.invalid".into(),
        headers: Default::default(),
        compaction_settings: Default::default(),
        tool_registry: ToolRegistry::default(),
        tool_ctx: test_tool_context(),
        thinking: None,
        retry_enabled: true,
        retry_max_retries: 2,
        retry_base_delay_ms: 1,
        retry_max_delay_ms: 10,
        cancel: CancellationToken::new(),
        extensions: ExtensionCommandRegistry::default(),
        request_metrics_tracker: test_request_metrics_tracker(),
        request_metrics_log_path: None,
    };
    let (_, result) = timeout(
        Duration::from_secs(2),
        run_turn(config, event_tx, "Synthetic request".into()),
    )
    .await
    .expect("the whitespace loop must stop without waiting for provider completion");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("empty tool arguments")
    );
    tokio::task::yield_now().await;
    assert!(
        dropped.load(Ordering::SeqCst),
        "provider task must be aborted"
    );
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        1,
        "do not replay a partially visible tool request"
    );
    let mut error_visible = false;
    let mut tool_visible = false;
    while let Ok(event) = event_rx.try_recv() {
        match event {
            TurnEvent::Error(message) => error_visible |= message.contains("empty tool arguments"),
            TurnEvent::ToolCallStart { .. } => tool_visible = true,
            TurnEvent::ToolExecuting { .. } => {
                panic!("malformed arguments must never execute")
            }
            _ => {}
        }
    }
    assert!(
        tool_visible && error_visible,
        "preserve the trace and explain the stopped generation"
    );
}
