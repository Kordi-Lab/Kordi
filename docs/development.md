# Development entrypoints

This document keeps the top-level commands for the Kordi monorepo in one place.

All commands below are intended to be run from:

```bash
cd /Users/shuyang/Desktop/kordi
```

## Install dependencies

```bash
pnpm install
```

## Desktop app

### Start the Tauri desktop app

```bash
pnpm dev:desktop
```

This command:

1. builds the local `agent` sidecar
2. builds the local `bridges` sidecar
3. copies both binaries into `app/desktop/src-tauri/binaries`
4. launches the Tauri app

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

- The desktop app is the integration surface.
- The app should prefer stable app-facing commands over directly wiring UI components to low-level runtime or network internals.
- Keep shared contracts in `shared/` whenever both Rust and TypeScript need the same protocol concepts.
