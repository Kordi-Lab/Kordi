// Issue 1808: a group turn on the Mac's OMP path must offer the document
// tools its cloud lease carries, and run them through the lease.
fn document_lease_tool(
    name: &str,
    group: kordi_tools::connector_tools::ConnectorToolGroup,
) -> kordi_tools::connector_tools::ConnectorToolDescriptor {
    kordi_tools::connector_tools::ConnectorToolDescriptor {
        connector_id: "kordi-documents".into(),
        provider: kordi_tools::connector_tools::DOCUMENT_TOOLS_PROVIDER.into(),
        name: name.into(),
        group,
        description: format!("{name} for the group"),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": { "title": { "type": "string" }, "content": { "type": "string" } },
            "required": ["title", "content"]
        }),
    }
}

/// Serves one tool call to `create_document`, then a text answer, and
/// records every provider request.
async fn synthetic_create_document_provider(
) -> Result<(String, std::sync::Arc<Mutex<Vec<serde_json::Value>>>, tokio::task::JoinHandle<Result<()>>)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}/v1", listener.local_addr()?);
    let requests = std::sync::Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured = requests.clone();
    let server = tokio::spawn(async move {
        let mut sequence = 0usize;
        loop {
            let (mut socket, _) = listener.accept().await?;
            let mut buffer = Vec::new();
            let header_end = loop {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await?;
                anyhow::ensure!(read > 0, "synthetic request ended early");
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let header = std::str::from_utf8(&buffer[..header_end])?.to_ascii_lowercase();
            let length = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while buffer.len() - header_end < length {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await?;
                anyhow::ensure!(read > 0, "synthetic request body ended early");
                buffer.extend_from_slice(&chunk[..read]);
            }
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_slice(&buffer[header_end..header_end + length])?);
            sequence += 1;
            let choices = if sequence == 1 {
                vec![
                    serde_json::json!([{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"create-call","type":"function","function":{"name":"create_document","arguments":"{\"title\":\"Launch plan\",\"content\":\"# Launch plan\"}"}}]},"finish_reason":null}]),
                    serde_json::json!([{"index":0,"delta":{},"finish_reason":"tool_calls"}]),
                ]
            } else {
                vec![
                    serde_json::json!([{"index":0,"delta":{"role":"assistant","content":"Saved."},"finish_reason":null}]),
                    serde_json::json!([{"index":0,"delta":{},"finish_reason":"stop"}]),
                ]
            };
            let data = choices
                .into_iter()
                .map(|choices| format!("data: {}\n\n", serde_json::json!({"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":choices})))
                .collect::<String>()
                + "data: [DONE]\n\n";
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{data}",
                data.len()
            );
            socket.write_all(reply.as_bytes()).await?;
        }
    });
    Ok((origin, requests, server))
}

#[tokio::test]
async fn omp_group_turn_offers_and_runs_the_leases_create_document() -> Result<()> {
    // Safety, and YOLO, where OMP also admits the owner's computer tools.
    for policy in [kordi_tools::ExecutionPolicy::Safety, kordi_tools::ExecutionPolicy::Yolo] {
        omp_group_turn_with_policy(policy).await?;
    }
    Ok(())
}

#[allow(clippy::await_holding_lock, reason = "serializes test-only environment changes")]
async fn omp_group_turn_with_policy(policy: kordi_tools::ExecutionPolicy) -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let cwd = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _engine = EnvVarGuard::unset("KORDI_DESKTOP_TURN_ENGINE");
    let _generic_engine = EnvVarGuard::unset("KORDI_AGENT_ENGINE");
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "synthetic-bootstrap-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-5.5".into()),
        ..Settings::default()
    }
    .save_global()?;
    let (origin, requests, server) = synthetic_create_document_provider().await?;

    let mut runtime = DesktopRuntimeSession::create_with_id(
        cwd.path().to_path_buf(),
        "cloud-agent:acct_owner:session:group:synthetic:request:msg_1",
    )
    .await?;
    runtime.setup.tool_ctx.execution_policy = policy;
    runtime.apply_turn_hosted_model("fixture-provider/fixture-model")?;
    runtime.set_ephemeral_provider_auth_with_options(
        "fixture-provider",
        crate::login::ResolvedProviderAuth {
            source: crate::login::AuthSource::KordiAuth,
            credential_provider: "fixture-provider".into(),
            method: crate::login::ProviderAuthMethod::ApiKey,
            credential: "synthetic-test-key".into(),
            account_id: Some("synthetic-account".into()),
            account_label: None,
            authority: None,
        },
        Some(origin),
        Some("openai-completions"),
    )?;
    let calls = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = calls.clone();
    use kordi_tools::connector_tools::{ConnectorToolGroup, ConnectorToolsRuntime, CREATE_DOCUMENT_TOOL};
    runtime.set_connector_tools_runtime(Some(ConnectorToolsRuntime {
        descriptors: vec![
            document_lease_tool("read_document", ConnectorToolGroup::Read),
            document_lease_tool(CREATE_DOCUMENT_TOOL, ConnectorToolGroup::Act),
        ],
        call: std::sync::Arc::new(move |descriptor, args| {
            recorded.lock().unwrap().push(format!("{}:{args}", descriptor.name));
            Box::pin(async { Ok(serde_json::json!({ "created": true })) })
        }),
        report_declined: None,
        offer_request_connect: false,
    }));
    runtime
        .send_message_streaming(
            "Create a doc with the launch plan.".into(),
            vec![],
            tokio_util::sync::CancellationToken::new(),
            |_| {},
        )
        .await?;
    server.abort();

    let captured = requests.lock().unwrap();
    let offered: Vec<String> = captured[0]["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    assert!(
        offered.iter().any(|name| name == CREATE_DOCUMENT_TOOL),
        "create_document missing from the model's tools under {policy:?}: {offered:?}"
    );
    assert!(offered.iter().any(|name| name == "read_document"), "{offered:?}");
    assert_eq!(
        *calls.lock().unwrap(),
        [format!("{CREATE_DOCUMENT_TOOL}:{{\"content\":\"# Launch plan\",\"title\":\"Launch plan\"}}")]
    );
    Ok(())
}
