/// Opt-in native harness smoke test with a local OpenAI-compatible fixture server.
/// The server must issue read, bash and local_app calls and verify their results.
#[allow(
    clippy::await_holding_lock,
    reason = "serialize isolated native test configuration"
)]
#[tokio::test]
#[ignore = "requires a loopback model fixture and an interactive macOS session"]
async fn native_owner_local_tools_round_trip() -> Result<()> {
    let endpoint = std::env::var("KORDI_LOCAL_TOOLS_TEST_MODEL_URL")?;
    let url = url::Url::parse(&endpoint)?;
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _storage = EnvVarGuard::set_path("KORDI_STORAGE_ROOT", home.path());
    let _auth = EnvVarGuard::set_path("KORDI_AUTH_PATH", &home.path().join("auth.json"));
    Settings {
        default_provider: Some("ollama".into()),
        default_model: Some("local-access-fixture".into()),
        providers: Some(vec![kordi_core::settings::ProviderOverride {
            name: "ollama".into(),
            base_url: Some(endpoint),
            api_key_env: None,
            api: None,
            headers: None,
        }]),
        ..Settings::default()
    }
    .save_global()?;
    let project = home.path().join("kordi-local-tools-qa-fixture");
    std::fs::create_dir(&project)?;
    std::fs::write(project.join("marker.txt"), "KORDI_LOCAL_ACCESS_VERIFIED\n")?;
    let mut runtime = DesktopRuntimeSession::create_new(home.path().to_path_buf()).await?;
    let detail = runtime.send_message(
        "@~/kordi-local-tools-qa-fixture LOCAL_ACCESS_SMOKE: verify marker.txt, the shell workspace and whether Finder is running. Do not change application data.".into(), vec![],
    ).await?;
    assert!(
        detail
            .messages
            .iter()
            .any(|message| message.role == "assistant"
                && message.text.contains("LOCAL_ACCESS_SMOKE PASS"))
    );
    assert_eq!(
        std::path::Path::new(&detail.cwd),
        std::fs::canonicalize(project)?
    );
    Ok(())
}
