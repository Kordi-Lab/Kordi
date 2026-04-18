# Kordi Desktop

Kordi Desktop is the macOS application shell for the Kordi product.

## Role in Kordi

This directory owns:

- the React interface
- the Tauri desktop shell
- desktop-specific orchestration
- sidecar packaging for the local `agent` and `bridges` binaries

It does **not** own the source-of-truth implementation of the agent runtime or network backend. Those live in:

- [`../../agent`](../../agent)
- [`../../bridges`](../../bridges)

## Monorepo commands

Run these from the repository root.

```bash
cd /Users/shuyang/Desktop/kordi
pnpm install
```

### Web-only preview

```bash
pnpm dev:web
```

### Tauri desktop development

```bash
pnpm dev:desktop
```

### Build the desktop app

```bash
pnpm build:desktop
```

### Prepare sidecars only

```bash
pnpm prepare:sidecars
```

## Local commands

Work from this directory only when you intentionally want to stay inside the desktop package:

```bash
cd /Users/shuyang/Desktop/kordi/app/desktop
pnpm install
pnpm tauri:dev
```

## Directory guide

| Path | Purpose |
|------|---------|
| `src/` | React application |
| `src-tauri/` | Tauri shell |
| `scripts/prepare-sidecars.mjs` | Builds and copies local sidecars |
| `kordi.workspace.json` | Sidecar source and binary map |

## Validation

```bash
cd /Users/shuyang/Desktop/kordi
pnpm lint
pnpm build:web
pnpm prepare:sidecars
```

## Sidecar behavior

- `pnpm dev:desktop` and `pnpm build:desktop` both prepare sidecars first.
- Sidecars are built from the monorepo-local `agent` and `bridges` directories.
- Generated binaries are copied into `src-tauri/binaries/` for Tauri to bundle.

## Related docs

- [../../README.md](../../README.md)
- [../../docs/development.md](../../docs/development.md)
- [../../docs/architecture.md](../../docs/architecture.md)
- [../../docs/release.md](../../docs/release.md)
