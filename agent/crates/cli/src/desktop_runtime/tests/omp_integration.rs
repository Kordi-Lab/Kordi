#[allow(
    clippy::await_holding_lock,
    reason = "serializes test-only environment changes"
)]
#[tokio::test]
async fn omp_desktop_turn_uses_real_worker_host_tool_and_persisted_history() -> Result<()> {
    omp_real_worker_fixture(false).await
}

#[tokio::test]
async fn omp_desktop_turn_transfers_registered_plugin_tools_and_hooks() -> Result<()> {
    omp_real_worker_fixture(true).await
}

#[allow(clippy::await_holding_lock, reason = "serializes test-only environment changes")]
async fn omp_real_worker_fixture(plugin: bool) -> Result<()> {
    use anyhow::Context;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let cwd = tempfile::tempdir()?;
    std::fs::write(cwd.path().join("sample.txt"), "synthetic tool output")?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _engine = EnvVarGuard::unset("KORDI_DESKTOP_TURN_ENGINE");
    let _generic_engine = EnvVarGuard::unset("KORDI_AGENT_ENGINE");
    let plugin_path = cwd.path().join("probe.js");
    if plugin {
        std::fs::write(&plugin_path, r#"module.exports = kordi => {
          kordi.registerTool({ name: 'probe', description: 'Synthetic probe', parameters: {type:'object',properties:{path:{type:'string'}}},
            execute: async (id, input) => ({content:[{type:'text',text:`${id}:${input.path}`} ]}) });
          kordi.on('tool_call', event => event.tool_name === 'probe' ? {input:{path:'modified-by-plugin'}} : undefined);
          kordi.on('tool_result', event => event.tool_name === 'probe' ? {content:[{type:'text',text:'synthetic tool output: plugin result:' + event.content[0].text}]} : undefined);
          kordi.on('before_agent_start', () => ({system_prompt:'OMP plugin system instruction'}));
          kordi.on('context', event => ({messages:[...event.messages,{role:'user',content:[{type:'text',text:'OMP plugin context instruction'}],timestamp:0}]}));
          kordi.on('before_provider_request', event => ({payload:{...event.payload,temperature:0.125}}));
        };"#)?;
    }
    let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "synthetic-bootstrap-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-5.5".into()),
        extensions: if plugin { vec![plugin_path.display().to_string()] } else { vec![] },
        ..Settings::default()
    }
    .save_global()?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}/v1", listener.local_addr()?);
    let requests = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    let captured = requests.clone();
    let server = tokio::spawn(async move {
        let mut sequence = 0usize;
        loop {
            let (mut socket, _) = listener.accept().await?;
            let mut buffer = Vec::new();
            let header_end;
            loop {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await?;
                if read == 0 {
                    anyhow::bail!("synthetic request ended early");
                }
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
                    header_end = end + 4;
                    break;
                }
            }
            let header = std::str::from_utf8(&buffer[..header_end])?;
            let content_length = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while buffer.len() - header_end < content_length {
                let mut chunk = [0u8; 4096];
                let read = socket.read(&mut chunk).await?;
                if read == 0 {
                    anyhow::bail!("synthetic request body ended early");
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&buffer[header_end..header_end + content_length])?;
            captured.lock().unwrap().push(body);
            sequence += 1;
            let tool_first = sequence == 1;
            let chunks = if tool_first {
                vec![
                    serde_json::json!({"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"synthetic-call","type":"function","function":{"name":if plugin {"probe"} else {"read"},"arguments":"{\"path\":\"sample.txt\"}"}}]},"finish_reason":null}]}),
                    serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
                ]
            } else {
                let text = if sequence == 2 {
                    "First answer."
                } else {
                    "Second answer."
                };
                vec![
                    serde_json::json!({"choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]}),
                    serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}),
                ]
            };
            let data = chunks.into_iter().map(|chunk| format!("data: {}\n\n", serde_json::json!({"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":chunk["choices"],"usage":chunk.get("usage")}))).collect::<String>() + "data: [DONE]\n\n";
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{data}",
                data.len()
            );
            socket.write_all(reply.as_bytes()).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    });

    let mut runtime =
        DesktopRuntimeSession::create_with_id(cwd.path().to_path_buf(), "session:omp:synthetic")
            .await?;
    runtime.set_hosted_model("fixture-provider/fixture-model")?;
    let auth = crate::login::ResolvedProviderAuth {
        source: crate::login::AuthSource::KordiAuth,
        credential_provider: "fixture-provider".into(),
        method: crate::login::ProviderAuthMethod::ApiKey,
        credential: "synthetic-test-key".into(),
        account_id: Some("synthetic-account".into()),
        account_label: None,
        authority: None,
    };
    runtime.set_ephemeral_provider_auth_with_options(
        "fixture-provider",
        auth.clone(),
        Some(origin.clone()),
        Some("openai-completions"),
    )?;
    let mut events = Vec::new();
    runtime
        .send_message_streaming(
            "Read sample.txt and answer.".into(),
            vec![],
            tokio_util::sync::CancellationToken::new(),
            |event| events.push(event.clone()),
        )
        .await?;
    assert!(events.iter().any(|event| matches!(event, crate::turn_runner::TurnEvent::ToolResult { id, .. } if id == "synthetic-call")), "events: {events:?}; tool wire: {:?}", requests.lock().unwrap().get(1).and_then(|request| request["messages"].as_array()).and_then(|messages| messages.iter().find(|message| message["role"] == "tool")).cloned());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, crate::turn_runner::TurnEvent::TextDelta(_)))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        crate::turn_runner::TurnEvent::TurnStart { turn_index: 0 }
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, crate::turn_runner::TurnEvent::TurnEnd))
    );

    let messages = load_session_messages(&runtime.setup.conn, &runtime.setup.session_id)?;
    assert_eq!(messages.len(), 2, "a tool-using OMP reply stays one turn");
    let reply = &messages[1];
    assert_eq!(reply.text, "First answer.");
    assert!(!reply.failed);
    assert_eq!(reply.tools.len(), 1);
    assert_eq!(reply.tools[0].id, "synthetic-call");
    assert_eq!(reply.tools[0].status, "done");
    assert!(
        reply.tools[0]
            .result_text
            .as_deref()
            .unwrap_or_default()
            .contains("synthetic tool output")
    );

    // Simulate a provider replay signature on the raw OMP sidecar. The visible
    // Kordi assistant schema omits this field, but the next OMP context keeps it.
    let (assistant_id, route_scope, mut raw) =
        kordi_session::tree::active_path(&runtime.setup.conn, &runtime.setup.session_id)?
            .iter()
            .rev()
            .filter_map(|row| kordi_session::store::parse_entry(row).ok())
            .find_map(|entry| match entry {
                kordi_core::types::SessionEntry::Custom {
                    custom_type,
                    data: Some(data),
                    ..
                } if custom_type == "omp_message" && data["message"]["role"] == "assistant" => {
                    Some((
                        data["entryId"].as_str()?.to_string(),
                        data["routeScope"].as_str()?.to_string(),
                        data["message"].clone(),
                    ))
                }
                _ => None,
            })
            .context("OMP assistant sidecar missing")?;
    raw["content"][0]["textSignature"] = serde_json::json!("synthetic-signature");
    kordi_session::store::append_entry(
        &runtime.setup.conn,
        &runtime.setup.session_id,
        &kordi_core::types::SessionEntry::Custom {
            base: kordi_core::types::EntryBase {
                id: kordi_core::types::EntryId::generate(),
                parent_id: crate::turn_runner::get_leaf_raw(
                    &runtime.setup.conn,
                    &runtime.setup.session_id,
                ),
                timestamp: chrono::Utc::now(),
            },
            custom_type: "omp_message".into(),
            data: Some(
                serde_json::json!({"entryId":assistant_id,"routeScope":route_scope,"message":raw}),
            ),
        },
    )?;
    runtime.set_ephemeral_provider_auth_with_options(
        "fixture-provider",
        auth,
        Some(origin),
        Some("openai-completions"),
    )?;
    runtime
        .send_message_streaming(
            "Continue.".into(),
            vec![],
            tokio_util::sync::CancellationToken::new(),
            |_| {},
        )
        .await?;
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 3);
    if plugin {
        assert!(captured.iter().all(|request| request["temperature"] == 0.125));
        assert!(captured.iter().all(|request| request.to_string().contains("OMP plugin system instruction")));
        assert!(captured.iter().all(|request| request.to_string().contains("OMP plugin context instruction")));
        assert!(captured[0]["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "probe"));
        assert!(captured[1].to_string().contains("synthetic tool output: plugin result:synthetic-call:modified-by-plugin"));
    }
    let second = captured[2].to_string();
    assert!(second.contains("First answer."));
    assert!(second.contains("synthetic tool output"));
    let count: i64 = runtime.setup.conn.query_row(
        "SELECT count(*) FROM entries WHERE session_id=?1 AND type='message' AND json_extract(payload,'$.message.role')='user'",
        [&runtime.setup.session_id], |row| row.get(0),
    )?;
    assert_eq!(count, 2);
    let messages = load_session_messages(&runtime.setup.conn, &runtime.setup.session_id)?;
    assert_eq!(messages.len(), 4, "reloading retains one reply per request");
    assert_eq!(messages[1].text, "First answer.");
    assert_eq!(messages[1].tools.len(), 1);
    assert_eq!(messages[3].text, "Second answer.");
    assert!(messages.iter().all(|message| !message.failed));
    server.abort();
    Ok(())
}
