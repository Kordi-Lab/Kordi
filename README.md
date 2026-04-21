# Kordi

Kordi is a monorepo for three core product layers plus one app-facing orchestration layer that ship together as one desktop experience:

- `app/desktop` — the macOS desktop application (React + Tauri)
- `app/server` — the app-facing local orchestration server
- `agent` — the local agent runtime derived from `bb-agent`
- `bridges` — the local and remote network stack derived from `Bridges`

The repository is organized so the app, server, runtime, and network layers can evolve together while still keeping clear boundaries.

## Repository layout

```text
kordi/
  app/
    desktop/               # React + Tauri desktop app
    server/                # App-facing local orchestration server
  agent/                   # Agent runtime source
  bridges/                 # Network / daemon / registry source
  shared/
    rust/protocol/         # Shared Rust protocol surface
    typescript/protocol/   # Shared TypeScript protocol surface
  docs/                    # Monorepo-level docs
```

## Prerequisites

- Node.js 20+
- `pnpm` 10+
- Rust toolchain (`rustup`)

Install JavaScript dependencies once from the repository root:

```bash
cd /path/to/kordi
pnpm install
```

## Development entrypoints

Run all of these from the monorepo root:

| Task | Command | Description |
|------|---------|-------------|
| Start the whole local app stack | `pnpm dev` | Runs the app server and launches the Tauri desktop app together. |
| Start the macOS desktop shell only | `pnpm dev:desktop` | Launches the desktop shell and prepares the local sidecars it needs. |
| Start the web preview only | `pnpm dev:web` | Runs the frontend in a browser-only development mode without Tauri. |
| Run the app-facing server only | `pnpm run:app-server -- --help` | Starts or inspects the local orchestration server separately. |
| Prepare Tauri sidecars manually | `pnpm prepare:sidecars` | Builds and copies the local agent and bridges binaries for desktop packaging. |
| Run the agent CLI/TUI | `pnpm run:agent -- --help` | Invokes the local runtime directly. |
| Run the Bridges CLI | `pnpm run:bridges -- --help` | Invokes the local bridge/network CLI directly. |
| Start the Bridges registry | `pnpm dev:registry` | Runs the registry service for bridge-network development. |
| Lint the desktop app | `pnpm lint` | Runs the desktop frontend linter. |
| Check the app server crate | `pnpm check:app-server` | Verifies the app-facing server crate builds. |
| Check all Rust crates | `pnpm check:rust` | Verifies the Rust workspace builds. |
| Run the common validation pass | `pnpm check` | Runs the standard lint + Rust workspace validation pass. |

## Build entrypoints

Run all of these from the monorepo root:

| Task | Command | Description |
|------|---------|-------------|
| Build the macOS app | `pnpm build:desktop` | Produces the packaged desktop application with local sidecars. |
| Build the web UI | `pnpm build:web` | Produces the browser-targeted frontend bundle. |
| Build the agent runtime | `pnpm build:agent` | Produces the local runtime binary. |
| Build the Bridges CLI | `pnpm build:bridges` | Produces the local bridge/network binary. |
| Build the Bridges registry | `pnpm build:registry` | Produces the registry service build output. |

## Responsibilities by directory

### `app/desktop`

Owns the product UI, Tauri shell, bundled sidecars, and desktop packaging.

See [app/desktop/README.md](app/desktop/README.md).

### `app/server`

Owns the app-facing local orchestration layer that composes desktop-facing state from the runtime and bridge services.

See [docs/app-server.md](docs/app-server.md).

### `agent`

Owns the local agent runtime, tools, providers, sessions, and terminal UX.

See [agent/README.md](agent/README.md).

### `bridges`

Owns the network layer, daemon, CLI, coordination server, registry, and Bridges skill assets.

See [bridges/README.md](bridges/README.md).

## Shared protocol layer

Use `shared/rust/protocol` and `shared/typescript/protocol` for types or contracts that must be shared across the app, agent, and network layers. Keep app-facing integration contracts here instead of duplicating them inside product-specific code.

## Documentation map

- [docs/development.md](docs/development.md) — root command map and day-to-day development entrypoints
- [docs/architecture.md](docs/architecture.md) — structural view of the app, server, agent, and bridges layers
- [docs/app-server.md](docs/app-server.md) — app-facing local server contract and integration plan
- [docs/release.md](docs/release.md) — packaging and release responsibilities by layer
- [app/desktop/README.md](app/desktop/README.md) — desktop app responsibilities and local entrypoints
- [agent/README.md](agent/README.md) — agent runtime guide
- [bridges/README.md](bridges/README.md) — Bridges network guide

## Monorepo notes

- The desktop app expects `agent` and `bridges` to exist inside this monorepo.
- `app/desktop/kordi.workspace.json` is the local sidecar build map for Tauri packaging.
- Sidecars are built from source during `pnpm dev:desktop` and `pnpm build:desktop`.

For a concise command map, see [docs/development.md](docs/development.md).
