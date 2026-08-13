# Cloud Runner Canary Deployment Design

## Parent

- Parent issue: #479 offline Cloud agent fallback
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior stacked slice: #509/#510 K8s sandbox PVC lifecycle and smoke
- This slice: #511 Cloud runner manual canary deployment

## Goal

Add a safe, manual deployment path for the Cloud Agent Runner in K3s. The runner deployment must remain off by default and must not consume queued fallback runs unless an operator explicitly runs the canary script.

## Non-goals

- No always-on production runner.
- No automatic scaling to one replica during normal Cloud server deploy.
- No UI polish.
- No broad live user test automation.
- No merge before user testing.

## Design

### Runner image build script

Add `bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh`.

It mirrors the Cloud server image flow:

1. assumes `sync-and-build.sh` has synced source to example-cloud-host
2. builds `cargo build --release -p kordi-cloud-agent-runner` on the VM
3. builds an OCI image with Buildah using a runner runtime Dockerfile
4. imports the image into k3s containerd
5. applies the runner Deployment manifest with the new image tag
6. forces/keeps `spec.replicas: 0`
7. verifies the Deployment exists at zero replicas

### Runner runtime image

Add `bridges/cloud-agent-runner/Dockerfile.runtime` using the built runner binary from `target/release/kordi-cloud-agent-runner`. The image should contain enough runtime utilities for k8s backend execution:

- `/usr/local/bin/kordi-cloud-agent-runner`
- `kubectl` installed from distro package if available or copied from host image path if not
- CA certs

Keep the image minimal and non-privileged in intent. The runner process needs Kubernetes API access only through its ServiceAccount/RBAC.

### Runner manifest safety defaults

Update `cloud-agent-runner-deployment.yaml`:

- `replicas: 0`
- image default `kordi-cloud-agent-runner:dev`
- `KORDI_CLOUD_SANDBOX_BACKEND=k8s`
- `KORDI_CLOUD_SANDBOX_NAMESPACE=kordi-cloud`
- `KORDI_CLOUD_SANDBOX_IMAGE=alpine:3.20`
- runner token secret remains required
- add ServiceAccount/RBAC for runner to manage Jobs/PVCs only in `kordi-cloud`
- do not grant cluster-wide permissions

### Canary idle mode

Add `KORDI_CLOUD_RUNNER_CANARY_IDLE=1` as the manifest default. In idle mode the runner process validates required env/secret wiring, logs that canary idle mode is enabled, and sleeps without polling `/lease`. This makes the canary unable to accidentally consume queued fallback runs.

### Canary script

Add `bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh`.

The script should:

1. require explicit `CONFIRM_KORDI_RUNNER_CANARY=1`
2. run `k8s-sandbox-smoke.sh`
3. verify runner Deployment exists and has replicas 0 before starting
4. scale runner to 1 in `KORDI_CLOUD_RUNNER_CANARY_IDLE=1` mode
5. wait for rollout
6. show recent runner logs
7. scale runner back to 0 on exit via trap
8. verify final replicas are 0

This first canary is an infrastructure canary, not a live queue canary. It validates that the image starts and has the intended environment/RBAC without intentionally creating or consuming real fallback runs. A later user-approved slice can add a controlled provider-auth-backed queue canary that explicitly disables idle mode.

### Tests

Add script/manifest tests under `scripts/` or `bridges/cloud-agent-runner/tests` as appropriate:

- manifest defaults to `replicas: 0`
- manifest includes `KORDI_CLOUD_RUNNER_CANARY_IDLE=1`
- manifest includes `KORDI_CLOUD_SANDBOX_BACKEND=k8s`
- manifest contains ServiceAccount/RBAC scoped to namespace
- canary script refuses to run unless `CONFIRM_KORDI_RUNNER_CANARY=1`
- build script applies manifest with replicas 0

Run existing regression:

- `cargo test -p kordi-cloud-agent-runner`
- `cargo test -p kordi-cloud-server cloud_agent_runtime`
- `cargo test -p kordi-cloud-server presence`

Remote verification:

- build/import runner image on example-cloud-host
- apply Deployment at replicas 0
- run canary script with explicit confirmation
- verify final runner replicas 0
- run in-cluster health smoke

## Rollout

Keep the PR draft/stacked. The deployment path must be manual and off by default. Do not leave a runner replica running after verification.

## Self-review

- No placeholders.
- Focused on canary deployment only.
- Does not create live queue traffic.
- Keeps Cloud fallback runtime boundaries from prior slices.
