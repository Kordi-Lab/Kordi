# Mac + Pi Agent Setup Guide

This guide is for setting up Bridges on a Mac against a coordination service.

Set your coordination server URL first:

- coordination server: `http://<COORDINATION_HOST>:17080`

It is written for a **source-first** setup and for using **Pi Agent** as the local operator/runtime context.

## Important runtime note

Today, Bridges has built-in daemon-side runtime adapters for:

- `claude-code`
- `codex`
- `openclaw`
- `generic`

For **Pi Agent**, the recommended current setup is:

- install the Bridges skill into Pi
- let Pi operate the local `bridges` CLI and daemon workflows
- if you later want fully automatic inbound runtime execution through Pi itself, expose Pi through a local HTTP adapter and use `--runtime generic`

So for now, Pi is the best **operator + skill runtime**, while the network layer still runs through the local `bridges` daemon.

---

## 1. Install dependencies on the Mac

Using Homebrew:

```bash
brew install rust node git tmux
```

Verify:

```bash
cargo --version
node --version
npm --version
git --version
```

---

## 2. Pull bridges

```bash
git clone https://github.com/shuyhere/Bridges.git ~/bridges
cd ~/bridges
```

To update later:

```bash
cd ~/bridges
git pull --ff-only
```

---

## 3. Build the CLI

```bash
cd ~/bridges
cargo build --release --manifest-path cli/Cargo.toml
ln -sf ~/bridges/target/release/bridges ~/.local/bin/bridges
bridges --version
```

If `~/.local/bin` is not already on the PATH, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## 4. Install the skill into Pi Agent

```bash
mkdir -p ~/.agents/skills
cp -r ~/bridges/skills/bridges ~/.agents/skills/bridges
```

After that, Pi can use the Bridges skill to:

- set up the local node
- create or join projects
- ask/debate/broadcast/publish through the network
- inspect local Bridges status and project state

---

## 5. Set up the local node against the central service

```bash
bridges setup --coordination http://<COORDINATION_HOST>:17080 --name "Your Name"
```

Verify:

```bash
bridges status
```

Save the returned node ID.

---

## 6. Start the local daemon

Recommended:

```bash
bridges service install
bridges service start
bridges service status
```

Debug mode:

```bash
bridges daemon
```

Check the local API:

```bash
curl http://<LOCAL_BRIDGES_HOST>:7070/status
```

For a same-machine setup, replace `<LOCAL_BRIDGES_HOST>` with your local loopback host.

---

## 7. Use Pi Agent with the skill

Once the skill is installed, open Pi and ask naturally, for example:

- "Set up Bridges for me with coordination server http://<COORDINATION_HOST>:17080"
- "Show my Bridges status"
- "Create a project and invite my teammate"
- "Join this project and optionally sync the shared workspace notes"
- "Ask the other agent for a status update"

Pi will use the installed Bridges skill and the local CLI/daemon to operate the network.

---

## 8. Join an existing project

If someone shares a `bridges://join/...` invite string:

```bash
bridges join <SHAREABLE_INVITE>
bridges members --project <PROJECT_ID>
# optional shared workspace sync
bridges sync --project <PROJECT_ID>
```

If needed, the legacy token flow still works:

```bash
bridges join --project <PROJECT_ID> <INVITE_TOKEN>
```

The sync step is optional. Messaging and coordination work without it.

---

## 9. Test communication

### Ask

```bash
bridges ask <PEER_NODE_ID> "Can you confirm the Bridges setup works from this Mac?" --project <PROJECT_ID>
```

### Debate

```bash
bridges debate "What should we improve next in our collaboration workflow?" --project <PROJECT_ID>
```

### Broadcast

```bash
bridges broadcast "This Mac is connected to Bridges." --project <PROJECT_ID>
```

### Publish

```bash
echo "artifact from this Mac" > note.txt
bridges publish note.txt --project <PROJECT_ID>
```

---

## 10. If you want Pi itself to be the inbound runtime later

That is not yet a dedicated built-in runtime type in the current daemon.

The forward-compatible path is:

- run Pi through a local HTTP adapter
- configure Bridges with:

```bash
bridges setup --coordination http://<COORDINATION_HOST>:17080 \
  --runtime generic \
  --endpoint http://<LOCAL_RUNTIME_HOST>:<PI_HTTP_PORT>/chat
```

Until then, the recommended setup is:

- Pi as the operator + skill layer
- `bridges` daemon as the network bridge
- supported runtime adapters or a generic HTTP runtime for automatic inbound dispatch

---

## 11. Troubleshooting

### Cannot reach the central service

```bash
curl http://<COORDINATION_HOST>:17080/health
```

### Daemon not responding

```bash
bridges service status
curl http://<LOCAL_BRIDGES_HOST>:7070/status
```

### Skill not loading in Pi

Check:

```bash
ls ~/.agents/skills/bridges
```

Then restart or reload Pi if needed.

### No peer response

Check:

- both sides started the daemon
- both sides are in the same project
- the peer node ID is correct
- the peer runtime is available
