# Cloud Runner Real-Provider Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a manual Cloud runner canary using the operator's existing local provider auth and verify a real model completion in K3s.

**Architecture:** Add a local auth payload helper, add OpenAI OAuth/Codex streaming support to the cloud runner provider path, and add a local operator script that publishes the local auth snapshot through Cloud server before running one scoped canary run.

**Tech Stack:** Rust, Bash, Python stdlib on takotako, kubectl, Postgres, OpenAI/Codex-compatible OAuth backend.

---

## Files

- Modify: `bridges/cloud-agent-runner/Cargo.toml`
- Create: `bridges/cloud-agent-runner/src/bin/cloud_provider_auth_snapshot_payload.rs`
- Modify: `bridges/cloud-agent-runner/src/model_loop/provider.rs`
- Create: `bridges/cloud-agent-runner/scripts/k8s-runner-real-provider-canary.sh`
- Modify: `scripts/cloud-runner-canary-deploy.test.mjs`

## Tasks

1. Add helper binary that resolves local auth and emits snapshot JSON.
2. Add runner provider support for `apiMode=openai-codex-oauth` SSE final text.
3. Add local operator real-provider canary script.
4. Verify locally and remotely, then open a draft stacked PR.

## Verification commands

Run after implementation:

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-real-provider-canary.sh
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/bin/cloud_provider_auth_snapshot_payload.rs bridges/cloud-agent-runner/src/model_loop/provider.rs
cargo test -p kordi-cloud-agent-runner
```

Remote real canary:

```bash
CONFIRM_KORDI_RUNNER_REAL_PROVIDER_CANARY=1 bridges/cloud-agent-runner/scripts/k8s-runner-real-provider-canary.sh
```

Expected remote output:

- provider snapshot published for controlled owner
- run reaches `completed`
- response message id is non-empty
- runner replicas end at `0`
- no runner pods remain
