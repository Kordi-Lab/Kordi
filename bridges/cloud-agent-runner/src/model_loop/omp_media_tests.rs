use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

#[path = "../../../../shared/test-fixtures/chat_media.rs"]
mod fixtures;
use fixtures::IMAGES;

struct MediaClient;
#[async_trait]
impl CloudAgentRunClient for MediaClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        unreachable!()
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        unreachable!()
    }
    async fn complete_run(&self, _: &str, _: &str) -> Result<(), RunnerClientError> {
        unreachable!()
    }
    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        unreachable!()
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        unreachable!()
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        unreachable!()
    }
    async fn read_context(
        &self,
        _: &str,
        tool: &str,
        args: Value,
    ) -> Result<Value, RunnerClientError> {
        assert_eq!(tool, "read_session");
        assert_eq!(args["mode"], "attachment");
        let index = args["attachmentId"]
            .as_str()
            .unwrap()
            .strip_prefix("image-")
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert_eq!(
            args["messageIds"],
            json!([if index < 2 { "mixed" } else { "newer" }])
        );
        let content = kordi_tools::image_input::static_image_content(IMAGES[index]).unwrap();
        Ok(
            json!({"messages":[{"messageId":args["messageIds"][0],"attachments":[{"attachmentId":format!("image-{index}")}]}],"media":[content]}),
        )
    }
}

#[tokio::test]
async fn cloud_observation_images_have_omp_data_and_failed_reads_remain_errors() {
    let path = std::env::temp_dir().join(format!("kordi-media-{}", uuid::Uuid::new_v4()));
    let sandbox = Arc::new(crate::sandbox_client::LocalSandboxBackend::new(
        path.clone(),
    )) as SandboxBackendHandle;
    let run = run();
    let host = CloudOmpTools {
        client: &MediaClient,
        executor: CloudToolExecutor::new(sandbox.clone()),
        sandbox: &sandbox,
        run: &run,
        outcomes: Default::default(),
    };
    for (index, bytes) in IMAGES.iter().enumerate() {
        let result = host
            .execute(
                ToolCall {
                    call_id: format!("image-{index}"),
                    name: "read_session".into(),
                    input: image_args(index),
                },
                CancellationToken::new(),
            )
            .await;
        assert!(result.ok);
        assert_eq!(
            result.content[1],
            json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(bytes)})
        );
        assert!(!result.content[0]
            .to_string()
            .contains(&STANDARD.encode(bytes)));
    }
    let denied = CloudOmpTools {
        client: &NoCloudCalls,
        executor: CloudToolExecutor::new(sandbox.clone()),
        sandbox: &sandbox,
        run: &run,
        outcomes: Default::default(),
    };
    let result = denied
        .execute(
            ToolCall {
                call_id: "denied".into(),
                name: "read_session".into(),
                input: image_args(0),
            },
            CancellationToken::new(),
        )
        .await;
    assert!(!result.ok);
    assert!(result.content.iter().all(|block| block["type"] == "text"));
    if path.exists() {
        std::fs::remove_dir_all(path).unwrap();
    }
}

fn image_args(index: usize) -> Value {
    json!({"sessionId":"session","mode":"attachment","messageIds":[if index < 2 {"mixed"} else {"newer"}],"attachmentId":format!("image-{index}"),"expectedVersion":1})
}

async fn read_body(stream: &mut tokio::net::TcpStream) -> Value {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 8192];
        let count = stream.read(&mut chunk).await.unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 2 * 1024 * 1024);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
            }
        }
    }
}

/// Deterministic provider-input evidence, never a live semantic model evaluation.
#[tokio::test]
#[ignore = "requires the installed Bun worker; uses only a loopback synthetic provider"]
async fn real_bun_cloud_images_reach_provider_in_message_order_including_newer_image() {
    let script = std::env::var_os("KORDI_OMP_WORKER_SCRIPT").expect("worker script");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        for step in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let body = read_body(&mut stream).await;
            let images = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
                .filter(|b| b["type"] == "image_url")
                .map(|b| b["image_url"]["url"].as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            let expected = IMAGES[..[0, 2, 3][step]]
                .iter()
                .map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
                .collect::<Vec<_>>();
            assert_eq!(
                images, expected,
                "all actual image bytes must reach the provider in order"
            );
            let (delta, finish) = if step < 2 {
                let calls = (if step == 0 { 0..2 } else { 2..3 }).enumerate().map(|(position, index)| json!({"index":position,"id":format!("image-{index}"),"type":"function","function":{"name":"read_session","arguments":image_args(index).to_string()}})).collect::<Vec<_>>();
                (json!({"role":"assistant","tool_calls":calls}), "tool_calls")
            } else {
                (
                    json!({"role":"assistant","content":"Synthetic transport completed."}),
                    "stop",
                )
            };
            let chunks = [
                json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}]}),
            ];
            let body = chunks
                .into_iter()
                .map(|mut chunk| {
                    chunk["id"] = json!("fixture");
                    chunk["object"] = json!("chat.completion.chunk");
                    chunk["created"] = json!(1);
                    chunk["model"] = json!("fixture-model");
                    format!("data: {chunk}\n\n")
                })
                .collect::<String>()
                + "data: [DONE]\n\n";
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let path = std::env::temp_dir().join(format!("kordi-omp-media-{}", uuid::Uuid::new_v4()));
    let sandbox = Arc::new(crate::sandbox_client::LocalSandboxBackend::new(
        path.clone(),
    )) as SandboxBackendHandle;
    let config = OmpTurnConfig {
        snapshot_id: "synthetic".into(),
        auth: OpenAiProviderConfig {
            provider: "fixture-provider".into(),
            api_key: "synthetic-key".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "fixture-model".into(),
            thinking: "low".into(),
            api_mode: OpenAiApiMode::ChatCompletions,
            account_id: None,
        },
        worker: OmpRuntime::new(WorkerCommand {
            program: "bun".into(),
            args: vec!["run".into(), script],
            computer_lock_path: None,
        }),
        prompt: "Inspect the images in the mixed message and the newer unread message.".into(),
        messages: vec![],
    };
    let (reply, state) = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        run_omp_with_config(&MediaClient, &run(), &sandbox, config),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    assert_eq!(reply, "Synthetic transport completed.");
    assert!(
        !state.replayable,
        "private retrieved images must not become stale replay context"
    );
    if path.exists() {
        std::fs::remove_dir_all(path).unwrap();
    }
}
