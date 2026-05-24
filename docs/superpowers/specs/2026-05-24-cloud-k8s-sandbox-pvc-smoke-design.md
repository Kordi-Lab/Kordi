# Cloud K8s Sandbox PVC Lifecycle and Smoke Design

## Parent

- Parent issue: #479 offline Cloud agent fallback
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior stacked slice: #507/#508 K8s sandbox executor backend
- This slice: #509 K8s sandbox PVC lifecycle and smoke

## Goal

Make the K8s sandbox backend practically usable in the cluster by ensuring each `sandboxId` has a Kubernetes PersistentVolumeClaim before sandbox Jobs run, and by adding a manual smoke script that validates real write/read/bash execution in K3s without deploying the runner as a live queue consumer.

## Non-goals

- No live runner deployment or canary rollout.
- No server-side PVC controller/operator.
- No automatic deletion of active sandbox PVCs.
- No change to Cloud server sandbox metadata schema.
- No owner-local/private-network access and no approval prompts.

## Design

### PVC spec builder

Extend `bridges/cloud-agent-runner/src/k8s_sandbox/job_spec.rs` with `build_sandbox_pvc_spec(config, sandbox_id) -> serde_json::Value`.

The PVC must:

- use namespace from `K8sSandboxConfig` (`kordi-cloud` by default)
- use safe name `kordi-cloud-sandbox-<safe-sandbox-id>`
- label with:
  - `app.kubernetes.io/name: kordi-cloud-sandbox-workspace`
  - `kordi.ai/sandbox-id: <sandboxId>`
- request storage from `KORDI_CLOUD_SANDBOX_STORAGE_REQUEST`, default `512Mi`
- use `ReadWriteOnce`
- avoid hostPath or privileged configuration because PVCs only declare storage claims

### PVC ensure before Job execution

Extend `K8sCommandRunner` with `ensure_pvc(namespace, pvc_name, pvc_spec)`. `K8sSandboxBackend::run_operation` calls `ensure_pvc` before `run_json_job`.

`KubectlCommandRunner::ensure_pvc` uses:

```bash
kubectl -n <namespace> apply -f -
```

This is idempotent, so every operation can safely ensure the PVC before the Job.

### Manual smoke script

Add `bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh`.

The script should:

1. accept optional env:
   - `KORDI_CLOUD_SANDBOX_NAMESPACE` default `kordi-cloud`
   - `KORDI_CLOUD_SANDBOX_ID` default random-ish `cas-smoke-<timestamp>`
   - `KORDI_CLOUD_SANDBOX_IMAGE` default `alpine:3.20`
2. create/apply a PVC manifest for the sandbox
3. run a write Job to create `/workspace/smoke/hello.txt`
4. run a read Job and assert output equals `hello from k8s sandbox`
5. run a bash Job inside `/workspace` and assert output
6. inspect generated/running specs for no hostPath and no privileged container
7. delete smoke Jobs and PVC unless `KEEP_KORDI_SANDBOX_SMOKE=1`

The smoke script is intentionally manual. It proves the backend shape works in K3s without enabling the runner Deployment.

## Tests

- Unit/integration tests in `bridges/cloud-agent-runner/tests/cloud_k8s_sandbox.rs`:
  - PVC spec has safe namespace/name/labels/storage request/access mode.
  - K8s backend fake runner records `pvc` before `job` for every operation.
  - Bad sandbox ids are sanitized in PVC names.
- Regression tests:
  - `cargo test -p kordi-cloud-agent-runner`
  - `cargo test -p kordi-cloud-server cloud_agent_runtime`
  - `cargo test -p kordi-cloud-server presence`
- Remote verification:
  - takotako `cargo test -p kordi-cloud-agent-runner`
  - manual smoke script against K3s namespace `kordi-cloud`
  - in-cluster health smoke

## Rollout

Keep runner backend default as `local`. Do not enable K8s backend in Deployment. After smoke passes and user tests stacked PRs, the next slice can be a runner canary deployment with `KORDI_CLOUD_SANDBOX_BACKEND=k8s`.

## Self-review

- No placeholders.
- Focused on PVC lifecycle/smoke only.
- Does not deploy live runner.
- Maintains sandbox and provider-auth boundaries.
