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

The longer-term app-facing orchestration layer lives in [`../server`](../server) and is documented in [`../../docs/app-server.md`](../../docs/app-server.md).

## Monorepo commands

Run these from the repository root.

```bash
cd /path/to/kordi
pnpm install
```

### Run the whole local app stack

```bash
pnpm dev
```

This is the top-level development command for Kordi. It starts the local app server and launches the desktop app together.

### Web-only preview

```bash
pnpm dev:web
```

### Tauri desktop development only

```bash
pnpm dev:desktop
```

To run multiple desktop dev shells at the same time, use a unique port + profile for each instance:

```bash
pnpm dev:desktop:profile -- --port 1420 --profile main
pnpm dev:desktop:profile -- --port 1422 --profile feature-b
```

The profile script generates a per-instance Tauri config so each desktop app can have its own:

- Vite dev server port
- app title
- bundle identifier suffix

### Verify isolated instance storage locally

For Phase 1 multi-instance verification, use the isolated instance helper:

```bash
pnpm --dir app/desktop tauri:dev:instance -- --instance user1 --port 1426
pnpm --dir app/desktop tauri:dev:instance -- --instance user2 --port 1428
```

This wraps the profile launcher and injects per-instance env vars such as:

- `APP_INSTANCE_ID`
- `APP_DATA_DIR`
- `KORDI_STORAGE_ROOT`
- `BRIDGES_HOME`
- `BRIDGES_PROJECTS_DIR`

By default, isolated state is written under:

```text
app/desktop/.multi-instance-data/<instance>/
```

You can reset an instance before launch:

```bash
pnpm --dir app/desktop tauri:dev:instance -- --instance user1 --port 1426 --clean
```

You can inspect the generated config/env without launching:

```bash
pnpm --dir app/desktop tauri:dev:instance -- --instance user1 --port 1426 --dry-run
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
cd /path/to/kordi/app/desktop
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
| `../server/` | App-facing local orchestration server crate |

## Validation

```bash
cd /path/to/kordi
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
- [../../docs/app-server.md](../../docs/app-server.md)
- [../../docs/release.md](../../docs/release.md)
