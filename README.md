# Kordi

Kordi is a monorepo for three product layers that ship together as one desktop experience:

- `app/desktop` — the macOS desktop application (React + Tauri)
- `agent` — the local agent runtime derived from `bb-agent`
- `bridges` — the local and remote network stack derived from `Bridges`

The repository is organized so the app, runtime, and network layers can evolve together while still keeping clear boundaries.

## Repository layout

```text
kordi/
  app/
    desktop/               # React + Tauri desktop app
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

| Task | Command |
|------|---------|
| Start the macOS app | `pnpm dev:desktop` |
| Start the web preview only | `pnpm dev:web` |
| Prepare Tauri sidecars manually | `pnpm prepare:sidecars` |
| Run the agent CLI/TUI | `pnpm run:agent -- --help` |
| Run the Bridges CLI | `pnpm run:bridges -- --help` |
| Start the Bridges registry | `pnpm dev:registry` |
| Lint the desktop app | `pnpm lint` |
| Check all Rust crates | `pnpm check:rust` |
| Run the common validation pass | `pnpm check` |

## Build entrypoints

Run all of these from the monorepo root:

| Task | Command |
|------|---------|
| Build the macOS app | `pnpm build:desktop` |
| Build the web UI | `pnpm build:web` |
| Build the agent runtime | `pnpm build:agent` |
| Build the Bridges CLI | `pnpm build:bridges` |
| Build the Bridges registry | `pnpm build:registry` |

## Responsibilities by directory

### `app/desktop`

Owns the product UI, Tauri shell, bundled sidecars, and desktop packaging.

See [app/desktop/README.md](app/desktop/README.md).

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
- [docs/architecture.md](docs/architecture.md) — structural view of the app, agent, and bridges layers
- [docs/release.md](docs/release.md) — packaging and release responsibilities by layer
- [app/desktop/README.md](app/desktop/README.md) — desktop app responsibilities and local entrypoints
- [agent/README.md](agent/README.md) — agent runtime guide
- [bridges/README.md](bridges/README.md) — Bridges network guide

## Monorepo notes

- The desktop app expects `agent` and `bridges` to exist inside this monorepo.
- `app/desktop/kordi.workspace.json` is the local sidecar build map for Tauri packaging.
- Sidecars are built from source during `pnpm dev:desktop` and `pnpm build:desktop`.

For a concise command map, see [docs/development.md](docs/development.md).
