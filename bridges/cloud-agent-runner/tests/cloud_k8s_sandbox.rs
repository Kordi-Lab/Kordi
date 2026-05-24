use async_trait::async_trait;
use kordi_cloud_agent_runner::k8s_sandbox::{
    build_sandbox_job_spec, build_sandbox_pvc_spec, K8sCommandOutput, K8sCommandRunner,
    K8sSandboxBackend, K8sSandboxConfig, K8sSandboxOperation,
};
use kordi_cloud_agent_runner::sandbox_client::SandboxBackend;
use std::sync::{Arc, Mutex};

#[test]
fn k8s_job_spec_is_restricted_and_mounts_only_sandbox_pvc() {
    let config = K8sSandboxConfig::default();
    let spec = build_sandbox_job_spec(
        &config,
        "cas_test_123",
        K8sSandboxOperation::Bash {
            command: "printf hello".to_string(),
        },
    );

    assert_eq!(spec["metadata"]["namespace"], "kordi-cloud");
    assert_eq!(
        spec["spec"]["template"]["spec"]["automountServiceAccountToken"],
        false
    );
    assert_eq!(spec["spec"]["template"]["spec"]["restartPolicy"], "Never");
    let container = &spec["spec"]["template"]["spec"]["containers"][0];
    assert_eq!(container["workingDir"], "/workspace");
    assert_eq!(container["securityContext"]["runAsNonRoot"], true);
    assert_eq!(container["securityContext"]["privileged"], false);
    assert_eq!(container["volumeMounts"][0]["mountPath"], "/workspace");
    let volumes = &spec["spec"]["template"]["spec"]["volumes"];
    assert_eq!(
        volumes[0]["persistentVolumeClaim"]["claimName"],
        "kordi-cloud-sandbox-cas-test-123"
    );
    assert!(spec.to_string().contains("persistentVolumeClaim"));
    assert!(!spec.to_string().contains("hostPath"));
}

#[test]
fn k8s_pvc_spec_uses_safe_name_labels_and_storage_request() {
    let config = K8sSandboxConfig::default();
    let spec = build_sandbox_pvc_spec(&config, "cas_test_123");

    assert_eq!(spec["kind"], "PersistentVolumeClaim");
    assert_eq!(spec["metadata"]["namespace"], "kordi-cloud");
    assert_eq!(spec["metadata"]["name"], "kordi-cloud-sandbox-cas-test-123");
    assert_eq!(
        spec["metadata"]["labels"]["app.kubernetes.io/name"],
        "kordi-cloud-sandbox-workspace"
    );
    assert_eq!(
        spec["metadata"]["labels"]["kordi.ai/sandbox-id"],
        "cas_test_123"
    );
    assert_eq!(spec["spec"]["accessModes"][0], "ReadWriteOnce");
    assert_eq!(spec["spec"]["resources"]["requests"]["storage"], "512Mi");
    assert!(!spec.to_string().contains("hostPath"));
}

#[derive(Default)]
struct FakeRunner {
    calls: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl K8sCommandRunner for FakeRunner {
    async fn ensure_pvc(
        &self,
        namespace: &str,
        pvc_name: &str,
        _pvc_spec: serde_json::Value,
    ) -> Result<(), kordi_cloud_agent_runner::sandbox_client::SandboxClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("pvc:{namespace}:{pvc_name}"));
        Ok(())
    }

    async fn run_json_job(
        &self,
        namespace: &str,
        job_name: &str,
        _job_spec: serde_json::Value,
    ) -> Result<K8sCommandOutput, kordi_cloud_agent_runner::sandbox_client::SandboxClientError>
    {
        self.calls
            .lock()
            .unwrap()
            .push(format!("job:{namespace}:{job_name}"));
        Ok(K8sCommandOutput {
            stdout: "hello from k8s".to_string(),
            stderr: String::new(),
            exit_code: 0,
        })
    }
}

#[tokio::test]
async fn k8s_backend_uses_fake_runner_without_touching_local_files() {
    let runner = Arc::new(FakeRunner::default());
    let backend = K8sSandboxBackend::new(
        K8sSandboxConfig::default(),
        "cas_fake".to_string(),
        runner.clone(),
    );

    let output = backend.run_bash("printf hello").await.unwrap();

    assert_eq!(output.stdout, "hello from k8s");
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
    assert!(backend.read_text("/Users/owner/private.txt").await.is_err());
}

#[tokio::test]
async fn k8s_backend_ensures_pvc_before_job() {
    let runner = Arc::new(FakeRunner::default());
    let backend = K8sSandboxBackend::new(
        K8sSandboxConfig::default(),
        "cas_fake".to_string(),
        runner.clone(),
    );

    let _ = backend.run_bash("printf hello").await.unwrap();

    let calls = runner.calls.lock().unwrap();
    assert_eq!(calls[0], "pvc:kordi-cloud:kordi-cloud-sandbox-cas-fake");
    assert!(calls[1].starts_with("job:kordi-cloud:kordi-sandbox-cas-fake"));
}
