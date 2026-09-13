use super::*;
use kordi_cloud_agent_runner::sandbox_client::{SandboxBackend, SandboxClientError};

struct EncodedRunner {
    output: String,
}

#[async_trait]
impl K8sCommandRunner for EncodedRunner {
    async fn ensure_pvc(
        &self,
        _namespace: &str,
        _name: &str,
        _spec: serde_json::Value,
    ) -> Result<(), SandboxClientError> {
        Ok(())
    }
    async fn run_json_job(
        &self,
        _namespace: &str,
        _name: &str,
        spec: serde_json::Value,
    ) -> Result<K8sCommandOutput, SandboxClientError> {
        let command = spec["spec"]["template"]["spec"]["containers"][0]["command"][2]
            .as_str()
            .unwrap();
        assert!(command.contains("realpath"));
        assert!(command.contains("/workspace/*"));
        assert!(command.contains("head -c 9"));
        Ok(K8sCommandOutput {
            stdout: self.output.clone(),
            stderr: String::new(),
            exit_code: 0,
        })
    }
}

#[tokio::test]
async fn bounded_reads_decode_wrapped_base64_and_reject_oversized_or_invalid_output() {
    for (output, expected) in [
        ("YWJj\nZGVm\n", Some(b"abcdef".as_slice())),
        ("YWJjZGVmZ2hpag==", None),
        ("invalid!", None),
    ] {
        let backend = K8sSandboxBackend::new(
            K8sSandboxConfig::default(),
            "image-fixture".into(),
            Arc::new(EncodedRunner {
                output: output.into(),
            }),
        );
        let result = backend.read_bytes_bounded("marker.png", 8).await;
        if let Some(bytes) = expected {
            assert_eq!(result.unwrap(), bytes);
        } else {
            assert!(result.is_err());
        }
        assert!(backend
            .read_bytes_bounded("../escape.png", 8)
            .await
            .is_err());
    }
}
