use super::*;

#[tokio::test]
async fn package_loaded_extension_command_executes_with_context() {
    if !node_available() {
        eprintln!("Skipping test: node not available");
        return;
    }

    let cwd = tempdir().unwrap();
    let package_dir = cwd.path().join("command-package");
    fs::create_dir_all(package_dir.join("extensions")).unwrap();
    fs::write(
        package_dir.join("package.json"),
        r#"{
                "name": "command-package",
                "kordi": {
                    "extensions": ["./extensions"]
                }
            }"#,
    )
    .unwrap();
    fs::write(
            package_dir.join("extensions/hello.js"),
            r#"
                module.exports = function(kordi) {
                    kordi.registerCommand('pkghello', {
                        description: 'package hello',
                        handler: async (args, ctx) => ({
                            message: [
                                `pkg:${args}`,
                                `ui:${ctx.hasUI}`,
                                `cwd:${ctx.cwd}`,
                                `entries:${ctx.sessionManager.getEntries().length}`,
                                `branch:${ctx.sessionManager.getBranch().length}`,
                                `leaf:${ctx.sessionManager.getLeafId()}`,
                                `label:${ctx.sessionManager.getLabel(ctx.sessionManager.getEntries()[0]?.id)}`,
                                `session:${ctx.sessionManager.getSessionId()}`,
                            ].join('|'),
                        }),
                    });
                };
            "#,
        )
        .unwrap();

    let conn = kordi_session::store::open_db(&cwd.path().join("sessions.db")).unwrap();
    let session_id =
        kordi_session::store::create_session(&conn, cwd.path().to_str().unwrap()).unwrap();
    let root = kordi_core::types::SessionEntry::Message {
        base: kordi_core::types::EntryBase {
            id: kordi_core::types::EntryId::generate(),
            parent_id: None,
            timestamp: chrono::Utc::now(),
        },
        message: kordi_core::types::AgentMessage::User(kordi_core::types::UserMessage {
            content: vec![kordi_core::types::ContentBlock::Text {
                text: "hello".to_string(),
            }],
            timestamp: chrono::Utc::now().timestamp_millis(),
        }),
    };
    let root_id = root.base().id.to_string();
    kordi_session::store::append_entry(&conn, &session_id, &root).unwrap();
    let label = kordi_core::types::SessionEntry::Label {
        base: kordi_core::types::EntryBase {
            id: kordi_core::types::EntryId::generate(),
            parent_id: Some(kordi_core::types::EntryId(root_id.clone())),
            timestamp: chrono::Utc::now(),
        },
        target_id: kordi_core::types::EntryId(root_id.clone()),
        label: Some("root-label".to_string()),
    };
    kordi_session::store::append_entry(&conn, &session_id, &label).unwrap();

    let settings = Settings {
        packages: vec![PackageEntry::Simple(package_dir.display().to_string())],
        ..Settings::default()
    };
    let mut support = load_runtime_extension_support_with_ui(
        cwd.path(),
        &settings,
        &ExtensionBootstrap::default(),
        true,
    )
    .await
    .unwrap();
    support.commands.bind_session_context(
        crate::turn_runner::open_sibling_conn(&conn).unwrap(),
        session_id.clone(),
        None,
    );

    assert!(support.commands.is_registered("/pkghello world"));
    let output = support
        .commands
        .execute_text("/pkghello world")
        .await
        .unwrap();
    let output = output.unwrap();
    assert!(output.contains("pkg:world"));
    assert!(output.contains("ui:true"));
    assert!(output.contains(cwd.path().to_str().unwrap()));
    assert!(output.contains("entries:2"));
    assert!(output.contains("branch:2"));
    assert!(output.contains(&format!("leaf:{}", label.base().id)));
    assert!(output.contains("label:root-label"));
    assert!(output.contains(&format!("session:{session_id}")));
}

#[tokio::test]
async fn extension_command_timeout_returns_error_instead_of_hanging() {
    if !node_available() {
        eprintln!("Skipping test: node not available");
        return;
    }

    let cwd = tempdir().unwrap();
    let extension_path = cwd.path().join("slow.js");
    fs::write(
        &extension_path,
        r#"
                module.exports = function(kordi) {
                    kordi.registerCommand('slow', {
                        description: 'slow command',
                        handler: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 60000));
                            return { message: 'done' };
                        },
                    });
                };
            "#,
    )
    .unwrap();

    let support = load_runtime_extension_support_with_ui(
        cwd.path(),
        &Settings::default(),
        &ExtensionBootstrap {
            paths: vec![extension_path],
            package_sources: Vec::new(),
        },
        true,
    )
    .await
    .unwrap();

    let err = support
        .commands
        .execute_text_structured("/slow")
        .await
        .expect_err("slow extension command should time out");
    assert!(err.to_string().contains("timed out"));
}

#[tokio::test]
async fn reload_reloads_extension_command_output() {
    if !node_available() {
        eprintln!("Skipping test: node not available");
        return;
    }

    let cwd = tempdir().unwrap();
    let extension_path = cwd.path().join("reload.js");
    fs::write(
        &extension_path,
        r#"
                module.exports = function(kordi) {
                    kordi.registerCommand('hello', {
                        description: 'hello',
                        handler: async () => ({ message: 'v1' }),
                    });
                };
            "#,
    )
    .unwrap();

    let bootstrap = ExtensionBootstrap {
        paths: vec![extension_path.clone()],
        package_sources: Vec::new(),
    };
    let settings = Settings::default();
    let support_v1 = load_runtime_extension_support(cwd.path(), &settings, &bootstrap)
        .await
        .unwrap();
    assert_eq!(
        support_v1.commands.execute_text("/hello").await.unwrap(),
        Some("v1".to_string())
    );

    fs::write(
        &extension_path,
        r#"
                module.exports = function(kordi) {
                    kordi.registerCommand('hello', {
                        description: 'hello',
                        handler: async () => ({ message: 'v2' }),
                    });
                };
            "#,
    )
    .unwrap();

    let support_v2 = load_runtime_extension_support(cwd.path(), &settings, &bootstrap)
        .await
        .unwrap();
    assert_eq!(
        support_v2.commands.execute_text("/hello").await.unwrap(),
        Some("v2".to_string())
    );
}

#[tokio::test]
async fn extension_ui_notify_and_confirm_plumbing() {
    if !node_available() {
        eprintln!("Skipping test: node not available");
        return;
    }

    let cwd = tempdir().unwrap();
    let ext_path = cwd.path().join("ui-ext.js");
    fs::write(
        &ext_path,
        r#"
                module.exports = function(kordi) {
                    kordi.registerCommand('ui-demo', {
                        description: 'demo UI methods',
                        handler: async (args, ctx) => {
                            ctx.ui.notify('extension says hi', 'info');
                            ctx.ui.setStatus('demo', 'active');
                            const ok = await ctx.ui.confirm('Title', 'Sure?');
                            const picked = await ctx.ui.select('Pick', ['a','b']);
                            return { message: `ok=${ok} picked=${picked}` };
                        },
                    });
                };
            "#,
    )
    .unwrap();

    let bootstrap = ExtensionBootstrap {
        paths: vec![ext_path],
        package_sources: Vec::new(),
    };
    let settings = Settings::default();
    // Load with has_ui=true to get an ExtensionUiHandler
    let support = load_runtime_extension_support_with_ui(cwd.path(), &settings, &bootstrap, true)
        .await
        .unwrap();

    // Get the interactive handler to verify stored notifications
    let handler = support
        .commands
        .ui_handler
        .as_ref()
        .expect("should have ui handler");
    // Downcast to ExtensionUiHandler
    let interactive_handler = handler
        .as_ref()
        .as_any()
        .downcast_ref::<ExtensionUiHandler>()
        .expect("should be ExtensionUiHandler");

    let output = support
        .commands
        .execute_text("/ui-demo")
        .await
        .unwrap()
        .unwrap();
    // Dialogs return defaults: confirm=false, select=cancelled(undefined)
    assert_eq!(output, "ok=false picked=undefined");

    // Verify notifications were captured
    let notifications = interactive_handler.drain_notifications().await;
    assert!(!notifications.is_empty());
    assert_eq!(notifications[0].message, "extension says hi");
    assert_eq!(notifications[0].kind, "info");

    // Verify status was captured
    let statuses = interactive_handler.get_statuses().await;
    assert_eq!(statuses.get("demo"), Some(&Some("active".to_string())));
}
