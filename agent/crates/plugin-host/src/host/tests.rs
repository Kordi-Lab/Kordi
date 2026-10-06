use super::*;

#[tokio::test]
async fn plugin_context_and_tool_input_changes_chain_between_handlers() {
    let directory = tempfile::tempdir().unwrap();
    let plugin = directory.path().join("chain.js");
    std::fs::write(&plugin, r#"
      module.exports = kordi => {
        kordi.on('context', event => ({ messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: 'first hook' }], timestamp: 1 }] }));
        kordi.on('context', event => {
          if (event.messages.length !== 2) throw Error('previous context missing');
          return { messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: 'second hook' }], timestamp: 2 }] };
        });
        kordi.on('tool_call', event => ({ input: { ...event.input, first: true } }));
        kordi.on('tool_call', event => {
          if (!event.input.first) throw Error('previous input missing');
          return { input: { ...event.input, second: true } };
        });
        kordi.on('before_provider_request', event => ({ payload: { ...event.payload, temperature: 0.125 } }));
        kordi.on('before_provider_request', event => {
          if (event.payload.temperature !== 0.125) throw Error('previous payload missing');
          return { payload: { ...event.payload, top_p: 0.9 } };
        });
      };
    "#).unwrap();
    let mut host = PluginHost::load_plugins(&[plugin]).await.unwrap();
    let message = serde_json::from_value(serde_json::json!({"role":"user","content":[{"type":"text","text":"request"}],"timestamp":0})).unwrap();
    let context = host
        .send_event(&kordi_hooks::Event::Context(
            kordi_hooks::events::ContextEvent::new(vec![message]),
        ))
        .await
        .unwrap();
    assert_eq!(context.messages.unwrap().len(), 3);
    let input = host
        .send_event(&kordi_hooks::Event::ToolCall(
            kordi_hooks::ToolCallEvent::new("call", "probe", serde_json::json!({"original":true})),
        ))
        .await
        .unwrap();
    assert_eq!(
        input.input.unwrap(),
        serde_json::json!({"original":true,"first":true,"second":true})
    );
    let request = host
        .send_event(&kordi_hooks::Event::BeforeProviderRequest {
            payload: serde_json::json!({"model":"fixture"}),
        })
        .await
        .unwrap();
    assert_eq!(
        request.payload.unwrap(),
        serde_json::json!({"model":"fixture","temperature":0.125,"top_p":0.9})
    );
    drop(host);
    directory.close().unwrap();
}

#[tokio::test]
async fn test_load_plugins_with_sample() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("Skipping test: node not available");
        return;
    }

    let temp_dir = std::env::temp_dir().join("kordi-test-plugins");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let plugin_path = temp_dir.join("test-plugin.js");
    std::fs::write(
        &plugin_path,
        r#"
            module.exports = function(kordi) {
                kordi.on("session_start", (event, ctx) => {
                    return { action: "started" };
                });

                kordi.on("tool_call", (event, ctx) => {
                    if (event.tool_name === "bash" && event.input.command && event.input.command.includes("rm -rf /")) {
                        return { block: true, reason: "Blocked dangerous command" };
                    }
                });

                kordi.registerTool({
                    name: "greet",
                    description: "Greet someone",
                    parameters: { type: "object", properties: { name: { type: "string" } } },
                    execute: async (toolCallId, params) => {
                        return { content: [{ type: "text", text: "Hello, " + (params.name || "world") + "!" }] };
                    },
                });

                kordi.registerCommand("hello", {
                    description: "Say hello",
                    handler: async (args, ctx) => ({
                        message: "Hello command " + (args || "world")
                            + " @ " + ctx.cwd
                            + " ui=" + ctx.hasUI
                            + " entries=" + ctx.sessionManager.getEntries().length
                            + " leaf=" + ctx.sessionManager.getLeafId()
                            + " label=" + ctx.sessionManager.getLabel("root")
                    })
                });
            };
        "#,
    )
    .unwrap();

    let mut host = PluginHost::load_plugins(std::slice::from_ref(&plugin_path))
        .await
        .unwrap();

    assert_eq!(host.plugin_count(), 1);
    assert_eq!(host.registered_tools().len(), 1);
    assert_eq!(host.registered_tools()[0].name(), "greet");
    assert_eq!(host.registered_commands().len(), 1);
    assert_eq!(host.registered_commands()[0].name(), "hello");

    let result = host.send_event(&kordi_hooks::Event::SessionStart).await;
    assert!(result.is_some());
    let hr = result.unwrap();
    assert_eq!(hr.action, Some("started".into()));

    let result = host
        .send_event(&kordi_hooks::Event::ToolCall(
            kordi_hooks::ToolCallEvent::new(
                "tc1",
                "bash",
                serde_json::json!({"command": "rm -rf /"}),
            ),
        ))
        .await;
    assert!(result.is_some());
    let hr = result.unwrap();
    assert_eq!(hr.block, Some(true));
    assert_eq!(hr.reason, Some("Blocked dangerous command".into()));

    let result = host
        .send_event(&kordi_hooks::Event::ToolCall(
            kordi_hooks::ToolCallEvent::new("tc2", "bash", serde_json::json!({"command": "ls"})),
        ))
        .await;
    assert!(result.is_none());

    let result = host
        .execute_tool("greet", "call1", serde_json::json!({"name": "Alice"}))
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "Hello, Alice!");

    let result = host
        .execute_command_with_context(
            "hello",
            "Alice",
            &PluginContext {
                cwd: Some("/tmp/plugin-test".to_string()),
                has_ui: true,
                session_entries: vec![serde_json::json!({
                    "type": "message",
                    "id": "root",
                    "parent_id": null,
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 0}
                })],
                session_branch: vec![serde_json::json!({
                    "type": "message",
                    "id": "root",
                    "parent_id": null,
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 0}
                })],
                leaf_id: Some("root".to_string()),
                labels: std::collections::BTreeMap::from([(
                    "root".to_string(),
                    "top".to_string(),
                )]),
                session_file: None,
                session_id: Some("session-1".to_string()),
                session_name: Some("demo".to_string()),
                system_prompt: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result["message"],
        "Hello command Alice @ /tmp/plugin-test ui=true entries=1 leaf=root label=top"
    );

    host.kill().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn plugin_tool_receives_exact_invocation_context_and_streams_progress() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let dir = std::env::temp_dir().join(format!("kordi-plugin-context-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("plugin.js");
    std::fs::write(
        &path,
        r#"module.exports = kordi => kordi.registerTool({
      name: 'context_probe', description: 'Probe', parameters: { type: 'object' },
      execute: async (callId, _args, ctx) => {
        ctx.reportProgress('working');
        return { content: [{ type: 'text', text: `${callId}|${ctx.cwd}` }] };
      }
    });"#,
    )
    .unwrap();
    let mut host = PluginHost::load_plugins(&[path]).await.unwrap();
    let chunks = std::sync::Mutex::new(Vec::new());
    let result = host
        .execute_tool_with_context(
            "context_probe",
            "call-from-model",
            serde_json::json!({}),
            &types::PluginContext {
                cwd: Some(dir.display().to_string()),
                ..Default::default()
            },
            Some(&|chunk| chunks.lock().unwrap().push(chunk.to_string())),
        )
        .await
        .unwrap();
    assert_eq!(chunks.into_inner().unwrap(), ["working"]);
    assert_eq!(
        result["content"][0]["text"],
        format!("call-from-model|{}", dir.display())
    );
    host.kill().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_extension_ui_plumbing() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("Skipping test: node not available");
        return;
    }

    let temp_dir = std::env::temp_dir().join("kordi-test-ui-ext");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let plugin_path = temp_dir.join("ui-ext.js");
    std::fs::write(
        &plugin_path,
        r#"
            module.exports = function(kordi) {
                kordi.registerCommand('ui-test', {
                    description: 'Test UI methods',
                    handler: async (args, ctx) => {
                        ctx.ui.notify('hello from extension', 'info');
                        ctx.ui.setStatus('my-ext', 'running...');
                        ctx.ui.setWidget('my-widget', ['line1', 'line2']);

                        const confirmed = await ctx.ui.confirm('Danger!', 'Continue?');
                        const selected = await ctx.ui.select('Pick', ['A', 'B', 'C']);
                        const typed = await ctx.ui.input('Name?', 'enter name');

                        return {
                            message: `confirmed=${confirmed} selected=${selected} typed=${typed}`,
                        };
                    },
                });

                kordi.on('session_start', async (_event, ctx) => {
                    ctx.ui.notify('session started!', 'info');
                    return {};
                });
            };
        "#,
    )
    .unwrap();

    let ui_handler: types::SharedUiHandler = std::sync::Arc::new(types::DefaultUiHandler);

    let mut host = PluginHost::load_plugins(std::slice::from_ref(&plugin_path))
        .await
        .unwrap();
    host.set_ui_handler(ui_handler);

    assert_eq!(host.registered_commands().len(), 1);
    assert_eq!(host.registered_commands()[0].name(), "ui-test");

    let result = host.execute_command("ui-test", "").await.unwrap();
    let message = result["message"].as_str().unwrap();
    assert_eq!(
        message,
        "confirmed=false selected=undefined typed=undefined"
    );

    let result = host.send_event(&kordi_hooks::Event::SessionStart).await;
    assert!(result.is_none());

    host.kill().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_load_plugins_rejects_empty_plugin_list() {
    let err = match PluginHost::load_plugins(&[]).await {
        Ok(_) => panic!("empty plugin list should fail"),
        Err(err) => err,
    };
    assert!(matches!(err, types::PluginHostError::NoPlugins));
}

#[tokio::test]
async fn test_startup_ignores_invalid_json_lines_before_valid_registration() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("Skipping test: node not available");
        return;
    }

    let temp_dir = std::env::temp_dir().join("kordi-test-invalid-startup-lines");
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let plugin_path = temp_dir.join("startup-invalid.js");
    std::fs::write(
        &plugin_path,
        r#"
            process.stdout.write('not-json\n');
            module.exports = function(kordi) {
                kordi.registerCommand('still-loads', {
                    description: 'Load despite junk stdout',
                    handler: async () => ({ message: 'ok' }),
                });
            };
        "#,
    )
    .expect("write plugin");

    let mut host = PluginHost::load_plugins(std::slice::from_ref(&plugin_path))
        .await
        .expect("host should load despite junk lines");

    assert_eq!(host.plugin_count(), 1);
    assert_eq!(host.registered_commands().len(), 1);
    assert_eq!(host.registered_commands()[0].name(), "still-loads");

    host.kill().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_execute_command_ignores_invalid_stdout_notifications() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("Skipping test: node not available");
        return;
    }

    let temp_dir = std::env::temp_dir().join("kordi-test-invalid-runtime-lines");
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let plugin_path = temp_dir.join("runtime-invalid.js");
    std::fs::write(
        &plugin_path,
        r#"
            module.exports = function(kordi) {
                kordi.registerCommand('runtime-junk', {
                    description: 'Emit junk stdout before responding',
                    handler: async () => {
                        process.stdout.write('not-json\n');
                        process.stdout.write(JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'command_registered',
                            params: { description: 'missing name' }
                        }) + '\n');
                        return { message: 'ok' };
                    },
                });
            };
        "#,
    )
    .expect("write plugin");

    let mut host = PluginHost::load_plugins(std::slice::from_ref(&plugin_path))
        .await
        .expect("host should load");

    let result = host
        .execute_command("runtime-junk", "")
        .await
        .expect("command should succeed despite junk output");
    assert_eq!(result["message"], "ok");
    assert_eq!(host.registered_commands().len(), 1);

    host.kill().await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[cfg(unix)]
#[tokio::test]
async fn killing_plugin_host_stops_spawned_children() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let dir = tempfile::tempdir().expect("temporary plugin directory");
    let plugin_path = dir.path().join("child.js");
    let marker_path = dir.path().join("child-survived");
    std::fs::write(&plugin_path, r#"
        const { spawn } = require('node:child_process');
        module.exports = kordi => kordi.registerCommand('spawn-child', {
          description: 'Spawn delayed child',
          handler: async args => {
            spawn(process.execPath, ['-e',
              'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 700)',
              args], { stdio: 'ignore' });
            return { message: 'started' };
          }
        });
    "#).expect("write plugin");
    let mut host = PluginHost::load_plugins(&[plugin_path])
        .await
        .expect("plugin host");
    host.execute_command("spawn-child", marker_path.to_str().unwrap())
        .await
        .expect("child started");
    host.kill().await;
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    assert!(
        !marker_path.exists(),
        "cancelled plugin subprocess continued after host termination"
    );
}
