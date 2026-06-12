# Kordi

Kordi is the desktop product for account-based chats, contacts, groups, and hosted agent execution.

Primary product pieces:

- `app/desktop` — macOS desktop application (React + Tauri)
- `bridges/cloud-server` — hosted API for auth, contacts, chats, sync, read state, and update manifests
- `bridges/cloud-agent-runner` — hosted agent runner and sandbox execution
- `agent` — agent/runtime source used by hosted runner integration and internal developer workflows
- `shared` — shared protocol/type surfaces

Production API:

```text
https://coordinar.io
```

For development or QA, do **not** use the production server for destructive or load-style testing. Use an operator-provided public test hosted API base, or host your own compatible hosted server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

## Repository layout

```text
kordi/
  app/
    desktop/               # React + Tauri desktop app
  agent/                   # Agent/runtime source
  bridges/
    cloud-server/          # Hosted API
    cloud-agent-runner/    # Hosted runner/sandbox
  shared/                  # Shared Rust/TypeScript contracts
  docs/                    # Product, development, release docs
```

## Prerequisites

- Node.js 20+
- `pnpm` 10+
- Rust toolchain (`rustup`)

Install dependencies once:

```bash
cd /path/to/kordi
pnpm install
```

## Development commands

| Task | Command | Description |
|------|---------|-------------|
| Start desktop | `pnpm dev` | Opens the desktop app. Defaults to the production origin unless `VITE_KORDI_CLOUD_API_BASE` is set. |
| Start desktop explicitly | `pnpm dev:cloud` | Same product path as `pnpm dev`. |
| Start multiple users | `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev:cloud:multi -- --users user1,user2` | Multi-window sync/contact/group testing against a test or self-hosted API. |
| Build desktop | `pnpm build:desktop` | Builds the desktop package. |
| Build web UI | `pnpm build:web` | Builds the browser-targeted frontend bundle. |
| Lint desktop app | `pnpm lint` | Runs the desktop frontend linter. |
| Check Rust workspace | `pnpm check:rust` | Verifies Rust crates. |
| Common validation | `pnpm check` | Runs the standard lint + typecheck + Rust validation pass. |

## Responsibilities by directory

### `app/desktop`

Owns the product UI, native Tauri shell, desktop packaging, account/login surface, chats, contacts, groups, and sync integration.

See [app/desktop/README.md](app/desktop/README.md).

### `bridges/cloud-server`

Owns the hosted API used by the desktop product: account auth, contacts, direct/group messages, read state, sync, provider-auth snapshots, update manifests, and runner coordination.

### `bridges/cloud-agent-runner`

Owns hosted fallback execution, model loop integration, sandbox tool policy, and artifact export.

### `agent`

Owns agent/runtime internals shared with hosted runner integration and internal local developer workflows.

### `shared`

Owns Rust/TypeScript contracts that cross process or package boundaries.

## Documentation map

- [docs/development.md](docs/development.md) — development command map
- [docs/run-cloud-desktop.md](docs/run-cloud-desktop.md) — Kordi Desktop quick start
- [docs/hosted-cloud-developer-guide.md](docs/hosted-cloud-developer-guide.md) — Hosted testing/deployment guidance and redaction rules
- [docs/cloud-edition.md](docs/cloud-edition.md) — hosted architecture and runtime notes
- [docs/release.md](docs/release.md) — packaging and release responsibilities
- [app/desktop/README.md](app/desktop/README.md) — desktop app responsibilities and entrypoints

## Notes

- Production builds use `https://coordinar.io` as the product hosted API origin.
- Hosted/dev runs must set `VITE_KORDI_CLOUD_API_BASE` explicitly, for example `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted server.
- Do not commit auth tokens, provider tokens, account secrets, database credentials, or private operator infrastructure details.
