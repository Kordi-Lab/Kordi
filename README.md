# Kordi

Kordi is the Cloud-first desktop product for account-based chats, contacts, groups, and Cloud agent execution.

Primary product pieces:

- `app/desktop` — macOS desktop application (React + Tauri)
- `bridges/cloud-server` — hosted Cloud API for auth, contacts, chats, sync, read state, and update manifests
- `bridges/cloud-agent-runner` — hosted Cloud agent runner and sandbox execution
- `agent` — agent/runtime source used by Cloud runner integration and internal developer workflows
- `shared` — shared protocol/type surfaces

Production Cloud API:

```text
https://coordinar.io
```

For development or QA, do **not** use the production server for destructive or load-style testing. Use an operator-provided public test Cloud API base, or host your own compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

## Repository layout

```text
kordi/
  app/
    desktop/               # React + Tauri Cloud desktop app
  agent/                   # Agent/runtime source
  bridges/
    cloud-server/          # Hosted Cloud API
    cloud-agent-runner/    # Hosted Cloud runner/sandbox
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

## Cloud-first development commands

| Task | Command | Description |
|------|---------|-------------|
| Start Cloud desktop | `pnpm dev` | Opens the Cloud desktop app. Defaults to the production Cloud origin unless `VITE_KORDI_CLOUD_API_BASE` is set. |
| Start Cloud desktop explicitly | `pnpm dev:cloud` | Same Cloud product path as `pnpm dev`. |
| Start multiple Cloud users | `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev:cloud:multi -- --users user1,user2` | Multi-window Cloud sync/contact/group testing against a test or self-hosted Cloud API. |
| Build Cloud desktop | `pnpm build:desktop` | Builds the Cloud desktop package. |
| Build web UI | `pnpm build:web` | Builds the browser-targeted frontend bundle. |
| Lint desktop app | `pnpm lint` | Runs the desktop frontend linter. |
| Check Rust workspace | `pnpm check:rust` | Verifies Rust crates. |
| Common validation | `pnpm check` | Runs the standard lint + typecheck + Rust validation pass. |

Legacy/internal local runtime commands use explicit `:local` names where they remain. They are not the product quick start.

## Responsibilities by directory

### `app/desktop`

Owns the Cloud product UI, native Tauri shell, desktop packaging, account/login surface, chats, contacts, groups, and Cloud sync integration.

See [app/desktop/README.md](app/desktop/README.md).

### `bridges/cloud-server`

Owns the hosted Cloud API used by the desktop product: account auth, contacts, direct/group messages, read state, Cloud sync, provider-auth snapshots, update manifests, and runner coordination.

### `bridges/cloud-agent-runner`

Owns hosted Cloud fallback execution, model loop integration, sandbox tool policy, and Cloud artifact export.

### `agent`

Owns agent/runtime internals shared with Cloud runner integration and internal local developer workflows.

### `shared`

Owns Rust/TypeScript contracts that cross process or package boundaries.

## Documentation map

- [docs/development.md](docs/development.md) — Cloud-first command map
- [docs/run-cloud-desktop.md](docs/run-cloud-desktop.md) — Cloud Desktop quick start
- [docs/hosted-cloud-developer-guide.md](docs/hosted-cloud-developer-guide.md) — Cloud testing/deployment guidance and redaction rules
- [docs/cloud-edition.md](docs/cloud-edition.md) — Cloud architecture and runtime notes
- [docs/release.md](docs/release.md) — packaging and release responsibilities
- [app/desktop/README.md](app/desktop/README.md) — desktop app responsibilities and entrypoints

## Notes

- Production builds use `https://coordinar.io` as the product Cloud API origin.
- Test runs should set `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or point at a self-hosted Cloud server.
- Do not commit auth tokens, provider tokens, account secrets, database credentials, or private operator infrastructure details.
