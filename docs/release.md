# Release and packaging

This document describes how the Kordi monorepo is expected to package and release its different layers.

## Product surfaces

### Desktop app

Primary entrypoint:

```bash
pnpm build:desktop
```

The desktop app is the end-user product surface. It packages:

- the React app
- the Tauri shell
- local sidecar binaries for `agent` and `bridges`

### Agent runtime

Primary entrypoint:

```bash
pnpm build:agent
```

This build produces the local runtime binary used by the desktop app and any standalone runtime workflows.

### Bridges network layer

Primary entrypoints:

```bash
pnpm build:bridges
pnpm build:registry
```

The Bridges layer ships in two forms:

- the local CLI / daemon binary
- the registry service

## Sidecar packaging

The desktop app uses:

```bash
pnpm prepare:sidecars
```

This command:

1. builds the agent binary
2. builds the Bridges binary
3. copies both into `app/desktop/src-tauri/binaries`

`pnpm dev:desktop` and `pnpm build:desktop` both call this workflow.

## Validation before release

Recommended baseline:

```bash
pnpm check
pnpm build:desktop
pnpm build:registry
```

Add additional release-specific validation over time, but keep the root command surface simple.

## Ownership

- Desktop packaging changes belong in `app/desktop`
- Runtime binary changes belong in `agent`
- Network and registry release changes belong in `bridges`
- Shared packaging contracts should move into `shared` only when more than one layer depends on them
