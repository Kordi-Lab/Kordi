# Bridges E2E Test Guide

Use this guide to validate encrypted agent-to-agent communication between two machines against a self-hosted Bridges coordination server.

## Test matrix

- **Server**: `http://<COORDINATION_HOST>:17080`
- **Machine A**: one user + local agent runtime
- **Machine B**: another user + local agent runtime

---

## 1. Install Bridges on both machines

Build from source for the current beta:

```bash
git clone https://github.com/shuyhere/Bridges.git bridges
cd bridges
cargo build --release --manifest-path cli/Cargo.toml
ln -sf $(pwd)/target/release/bridges ~/.local/bin/bridges
bridges --version
```

If a package release is published later, you can install from npm instead.

---

## 2. Set up each machine

```bash
bridges setup --coordination http://<COORDINATION_HOST>:17080 --name "Machine A"
bridges setup --coordination http://<COORDINATION_HOST>:17080 --name "Machine B"
```

Verify:

```bash
bridges status
```

Save both node IDs.

---

## 3. Create and join a project

On Machine A:

```bash
bridges create test-collab --description "E2E encrypted communication test"
bridges invite --project <PROJECT_ID>
```

Send Machine B:

- the printed `<SHAREABLE_INVITE>` string (`bridges://join/...`)
- optionally `<PROJECT_ID>` for reference

On Machine B:

```bash
bridges join <SHAREABLE_INVITE>
```

Legacy token flow still works if needed:

```bash
bridges join --project <PROJECT_ID> <INVITE_TOKEN>
```

Verify from either side:

```bash
bridges members --project <PROJECT_ID>
```

Optional shared workspace sync:

```bash
bridges sync --project <PROJECT_ID>
```

This is optional. The encrypted messaging path does not depend on git-based workspace sync.

---

## 4. Start the daemon on both machines

```bash
bridges service install
bridges service start
bridges service status
```

Or run in the foreground:

```bash
bridges daemon
```

---

## 5. Validate encrypted collaboration

### Machine A asks Machine B

```bash
bridges ask <NODE_ID_B> "Hello from Machine A. Can you confirm receipt?" --project <PROJECT_ID>
```

### Machine B asks Machine A

```bash
bridges ask <NODE_ID_A> "Machine B here. Can you read this encrypted message?" --project <PROJECT_ID>
```

### Debate

```bash
bridges debate "What is the next improvement for our self-hosted Bridges stack?" --project <PROJECT_ID>
```

### Broadcast

```bash
bridges broadcast "E2E validation passed." --project <PROJECT_ID>
```

### Publish

```bash
echo "artifact from machine A" > artifact.txt
bridges publish artifact.txt --project <PROJECT_ID>
```

---

## 6. Validate skill-based workflows

Install the Bridges skill into your preferred runtime.

### Pi

```bash
mkdir -p ~/.agents/skills
cp -r ./skills/bridges ~/.agents/skills/bridges
```

### Claude Code

```bash
mkdir -p .claude/skills
cp -r ./skills/bridges .claude/skills/bridges
```

### Codex

```bash
mkdir -p ~/.codex/skills
cp -r ./skills/bridges ~/.codex/skills/bridges
```

Example prompt:

> Set up Bridges with `http://<COORDINATION_HOST>:17080`, create a project, invite my collaborator, and ask their agent for a status update.

---

## Under the hood

```text
Machine A daemon           Coordination server           Machine B daemon
┌──────────────┐           ┌──────────────────┐          ┌──────────────┐
│ encrypt msg  │  opaque   │ route/store blob │  opaque  │ decrypt msg  │
│ locally      │ ───────▶  │ cannot read body │ ───────▶ │ locally      │
│              │           │                  │          │              │
│ receive resp │ ◀───────  │ relay response   │ ◀─────── │ send resp    │
└──────────────┘           └──────────────────┘          └──────────────┘
```

- encryption uses Noise-based transport
- coordination handles membership, key lookup, invites, relay fallback, and metadata routing
- local runtimes process messages on each user's own machine

---

## Troubleshooting

### `Daemon unreachable`

```bash
bridges service status
curl http://<LOCAL_BRIDGES_HOST>:7070/status
```

### `Server unreachable`

```bash
curl http://<COORDINATION_HOST>:17080/health
```

### No response from peer

Check:

- both machines have a running daemon
- both users joined the same project
- the peer node ID is correct
- the target runtime is available locally

### Publish or ask fails immediately

Check:

- required fields are non-empty
- the project ID is a real `proj_...` ID
- the daemon is on a version that includes local API request validation and proper error handling
