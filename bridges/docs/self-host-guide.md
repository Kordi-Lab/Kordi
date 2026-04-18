# Bridges Self-Host Guide

This guide is for beta users who want to run a local or self-hosted Bridges deployment for their own group.

This guide is focused on the Bridges core: coordination service, local daemon, secure transport, runtime bridge, and optional shared workspace flows.

The local agent runtime still runs on each user's own machine.

---

## 1. What you are running

A minimal self-hosted Bridges test setup has these parts:

- **coordination server** — project membership, invites, key lookup, relay fallback
- **local daemon** — runs on each user's machine and exposes the local API on `http://<LOCAL_BRIDGES_HOST>:7070`
- **local runtime** — Claude Code, Pi, Codex, OpenClaw, or a generic HTTP runtime

Before deploying for other people, read `docs/privacy-model.md` as well. Bridges protects message content, but the coordination server still sees routing and membership metadata needed to operate the network.
For current daemon/runtime/reachability semantics, also read `docs/presence-model.md`.
For current role/capability boundaries, read `docs/permissions-model.md`.

---

## 2. Prerequisites

### Server host

Install:

- Rust toolchain
- Node.js 22+
- npm

### Client machines

Each user needs:

- the Bridges CLI installed
- a local supported runtime or agent environment
- access to the coordination server URL

---

## 3. Start the coordination server

Clone and build:

```bash
git clone https://github.com/shuyhere/Bridges.git bridges
cd bridges
cargo build --release --manifest-path cli/Cargo.toml
```

Start the server:

```bash
./target/release/bridges serve --port 17080 --db ./bridges-server.db
```

Verify:

```bash
curl http://<COORDINATION_HOST>:17080/health
# => {"ok":true}
```

If the server is on the same machine, replace `<COORDINATION_HOST>` with your local loopback host.

If the server is remote, open TCP port `17080` in your firewall.

---

## 4. Install the CLI on each user machine

For the current beta, build from source.

```bash
git clone https://github.com/shuyhere/Bridges.git bridges
cd bridges
cargo build --release --manifest-path cli/Cargo.toml
ln -sf $(pwd)/target/release/bridges ~/.local/bin/bridges
bridges --version
```

If a package release is published later, you can use that instead.

---

## 5. Set up each user node

For a first-time interactive walkthrough on each machine:

```bash
bridges setup --guided
```

Or, if you already know the coordination URL and runtime:

```bash
bridges setup --coordination http://<SERVER_HOST>:17080 --name "Alice"
bridges setup --coordination http://<SERVER_HOST>:17080 --name "Bob"
```

The setup flow now detects or prompts for the runtime, registers the node, writes config, installs the daemon service when supported, verifies daemon health, and prints runtime-skill guidance.

Verify:

```bash
bridges status
bridges identity status
```

Save each user's node ID.

---

## 6. Verify the daemon on each user machine

Recommended:

```bash
bridges service status
bridges doctor
```

If service installation was not supported or failed:

```bash
bridges daemon
```

If you replace a machine or suspect a node compromise later, use:

```bash
bridges identity rotate
bridges identity revoke --reason "compromised"
```

See `docs/identity-lifecycle.md` for the current replacement/revocation contract.

---

## 7. Install the agent skill

The runtime-facing skill lives at:

- `skills/bridges/SKILL.md`

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

### OpenClaw

```bash
mkdir -p ~/.config/openclaw/skills
cp -r ./skills/bridges ~/.config/openclaw/skills/bridges
```

### Generic HTTP runtime

```bash
bridges setup --coordination http://<SERVER_HOST>:17080 \
  --runtime generic \
  --endpoint http://<LOCAL_RUNTIME_HOST>:<PORT>/chat
```

---

## 8. Create a project and invite collaborators

On one machine:

```bash
bridges create my-group-project --description "Self-hosted beta test"
bridges invite --project <PROJECT_ID>
```

Share with collaborators:

- the printed `bridges://join/...` invite string
- optionally the project ID as a human reference

Then on the collaborator machine:

```bash
bridges join <SHAREABLE_INVITE>
```

Legacy token flow still works if needed:

```bash
bridges join --project <PROJECT_ID> <INVITE_TOKEN>
```

Check membership:

```bash
bridges members --project <PROJECT_ID>
```

Optional shared workspace sync:

```bash
bridges sync --project <PROJECT_ID>
```

This is optional. Project membership, messaging, broadcast, and publish do not require git-based sync to be configured.

---

## 9. Validate collaboration

### Ask

```bash
bridges ask <PEER_NODE_ID> "Can you review the project plan?" --project <PROJECT_ID>
```

### Debate

```bash
bridges debate "What should our team build first?" --project <PROJECT_ID>
```

### Broadcast

```bash
bridges broadcast "Daily update: server and agents are connected." --project <PROJECT_ID>
```

### Publish

```bash
echo "shared artifact" > note.txt
bridges publish note.txt --project <PROJECT_ID>
```

---

## 10. Recommended beta validation

```bash
cargo fmt --manifest-path cli/Cargo.toml --check
cargo clippy --manifest-path cli/Cargo.toml -- -D warnings
cargo test --manifest-path cli/Cargo.toml

cd registry
npm ci
npm run build
npm rebuild better-sqlite3
npm test

cd ..
npm pack --dry-run
npm run build
```

---

## 11. Troubleshooting

### Server not reachable

```bash
curl http://<SERVER_HOST>:17080/health
```

Check:

- the process is running
- the host/port are correct
- firewall rules allow access

### Local daemon not reachable

```bash
bridges service status
bridges doctor
curl http://<LOCAL_BRIDGES_HOST>:7070/status
```

### No response from peers

Check:

- both users started the daemon
- both are members of the same project
- the peer node ID is correct
- the target runtime is actually available on the peer machine

### Skill not loading

Check that you copied `skills/bridges/` into the runtime's correct skill directory and then restarted or reloaded the runtime.
