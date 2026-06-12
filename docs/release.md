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

## In-app desktop updates

Packaged desktop builds use Tauri's signed updater. Release builds must provide the Tauri updater signing private key via the release environment and publish the generated updater archive plus companion `.sig` file on the GitHub Release. The hosted update endpoint is the desktop app's stable check URL, but its manifest is derived from the latest release metadata and release assets:

```text
https://coordinar.io/api/desktop-updates/{{target}}/{{arch}}/{{current_version}}
```

The hosted endpoint returns no update when the latest release has no matching updater archive/signature pair for the requested target and architecture, or when the latest release version matches the current app version. The desktop app checks this endpoint quietly. When an update is available, the Chats header shows the blue `Update` button; installation runs in-app and prompts for restart only after install finishes.

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
