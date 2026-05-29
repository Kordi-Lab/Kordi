# Cloud K8s Sandbox Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kubernetes-backed Cloud sandbox backend for runner tool execution while keeping local backend as the default.

**Architecture:** Introduce a `SandboxBackend` trait used by tools/model-loop/artifact export. Implement local backend against the existing filesystem code and add a K8s backend module that builds restricted Job specs and executes through an injectable command runner, defaulting to `kubectl` only when selected by env.

**Tech Stack:** Rust, async-trait, serde_json Kubernetes Job specs, tokio process, existing runner tool policy/model-loop/artifact helper.

---

## File structure

- Modify: `bridges/cloud-agent-runner/src/sandbox_client.rs`
  - Add `SandboxBackend` async trait and `SandboxBackendHandle` trait object alias.
  - Keep `LocalSandboxBackend` and implement trait.
  - Add `read_bytes`.
- Modify: `bridges/cloud-agent-runner/src/tools.rs`
  - Make `CloudToolExecutor` use `SandboxBackendHandle` instead of concrete local backend.
- Modify: `bridges/cloud-agent-runner/src/artifacts.rs`
  - Change `export_sandbox_file` to read bytes through `SandboxBackend`.
- Modify: `bridges/cloud-agent-runner/src/model_loop.rs`
  - Accept backend trait object.
- Create: `bridges/cloud-agent-runner/src/k8s_sandbox.rs`
  - K8s backend config, job spec builder, fakeable command runner.
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`
  - Select local/k8s backend from env; require `sandboxId` for k8s.
- Modify: `bridges/cloud-agent-runner/src/lib.rs`
  - Export `k8s_sandbox`.
- Modify: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml`
  - Add commented/disabled env and RBAC-safe notes for K8s backend, without enabling it.
- Tests:
  - `bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs`
  - Update existing runner tests for trait backend.

---

## Task 1: Backend trait and local implementation

- [ ] **Step 1: Write failing tests**

Add to `bridges/cloud-agent-runner/src/sandbox_client.rs` tests:

```rust
#[tokio::test]
async fn local_backend_read_bytes_matches_written_content() {
    let root = std::env::temp_dir().join(format!(
        "kordi-sandbox-bytes-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let backend = LocalSandboxBackend::new(root.clone());
    backend.write_text("artifact.txt", "hello").await.unwrap();

    let bytes = backend.read_bytes("artifact.txt").await.unwrap();

    assert_eq!(bytes, b"hello");
    let _ = std::fs::remove_dir_all(root);
}
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner local_backend_read_bytes_matches_written_content -- --nocapture
```

Expected: compile failure because `read_bytes` is not defined.

- [ ] **Step 2: Implement `SandboxBackend` trait**

In `sandbox_client.rs`, add:

```rust
use async_trait::async_trait;
use std::sync::Arc;

pub type SandboxBackendHandle = Arc<dyn SandboxBackend>;

#[async_trait]
pub trait SandboxBackend: Send + Sync {
    fn root_for_tests(&self) -> Option<&Path> { None }
    fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError>;
    async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError>;
    async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError>;
    async fn write_text(&self, relative_path: &str, content: &str) -> Result<(), SandboxClientError>;
    async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError>;
    async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError>;
}
```

Move current `LocalSandboxBackend` methods into the trait impl and keep inherent `new/root` helpers. Add `read_bytes` using `tokio::fs::read(resolve_path(...))`.

- [ ] **Step 3: Run tests and commit**

```bash
rustfmt --edition 2021 bridges/cloud-agent-runner/src/sandbox_client.rs
cargo test -p kordi-cloud-agent-runner sandbox_client -- --nocapture
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/sandbox_client.rs
git commit -m "feat: add sandbox backend trait"
```

---

## Task 2: Route tools/artifacts/model-loop through backend trait

- [ ] **Step 1: Write failing artifact test expectation**

Update `bridges/cloud-agent-runner/tests/cloud_artifact_export.rs` to pass `Arc::new(LocalSandboxBackend::new(root.clone()))` to `export_sandbox_file` instead of `&LocalSandboxBackend`. Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_artifact_export -- --nocapture
```

Expected: type mismatch until artifact helper accepts trait handle.

- [ ] **Step 2: Update artifacts/tools/model-loop**

- `artifacts.rs`: accept `&SandboxBackendHandle`, call `read_bytes`, no local path assumption.
- `tools.rs`: `CloudToolExecutor { sandbox: SandboxBackendHandle }`.
- `model_loop.rs`: `run_model_loop(..., sandbox: &SandboxBackendHandle, ...)` and export helper uses handle.
- Tests wrap local backend in `Arc`.

- [ ] **Step 3: Run tests and commit**

```bash
rustfmt --edition 2021 bridges/cloud-agent-runner/src/artifacts.rs bridges/cloud-agent-runner/src/tools.rs bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/tests/cloud_artifact_export.rs bridges/cloud-agent-runner/tests/cloud_model_loop.rs
cargo test -p kordi-cloud-agent-runner
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/artifacts.rs bridges/cloud-agent-runner/src/tools.rs bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/tests/cloud_artifact_export.rs bridges/cloud-agent-runner/tests/cloud_model_loop.rs
git commit -m "refactor: use sandbox backend trait for runner tools"
```

---

## Task 3: K8s Job spec builder and fake command runner

- [ ] **Step 1: Write failing integration tests**

Create `bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs` with tests asserting:

```rust
#[test]
fn k8s_job_spec_is_restricted_and_mounts_only_sandbox_pvc() { /* inspect JSON */ }

#[tokio::test]
async fn k8s_backend_uses_fake_runner_without_touching_local_files() { /* fake runner records kubectl apply/logs/delete commands */ }
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_k8s_sandbox -- --nocapture
```

Expected: unresolved `k8s_sandbox` module.

- [ ] **Step 2: Implement `k8s_sandbox.rs`**

Add:

- `K8sSandboxConfig { namespace, image, ttl_seconds_after_finished }`
- `K8sSandboxOperation` enum
- `build_sandbox_job_spec(config, sandbox_id, operation) -> serde_json::Value`
- `K8sCommandRunner` async trait
- `KubectlCommandRunner`
- `K8sSandboxBackend<R>` implementing `SandboxBackend`

Keep command implementation minimal and fakeable. Use job spec labels:

```json
"app.kubernetes.io/name": "kordi-cloud-sandbox-executor",
"kordi.ai/sandbox-id": "<sandboxId>"
```

- [ ] **Step 3: Run tests and commit**

```bash
rustfmt --edition 2021 bridges/cloud-agent-runner/src/k8s_sandbox.rs bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs
cargo test -p kordi-cloud-agent-runner --test cloud_k8s_sandbox -- --nocapture
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/k8s_sandbox.rs bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs bridges/cloud-agent-runner/src/lib.rs
git commit -m "feat: add k8s sandbox job backend"
```

---

## Task 4: Runtime backend selection

- [ ] **Step 1: Write failing runtime tests**

In `runtime.rs` tests add:

```rust
#[test]
fn sandbox_backend_selection_defaults_to_local() { /* env removed => local */ }

#[tokio::test]
async fn k8s_backend_requires_sandbox_id() { /* KORDI_CLOUD_SANDBOX_BACKEND=k8s, run.sandbox_id=None => fail missing_sandbox */ }
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner runtime -- --nocapture
```

Expected: no backend selection function / no missing sandbox outcome.

- [ ] **Step 2: Implement selection**

Add:

```rust
pub enum SandboxBackendMode { Local, K8s }
pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode
pub fn sandbox_backend_for_run(run: &CloudAgentRun) -> Result<SandboxBackendHandle, RunnerClientError>
```

For k8s, require `sandbox_id`, create `K8sSandboxBackend::from_env(sandbox_id)` wrapped in `Arc`. On missing sandbox id, fail run with `missing_sandbox`.

- [ ] **Step 3: Run tests and commit**

```bash
rustfmt --edition 2021 bridges/cloud-agent-runner/src/runtime.rs
cargo test -p kordi-cloud-agent-runner runtime -- --nocapture
cargo test -p kordi-cloud-agent-runner
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/runtime.rs
git commit -m "feat: select k8s sandbox backend for cloud runner"
```

---

## Task 5: Manifests, verification, PR

- [ ] **Step 1: Update runner manifest safely**

Modify `cloud-agent-runner-deployment.yaml` to document but not enable:

```yaml
# Enable after #507 manual testing:
# - name: KORDI_CLOUD_SANDBOX_BACKEND
#   value: "k8s"
# - name: KORDI_CLOUD_SANDBOX_NAMESPACE
#   value: "kordi-cloud"
# - name: KORDI_CLOUD_SANDBOX_IMAGE
#   value: "alpine:3.20"
```

Add a service account with minimal future RBAC comments if needed, but do not apply live deployment.

- [ ] **Step 2: Local verification**

```bash
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/*.rs bridges/cloud-agent-runner/src/model_loop/*.rs bridges/cloud-agent-runner/tests/*.rs
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime
cargo test -p kordi-cloud-server presence
```

- [ ] **Step 3: Remote verification**

```bash
bridges/cloud-server/deploy/sync-and-build.sh
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command 'cd /home/shu_yang/kordi-cloud-server-deploy && $HOME/.cargo/bin/cargo test -p kordi-cloud-agent-runner'
```

If server files did not change, remote full server e2e is optional; if any server runtime files changed, run full `cloud_agent_runtime_e2e` as in #505.

- [ ] **Step 4: Create stacked draft PR**

```bash
git push -u origin feature/issue-507-cloud-k8s-sandbox-executor
gh pr create --draft --base feature/issue-505-cloud-runner-model-loop --head feature/issue-507-cloud-k8s-sandbox-executor --title "feat: add k8s cloud sandbox executor backend" --body-file /tmp/issue-507-k8s-sandbox-pr.md
```
