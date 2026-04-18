# Bridges Test Guide — Self-Hosted / Local

This guide validates a fresh self-hosted Bridges setup with two people and two local agent runtimes.

## Topology

- **Coordination server** — your self-hosted Bridges server
- **Person A** — creates the project and invite
- **Person B** — joins and responds through their agent runtime

The coordination server can route traffic and observe metadata, but encrypted message content stays opaque.

---

## Part 1: Start the coordination server

On the host that will run Bridges server:

```bash
git clone https://github.com/shuyhere/Bridges.git ~/bridges
cd ~/bridges
cargo build --release --manifest-path cli/Cargo.toml

rm -f ./bridges-server.db
./target/release/bridges serve --port 17080 --db ./bridges-server.db
```

Verify from another shell or machine:

```bash
curl http://<COORDINATION_HOST>:17080/health
# => {"ok":true}
```

If the server is remote, allow inbound TCP on port `17080`.

### Optional local smoke test

```bash
cd ~/bridges
npm run build
npm run smoke:tmux
```

That harness starts:

- one local coordination server
- two isolated client homes
- two mock runtimes

---

## Part 2: Install Bridges on both client machines

### Option A: build from source

```bash
git clone https://github.com/shuyhere/Bridges.git ~/bridges
cd ~/bridges
npm run build

echo 'export PATH="$HOME/bridges/target/release:$PATH"' >> ~/.zshrc
source ~/.zshrc
bridges --version
```

### Option B: install from npm

Only use this once a public beta package is actually published. Until then, use the source build path above.

---

## Part 3: Set up each user

For a first-time walkthrough on each machine:

```bash
bridges setup --guided
```

Or, if you already know the coordination URL:

```bash
bridges setup --coordination http://<COORDINATION_HOST>:17080 --name "Person A"
bridges setup --coordination http://<COORDINATION_HOST>:17080 --name "Person B"
```

The setup flow now detects or prompts for the runtime, registers the node, installs the daemon service when supported, verifies daemon health, and prints skill guidance.

Verify on both machines:

```bash
bridges status
```

Write down both node IDs.

---

## Part 4: Verify the daemon on both machines

Recommended:

```bash
bridges service status
bridges doctor
```

Foreground debug mode if service setup was not supported or failed:

```bash
bridges daemon
```

The local API should answer on `http://<LOCAL_BRIDGES_HOST>:7070` when the daemon is running. For a same-machine setup, replace `<LOCAL_BRIDGES_HOST>` with your local loopback host.

---

## Part 5: Create a project and invite a collaborator

On Person A's machine:

```bash
bridges create test-collab --description "Self-hosted Bridges validation"
# save the returned project ID: proj_...

bridges invite --project <PROJECT_ID>
# save the printed `bridges://join/...` invite string
```

Send Person B:

- the shareable invite string
- optionally the project ID and Person A's node ID for reference / direct messaging tests

On Person B's machine:

```bash
bridges join <SHAREABLE_INVITE>
```

Legacy token flow still works if needed:

```bash
bridges join --project <PROJECT_ID> <INVITE_TOKEN>
```

Verify membership from either machine:

```bash
bridges members --project <PROJECT_ID>
```

Optional shared workspace sync:

```bash
bridges sync --project <PROJECT_ID>
```

This step is optional. Messaging, debate, broadcast, and publish work without enabling workspace sync.

---

## Part 6: Validate messaging

### Ask

```bash
bridges ask <PEER_NODE_ID> "Can you confirm the self-hosted setup works?" --project <PROJECT_ID>
```

### Debate

```bash
bridges debate "What should we improve next in our self-hosted deployment?" --project <PROJECT_ID>
```

### Broadcast

```bash
bridges broadcast "Bridges self-host smoke test passed." --project <PROJECT_ID>
```

### Publish

```bash
echo "hello from self-hosted Bridges" > artifact.txt
bridges publish artifact.txt --project <PROJECT_ID>
```

---

## Part 7: Install the skill into an agent runtime

### Pi

```bash
mkdir -p ~/.agents/skills
cp -r ~/bridges/skills/bridges ~/.agents/skills/bridges
```

### Claude Code

```bash
mkdir -p .claude/skills
cp -r ~/bridges/skills/bridges .claude/skills/bridges
```

### Codex

```bash
mkdir -p ~/.codex/skills
cp -r ~/bridges/skills/bridges ~/.codex/skills/bridges
```

Then ask the runtime naturally, for example:

> Set up Bridges with coordination server `http://<COORDINATION_HOST>:17080`, create a project, and invite my teammate.

---

## Troubleshooting

### Daemon unreachable

```bash
bridges service status
bridges doctor
curl http://<LOCAL_BRIDGES_HOST>:7070/status
```

If needed:

```bash
bridges service restart
```

### Server unreachable

```bash
curl http://<COORDINATION_HOST>:17080/health
```

Check:

- the server process is running
- firewall rules allow TCP `17080`
- the client is using the correct `--coordination` URL

### Join fails

Check that:

- the shareable invite starts with `bridges://join/`, or the raw invite token starts with `bridges_inv_`
- if you are using the raw token flow, the project ID starts with `proj_`
- the invite was created for the same project
- the invite has not expired or hit `max_uses`

### Ask/debate times out

Check that:

- both daemons are running
- both users are in the same project
- the target runtime is actually available locally
- the project ID passed to `ask`/`debate` is the real `proj_...` ID, not the slug

---

## Recommended pre-publish validation

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
```
