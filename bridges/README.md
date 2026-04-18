# Bridges

Bridges is a human-agent and agent-agent collaboration infrastructure. Its architecture is organized around a small set of core components that enable secure discovery, communication, coordination, and collaboration among independently running agents such as Claude Code, Codex, OpenClaw, Pi Agent, BB-Agent, and other compatible systems across different users.

If you also feel the struggle in today’s collaboration workflow that:

- when I reach out to someone, they need to ask their agent about the detailed work because they have already vibed through a lot of things with it, and then return the agent’s message to me
- or sometimes you may think: why don’t they just reach out to my agent, and why can’t I directly talk to their agent 24/7?
- when I need to work with an external service or business process, why can’t my agent coordinate directly with the other side’s agent for me?
- when we want to schedule a meeting, why not just let the agents do the negotiation if they already have enough information about my schedule and preferences?

Bridges is what you need!

## What ships in this repo

- `cli/` — main Rust CLI, daemon, coordination server, auth/server APIs, and optional shared-workspace sync helpers
- `registry/` — standalone TypeScript registry service
- `skills/bridges/` — reusable Bridges skill files for agent runtimes
- `docker/` — local/container build assets
- `docs/` — test and setup guides

## Public repo status

This public repo is currently set up to support:

- source-based self-hosting for early users
- agent-skill installation for Claude Code, Pi, Codex, OpenClaw, and custom runtimes
- CI validation for Rust, TypeScript, registry tests, and binary smoke checks
- future package/binary distribution when you explicitly choose to enable it

> Binary and npm release are intentionally disabled for general users right now. Build from source and configure the agent runtime locally.

## Configure your agent runtime to use the bridge network

The main integration asset is:

- `skills/bridges/SKILL.md`

The goal is to configure the runtime once, then let people talk to their agent naturally instead of memorizing Bridges CLI commands themselves.

After the skill is installed, a user should be able to say things like:

- "Set up Bridges with my coordination server"
- "Create a project and invite my teammate"
- "Ask the other agent to review this plan"

### Claude Code

From a local source checkout:

```bash
mkdir -p .claude/skills
cp -r ./skills/bridges .claude/skills/bridges
```

If a package release exists later, you can also copy from the installed npm package.

### Pi

```bash
mkdir -p ~/.agents/skills
cp -r ./skills/bridges ~/.agents/skills/bridges
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

### Any custom agent runtime

If your runtime supports instruction files, prompts, tools, or skill folders, copy:

- `skills/bridges/SKILL.md`
- optional helpers under `skills/bridges/references/`, `tools/`, and `templates/`

For HTTP-based runtimes, configure Bridges to call the local runtime endpoint:

```bash
bridges setup --coordination <COORDINATION_URL> \
  --runtime generic --endpoint http://<LOCAL_RUNTIME_HOST>:<PORT>/chat
```

## Quick start: local self-hosted Bridges

### 1. Build the CLI

```bash
git clone https://github.com/shuyhere/Bridges.git bridges
cd bridges
cargo build --release --manifest-path cli/Cargo.toml
./target/release/bridges --version
```

### 2. Start a local coordination server

```bash
./target/release/bridges serve --port 17080 --db ./bridges-server.db
```

Verify:

```bash
curl http://<COORDINATION_HOST>:17080/health
# => {"ok":true}
```

If the coordination server is running on the same machine, replace `<COORDINATION_HOST>` with your local loopback host.

### 3. Set up a local node

For a first-time interactive walkthrough:

```bash
bridges setup --guided
```

Or, if you already know the coordination URL:

```bash
bridges setup --coordination http://<COORDINATION_HOST>:17080
```

`bridges setup` now guides runtime selection when needed, registers the node, writes config, installs the daemon service when supported, verifies local daemon health, and prints skill-install guidance.

### 4. Verify the daemon

```bash
bridges service status
bridges doctor
```

If service installation was not supported or failed, you can still run the daemon manually:

```bash
bridges daemon
```

### 5. Create and use a project

```bash
bridges create my-project --description "Local self-hosted test"
bridges invite --project <proj_id>
# share the printed `bridges://join/...` string with collaborators
bridges join <shareable_invite>
bridges members --project <proj_id>
bridges ask <peer_node_id> "What should we build first?" --project <proj_id>
# optional: sync shared workspace notes under .shared/
bridges sync --project <proj_id>
```

## Security and sensitive-data notes

Bridges is designed so that:

- node private keys stay local
- encrypted message content is not readable by the coordination server
- optional shared workspace sync can exchange `.shared/` files through git-compatible workflows without making git hosting part of the core network requirement
- token-based registry routes validate ownership and membership before mutating data

Bridges is **content-private, not metadata-private**:

- the coordination service can still see the metadata it needs for registration, project membership, key lookup, endpoint lookup, DERP relay, and mailbox routing
- project membership and sender/receiver routing relationships are not hidden from the coordination operator
- mailbox entries are durable until fetched, then deleted
- endpoint publication reveals reachability information to authorized peers

See `docs/core-architecture.md` for the canonical Bridges system overview and component map.
See `docs/privacy-model.md` for the current privacy contract, retention model, and non-guarantees.
See `docs/presence-model.md` for the current daemon/runtime/reachability status model.
See `docs/permissions-model.md` for the current project role and capability model.
See `docs/addressing-model.md` for the current human-friendly peer selector rules.
See `docs/identity-lifecycle.md` for the current key rotation, replacement, and revocation model.

Before publishing or deploying, verify that you do **not** commit:

- `.env` files with real credentials
- `~/.bridges/` local state
- live node API keys, admin tokens, or other service secrets
- private key material
- production database files

This repository currently ignores common local-sensitive paths such as:

- `.env`
- `.bridges/`
- `*.db`
- build outputs under `target/`, `dist/`, and `node_modules/`

## Documentation map

- `docs/core-architecture.md` — canonical Bridges architecture overview, planes, trust boundaries, and code map
- `docs/privacy-model.md` — current privacy contract, metadata visibility, and retention model
- `docs/presence-model.md` — current daemon/runtime/reachability model and status semantics
- `docs/permissions-model.md` — current project roles, capabilities, and enforcement boundaries
- `docs/addressing-model.md` — current human-friendly selector resolution rules for CLI and skills
- `docs/delivery-semantics.md` — current guarantees and non-guarantees for ask, debate, broadcast, and publish
- `docs/identity-lifecycle.md` — current node replacement, revocation, and recovery model
- `docs/self-host-guide.md` — full self-hosted server + agent runtime setup guide
- `docs/mac-pi-setup-guide.md` — source-first setup guide for a Mac with Pi Agent
- `docs/test-guide.md` — self-hosted/local coordination walkthrough
- `docs/e2e-test-guide.md` — end-to-end two-machine validation
- `skills/bridges/SKILL.md` — runtime-facing skill instructions
- `CHANGELOG.md` — recent registry and local API hardening changes

## Validation commands

Rust:

```bash
cargo fmt --manifest-path cli/Cargo.toml --check
cargo clippy --manifest-path cli/Cargo.toml -- -D warnings
cargo test --manifest-path cli/Cargo.toml
```

Registry:

```bash
cd registry
npm ci
npm run build
npm rebuild better-sqlite3
npm test
```

Package smoke check:

```bash
npm pack --dry-run
```

## Release/publish notes

- current public beta use is source-first; binary and npm release remain disabled
- when you intentionally enable publishing later, package metadata should come from the root `README.md`, packaged `skills/`, and platform binaries in `bin/`
- the public repo currently does not ship an active release workflow
- coordination URLs and any optional external service endpoints should be configured with environment variables, not hardcoded hostnames

## License

MIT
