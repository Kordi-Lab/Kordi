# Cloud K8s Sandbox Executor Design

## Parent

- Parent issue: #479 offline Cloud agent fallback
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior stacked slice: #505/#506 real Cloud runner model loop
- This slice: #507 Cloud sandbox executor pods

## Goal

Move Cloud fallback tool execution from a runner-local filesystem backend toward a hosted Kubernetes sandbox backend. The runner should be able to select a K8s backend that executes sandbox-local read/write/list/bash operations inside restricted pods using a workspace volume mounted at `/workspace`.

## Non-goals

- Do not deploy the runner as a live queue consumer yet.
- Do not build a long-lived sandbox controller/operator.
- Do not grant runner access to owner-local files, owner-local services, private networks, or other users' data.
- Do not implement approval prompts.
- Do not replace server sandbox metadata/TTL/quota tables; this slice consumes `sandboxId` and prepares executor isolation.

## Architecture

### Runner backend abstraction

Add a focused sandbox backend trait in `bridges/cloud-agent-runner/src/sandbox_client.rs`:

- `resolve_path` / path validation remains fail-closed.
- `read_text(path)`
- `write_text(path, content)`
- `list(path)`
- `run_bash(command)`
- `read_bytes(path)` for artifact export

The existing local backend implements the trait and remains the default for tests/dev.

### K8s backend MVP

Add `bridges/cloud-agent-runner/src/k8s_sandbox.rs` with two layers:

1. **Pure spec builder**
   - Builds a Kubernetes Job spec as JSON for one sandbox operation.
   - Uses namespace `KORDI_CLOUD_SANDBOX_NAMESPACE` default `kordi-cloud`.
   - Uses image `KORDI_CLOUD_SANDBOX_IMAGE` default `alpine:3.20`.
   - Mounts one PVC named `kordi-cloud-sandbox-<safe-sandbox-id>` at `/workspace`.
   - Runs as non-root, non-privileged, read-only root filesystem where compatible.
   - Sets `automountServiceAccountToken: false`.
   - Uses `restartPolicy: Never` and TTL after finish.

2. **Command executor adapter**
   - In this MVP, shell out to `kubectl` through an injected command runner interface.
   - This avoids adding a large K8s client dependency in the first slice.
   - Tests use a fake command runner and inspect generated specs/commands.
   - Future slice can replace this with the Kubernetes API client without changing tool/model code.

Operations are implemented by generating a safe command that runs inside `/workspace`:

- `read_text`: `cat -- <path>`
- `write_text`: write base64-decoded content to path after creating parent dirs
- `list`: `find` or `ls` inside path
- `run_bash`: execute `/bin/sh -lc <command>` with existing policy/path checks already applied
- `read_bytes`: base64 output for artifact helper

### Runtime backend selection

Add backend selection in runner runtime:

- `KORDI_CLOUD_SANDBOX_BACKEND=local|k8s`
- default `local`
- local root remains `KORDI_CLOUD_SANDBOX_ROOT` or temp dir
- k8s requires `run.sandbox_id`; missing sandbox id fails the run with `missing_sandbox`

### Tool/executor integration

`CloudToolExecutor` should depend on a backend trait object/generic instead of directly owning `LocalSandboxBackend`. Model-loop code should call the same executor API. Artifact export should accept the backend trait and use `read_bytes` instead of assuming a local path.

### Safety

- Runner policy gate remains the first line of defense.
- Backend path validation still rejects absolute paths, traversal, `/Users/*`, `/home/*`, and `~/*`.
- K8s Job spec must not include `hostPath`, privileged containers, host networking, or service account token mount.
- K8s backend works only with safe `sandboxId` values and safe PVC names.
- Network policy manifest is added for sandbox pods with labels that can be tightened later. The MVP labels sandbox jobs distinctly and documents the intended egress restriction.

## Tests

### Red/green unit tests

- Existing local backend tests still pass.
- Backend path validation rejects traversal and owner-local paths.
- Backend selection defaults to local.
- K8s backend selection requires `sandboxId`.
- K8s Job spec test asserts:
  - namespace is `kordi-cloud`
  - volume is a PVC for the sandbox id
  - mount path is `/workspace`
  - `runAsNonRoot: true`
  - `privileged: false` or omitted false
  - `automountServiceAccountToken: false`
  - no `hostPath`
- K8s fake command runner test asserts read/write/list/bash build expected operations without touching runner-local files.
- Artifact export can read bytes through backend trait.

### Regression tests

- `cargo test -p kordi-cloud-agent-runner`
- `cargo test -p kordi-cloud-server cloud_agent_runtime`
- `cargo test -p kordi-cloud-server presence`
- Remote example-cloud-host runner tests.
- Remote cloud runtime e2e if server files change.

## Rollout

Keep the default backend as `local`. Add K8s manifests/RBAC for future deployment, but do not apply a live runner deployment in this slice. After manual testing, a later slice can canary deploy runner pods with `KORDI_CLOUD_SANDBOX_BACKEND=k8s`.

## Self-review

- No placeholders.
- Focused on executor backend, not live runner rollout.
- Keeps existing Cloud sandbox policy and metadata boundaries.
- Provides testable progress before a full Kubernetes client/operator.
