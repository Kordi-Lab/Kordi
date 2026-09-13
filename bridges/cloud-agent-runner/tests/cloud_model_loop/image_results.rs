use super::*;
use base64::Engine;
use kordi_cloud_agent_runner::tool_policy::RunnerToolRequest;
use kordi_cloud_agent_runner::tools::{CloudToolExecutor, CloudToolOutput};

#[tokio::test]
async fn sandbox_images_reach_the_next_model_call_as_real_images() {
    let sandbox = sandbox();
    std::fs::write(sandbox.root().join("first.png"), image_fixtures::RED_BLUE).unwrap();
    std::fs::write(
        sandbox.root().join("second.webp"),
        image_fixtures::GREEN_WHITE,
    )
    .unwrap();
    let backend: SandboxBackendHandle = sandbox.clone();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![
            ModelToolCall {
                id: "image-first".into(),
                name: "read".into(),
                arguments: json!({"path":"first.png"}),
            },
            ModelToolCall {
                id: "image-second".into(),
                name: "read".into(),
                arguments: json!({"path":"second.webp"}),
            },
        ]),
        ModelProviderResponse::FinalText("Images received".into()),
    ]);
    let result = run_model_loop(
        &RecordingClient::default(),
        &provider,
        &run(),
        &backend,
        provider_auth(),
    )
    .await
    .unwrap();
    assert_eq!(result, "Images received");
    let seen = provider.seen_messages.lock().unwrap();
    let results: Vec<_> = seen[1].iter().filter(|m| m["role"] == "tool").collect();
    assert_eq!(results.len(), 2);
    for (result, (id, bytes)) in results.iter().zip([
        ("image-first", image_fixtures::RED_BLUE),
        ("image-second", image_fixtures::GREEN_WHITE),
    ]) {
        assert_eq!(result["tool_call_id"], id);
        assert_eq!(result["content"][0]["type"], "image");
        assert_eq!(result["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(
            result["content"][0]["source"]["data"],
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
    }
    std::fs::remove_dir_all(sandbox.root()).unwrap();
}

async fn read(executor: &CloudToolExecutor, path: &str) -> Result<CloudToolOutput, String> {
    executor
        .execute(
            RunnerToolRequest {
                tool_name: "read",
                path_args: vec![path],
                url_args: vec![],
                owner_account_id: "owner",
                requester_account_id: "requester",
                data_owner_account_id: None,
            },
            Some(path),
            None,
            &json!({"path":path}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tokio::test]
async fn sandbox_image_reads_enforce_size_format_and_path_boundaries() {
    let sandbox = sandbox();
    let backend: SandboxBackendHandle = sandbox.clone();
    let executor = CloudToolExecutor::new(backend);
    std::fs::write(sandbox.root().join("broken.png"), b"not an image").unwrap();
    assert!(read(&executor, "broken.png")
        .await
        .unwrap_err()
        .contains("Invalid"));
    let file = std::fs::File::create(sandbox.root().join("large.png")).unwrap();
    file.set_len(kordi_tools::image_input::MAX_IMAGE_BYTES as u64 + 1)
        .unwrap();
    assert!(read(&executor, "large.png")
        .await
        .unwrap_err()
        .contains("limit"));
    assert!(read(&executor, "../outside.png").await.is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::env::temp_dir(), sandbox.root().join("escape")).unwrap();
        // The target exists, but resolving it leaves this sandbox.
        std::os::unix::fs::symlink(std::env::temp_dir(), sandbox.root().join("escape.png"))
            .unwrap();
        assert!(read(&executor, "escape.png")
            .await
            .unwrap_err()
            .contains("PathEscapesSandbox"));
    }
    std::fs::write(sandbox.root().join("plain.txt"), "unchanged text").unwrap();
    assert_eq!(
        read(&executor, "plain.txt").await.unwrap(),
        CloudToolOutput::Text("unchanged text".into())
    );
    std::fs::remove_dir_all(sandbox.root()).unwrap();
}
