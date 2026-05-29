# Cloud K8s Sandbox PVC Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure K8s sandbox PVCs exist before sandbox Jobs run and add a manual K3s smoke script.

**Architecture:** Extend the existing K8s sandbox job-spec module with a PVC spec builder and storage request config. Extend the fakeable command runner so `K8sSandboxBackend` idempotently applies the PVC before every Job. Add a shell smoke script for real K3s validation without enabling the runner Deployment.

**Tech Stack:** Rust, serde_json, async-trait, tokio process, kubectl, Bash.

---

## Task 1: PVC spec builder and fake-runner ordering

**Files:**
- Modify: `bridges/cloud-agent-runner/src/k8s_sandbox/job_spec.rs`
- Modify: `bridges/cloud-agent-runner/src/k8s_sandbox/mod.rs`
- Modify: `bridges/cloud-agent-runner/src/k8s_sandbox/runner.rs`
- Modify: `bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs`

- [ ] **Step 1: Write failing tests**

Add tests to `cloud_k8s_sandbox.rs`:

```rust
#[test]
fn k8s_pvc_spec_uses_safe_name_labels_and_storage_request() {
    let config = K8sSandboxConfig::default();
    let spec = build_sandbox_pvc_spec(&config, "cas_test_123");

    assert_eq!(spec["kind"], "PersistentVolumeClaim");
    assert_eq!(spec["metadata"]["namespace"], "kordi-cloud");
    assert_eq!(spec["metadata"]["name"], "kordi-cloud-sandbox-cas-test-123");
    assert_eq!(spec["metadata"]["labels"]["app.kubernetes.io/name"], "kordi-cloud-sandbox-workspace");
    assert_eq!(spec["metadata"]["labels"]["kordi.ai/sandbox-id"], "cas_test_123");
    assert_eq!(spec["spec"]["accessModes"][0], "ReadWriteOnce");
    assert_eq!(spec["spec"]["resources"]["requests"]["storage"], "512Mi");
    assert!(!spec.to_string().contains("hostPath"));
}

#[tokio::test]
async fn k8s_backend_ensures_pvc_before_job() {
    let runner = Arc::new(FakeRunner::default());
    let backend = K8sSandboxBackend::new(K8sSandboxConfig::default(), "cas_fake".to_string(), runner.clone());

    let _ = backend.run_bash("printf hello").await.unwrap();

    assert_eq!(runner.calls.lock().unwrap()[0], "pvc:kordi-cloud:kordi-cloud-sandbox-cas-fake");
    assert!(runner.calls.lock().unwrap()[1].starts_with("job:kordi-cloud:kordi-sandbox-cas-fake"));
}
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_k8s_sandbox -- --nocapture
```

Expected: compile failure for missing `build_sandbox_pvc_spec` / `ensure_pvc`.

- [ ] **Step 2: Implement PVC spec builder**

Add `storage_request: String` to `K8sSandboxConfig`, defaulting from `KORDI_CLOUD_SANDBOX_STORAGE_REQUEST` or `512Mi`.

Add:

```rust
pub fn build_sandbox_pvc_spec(config: &K8sSandboxConfig, sandbox_id: &str) -> Value { ... }
```

PVC spec fields:

```json
{
  "apiVersion": "v1",
  "kind": "PersistentVolumeClaim",
  "metadata": { "name": "kordi-cloud-sandbox-...", "namespace": "kordi-cloud", "labels": { ... } },
  "spec": {
    "accessModes": ["ReadWriteOnce"],
    "resources": { "requests": { "storage": "512Mi" } }
  }
}
```

- [ ] **Step 3: Extend command runner and backend**

Add to `K8sCommandRunner`:

```rust
async fn ensure_pvc(&self, namespace: &str, pvc_name: &str, pvc_spec: Value) -> Result<(), SandboxClientError>;
```

`KubectlCommandRunner::ensure_pvc` should apply JSON through `kubectl -n <namespace> apply -f -` using existing apply helper.

`K8sSandboxBackend::run_operation` should call `ensure_pvc` before `run_json_job`.

- [ ] **Step 4: Run tests and commit**

```bash
rustfmt --edition 2021 bridges/cloud-agent-runner/src/k8s_sandbox/*.rs bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs
cargo test -p kordi-cloud-agent-runner --test cloud_k8s_sandbox -- --nocapture
cargo test -p kordi-cloud-agent-runner
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/k8s_sandbox bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs
git commit -m "feat: ensure k8s sandbox pvc before jobs"
```

---

## Task 2: Manual K3s smoke script

**Files:**
- Create: `bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh`

- [ ] **Step 1: Add smoke script**

Create Bash script that:

- uses `/bin/bash`
- sets `set -euo pipefail`
- applies PVC
- runs write/read/bash Jobs
- validates output
- deletes Jobs and PVC unless `KEEP_KORDI_SANDBOX_SMOKE=1`

- [ ] **Step 2: Run shell syntax check**

```bash
bash -n bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh
```

- [ ] **Step 3: Commit**

```bash
git add bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh
git commit -m "test: add k8s sandbox smoke script"
```

---

## Task 3: Verification, remote smoke, PR

- [ ] **Step 1: Local verification**

```bash
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/*.rs bridges/cloud-agent-runner/src/model_loop/*.rs bridges/cloud-agent-runner/src/k8s_sandbox/*.rs bridges/cloud-agent-runner/tests/*.rs
bash -n bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime
cargo test -p kordi-cloud-server presence
```

- [ ] **Step 2: Remote verification**

```bash
bridges/cloud-server/deploy/sync-and-build.sh
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command 'cd /home/shu_yang/kordi-cloud-server-deploy && $HOME/.cargo/bin/cargo test -p kordi-cloud-agent-runner'
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command 'cd /home/shu_yang/kordi-cloud-server-deploy && bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh'
```

- [ ] **Step 3: Create draft PR**

```bash
git push -u origin feature/issue-509-cloud-k8s-sandbox-pvc-smoke
gh pr create --draft --base feature/issue-507-cloud-k8s-sandbox-executor --head feature/issue-509-cloud-k8s-sandbox-pvc-smoke --title "feat: ensure k8s sandbox pvcs before jobs" --body-file /tmp/issue-509-k8s-sandbox-pr.md
```
