# Development entrypoints

This document keeps the top-level commands for the Kordi monorepo in one place.

All commands below are intended to be run from:

```bash
cd /path/to/kordi
```

## Install dependencies

```bash
pnpm install
```

## Desktop app

### Start the whole local app stack

```bash
pnpm dev
```

This command:

1. starts the local app server
2. launches the Tauri desktop app
3. keeps both processes tied to the same terminal session

Use this as the default development command when you want the product shell and the app-facing backend running together.

### Start the Tauri desktop app only

```bash
pnpm dev:desktop
```

This command:

1. builds the local `agent` sidecar
2. builds the local `bridges` sidecar
3. copies both binaries into `app/desktop/src-tauri/binaries`
4. launches the Tauri app

Use this when you only want the desktop shell and sidecars, without separately starting the app server through the root `dev` command.

### Start the web-only preview

```bash
pnpm dev:web
```

### Build the desktop app

```bash
pnpm build:desktop
```

### Build the web UI

```bash
pnpm build:web
```

## App server

The app server is the app-facing local orchestration backend used to compose runtime and bridge state behind one product contract.

### Run the app-facing server

```bash
pnpm run:app-server -- --help
pnpm run:app-server --
```

### Check the app server crate

```bash
pnpm check:app-server
```

## Agent runtime

### Run the CLI / TUI

```bash
pnpm run:agent -- --help
pnpm run:agent --
```

### Check the agent crates

```bash
pnpm check:agent
```

### Build the agent binary

```bash
pnpm build:agent
```

## Bridges network stack

### Run the Bridges CLI

```bash
pnpm run:bridges -- --help
```

### Check the Bridges CLI crate

```bash
pnpm check:bridges
```

### Build the Bridges CLI

```bash
pnpm build:bridges
```

### Start the registry service

```bash
pnpm dev:registry
```

### Build the registry service

```bash
pnpm build:registry
```

## Shared validation

### Lint the desktop app

```bash
pnpm lint
```

### Check all Rust crates

```bash
pnpm check:rust
```

### Run the common validation pass

```bash
pnpm check
```

## Notes

- `pnpm dev` is the default "run the whole app" command from the monorepo root.
- The desktop app is the primary product surface.
- The app server is the app-facing orchestration backend for desktop and future shared clients.
- The app should prefer stable app-facing contracts over directly wiring UI components to low-level runtime or network internals.
- Keep shared contracts in `shared/` whenever both Rust and TypeScript need the same protocol concepts.
