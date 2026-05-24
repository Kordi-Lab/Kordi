# Cloud Runner Canary Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual/off-by-default K3s canary deployment path for the Cloud Agent Runner.

**Architecture:** Build/import a dedicated runner image, apply the runner Deployment at zero replicas, and provide an explicit confirmation-gated canary script that scales to one replica temporarily and scales back to zero on exit. Tests verify scripts/manifests cannot accidentally enable live queue consumption.

**Tech Stack:** Bash, Kubernetes manifests, Buildah/k3s deploy flow, Node test scripts, existing Rust runner/server tests.

---

## Task 1: Manifest safety defaults and tests

**Files:**
- Modify: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml`
- Create: `scripts/cloud-runner-canary-deploy.test.mjs`

- [ ] **Step 1: Write failing manifest tests**

Create `scripts/cloud-runner-canary-deploy.test.mjs` using Node built-ins. Assert manifest text contains:

- `replicas: 0`
- `KORDI_CLOUD_SANDBOX_BACKEND` with value `k8s`
- `serviceAccountName: kordi-cloud-agent-runner`
- `kind: Role`
- `kind: RoleBinding`
- no `ClusterRole`

Run:

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Expected: fails because current manifest has replicas 1 and commented k8s env.

- [ ] **Step 2: Update manifest**

Update manifest:

- Deployment `spec.replicas: 0`
- add ServiceAccount, Role, RoleBinding documents
- set active env:
  - `KORDI_CLOUD_SANDBOX_BACKEND=k8s`
  - `KORDI_CLOUD_SANDBOX_NAMESPACE=kordi-cloud`
  - `KORDI_CLOUD_SANDBOX_IMAGE=alpine:3.20`
- keep poll interval and runner token
- keep resources modest

- [ ] **Step 3: Run tests and commit**

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Commit:

```bash
git add bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml scripts/cloud-runner-canary-deploy.test.mjs
git commit -m "feat: make cloud runner deployment canary-only"
```

---

## Task 2: Runner image build/deploy script

**Files:**
- Create: `bridges/cloud-agent-runner/Dockerfile.runtime`
- Create: `bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh`
- Modify: `scripts/cloud-runner-canary-deploy.test.mjs`

- [ ] **Step 1: Add failing script tests**

Extend test file to assert:

- deploy script exists
- deploy script builds `cargo build --release -p kordi-cloud-agent-runner`
- deploy script uses `buildah bud`
- deploy script imports image into k3s containerd
- deploy script applies manifest with image replacement
- deploy script runs `kubectl scale deployment/kordi-cloud-agent-runner --replicas=0` or equivalent zero-replica enforcement
- Dockerfile copies `target/release/kordi-cloud-agent-runner`

Run:

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Expected: fails because files do not exist.

- [ ] **Step 2: Implement Dockerfile and deploy script**

Dockerfile should install/carry runtime basics and run runner binary:

```Dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY target/release/kordi-cloud-agent-runner /usr/local/bin/kordi-cloud-agent-runner
ENTRYPOINT ["/usr/local/bin/kordi-cloud-agent-runner"]
```

Deploy script mirrors cloud server deploy script but builds/imports `kordi-cloud-agent-runner`, applies runner manifest image tag, then scales deployment to 0 and verifies replicas.

- [ ] **Step 3: Run tests and commit**

```bash
bash -n bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Commit:

```bash
git add bridges/cloud-agent-runner/Dockerfile.runtime bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh scripts/cloud-runner-canary-deploy.test.mjs
git commit -m "feat: add cloud runner image deploy script"
```

---

## Task 3: Confirmation-gated canary script

**Files:**
- Create: `bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh`
- Modify: `scripts/cloud-runner-canary-deploy.test.mjs`

- [ ] **Step 1: Add failing tests**

Extend Node tests to assert canary script:

- exists
- contains `CONFIRM_KORDI_RUNNER_CANARY`
- exits when confirmation is missing
- calls `k8s-sandbox-smoke.sh`
- scales runner to 1
- sets trap cleanup
- scales runner to 0

Run:

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Expected: fails because script does not exist.

- [ ] **Step 2: Implement canary script**

Script behavior:

- `set -euo pipefail`
- require `CONFIRM_KORDI_RUNNER_CANARY=1`
- default namespace `kordi-cloud`
- run `bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh`
- verify deployment exists and replicas are 0 before scaling
- trap scales deployment back to 0
- scale to 1, rollout status, print logs, scale back to 0, verify final zero

- [ ] **Step 3: Run tests and commit**

```bash
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Commit:

```bash
git add bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh scripts/cloud-runner-canary-deploy.test.mjs
git commit -m "test: add cloud runner canary script"
```

---

## Task 4: Verification and PR

- [ ] **Step 1: Local verification**

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
bash -n bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime
cargo test -p kordi-cloud-server presence
```

- [ ] **Step 2: Remote verification**

```bash
bridges/cloud-server/deploy/sync-and-build.sh
bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh
CONFIRM_KORDI_RUNNER_CANARY=1 bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh
```

Verify runner ends at zero replicas:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command 'kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath={.spec.replicas}'
```

- [ ] **Step 3: Draft PR**

```bash
git push -u origin feature/issue-511-cloud-runner-canary
gh pr create --draft --base feature/issue-509-cloud-k8s-sandbox-pvc-smoke --head feature/issue-511-cloud-runner-canary --title "feat: add manual cloud runner canary deployment" --body-file /tmp/issue-511-runner-canary-pr.md
```
