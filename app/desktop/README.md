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

### Cloud Edition desktop

To run the account-based Cloud Edition desktop app against the hosted Cloud API:

```bash
VITE_KORDI_EDITION=cloud \
KORDI_EDITION=cloud \
VITE_KORDI_CLOUD_API_BASE=https://kordi.cloud \
pnpm dev:desktop
```

See [../../docs/run-cloud-desktop.md](../../docs/run-cloud-desktop.md) for the full Cloud Desktop guide, including packaged builds and multi-user Cloud development.

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

### Launch multiple isolated users from config

For Phase 2 launcher work, use the config-driven multi-instance scripts:

```bash
pnpm dev:desktop:multi -- --users user1,user2
```

This reads:

```text
app/desktop/scripts/multi-instance/configs/users.yaml
```

The launcher will:

- prepare per-user data roots
- assign configured ports/titles/profiles
- write per-user logs
- optionally seed deterministic per-user auth fixtures
- start one isolated desktop instance per configured user

Launch from clean state:

```bash
pnpm dev:desktop:multi -- --reset --users user1,user2
```

Reset without relaunching:

```bash
pnpm reset:desktop:multi -- --users user1,user2
```

Run the two-user smoke test:

```bash
pnpm smoke:desktop:multi -- --users user1,user2
```

This performs a deterministic reset + shared-auth bootstrap + launch + readiness verification cycle for two users, then stops the instances while preserving logs and isolated data for inspection.

Inspect the resolved config without launching:

```bash
pnpm dev:desktop:multi -- --dry-run
```

Artifacts are written to deterministic paths:

```text
app/desktop/.multi-instance-data/<instance>/
app/desktop/.multi-instance-logs/<instance>/dev-<port>.log
app/desktop/.multi-instance-runtime/<instance>.pid
```

For Phase 3 deterministic bootstrap, multi-instance users now default to:

```yaml
defaults:
  bootstrap:
    authSource: shared
    authMode: if-missing
```

That copies your existing shared auth store from `~/.kordi/auth.json` (or legacy `~/.bb-agent/auth.json`) into each isolated instance before launch, so the app opens already authenticated without manual UI login.

You can still override a specific user with a local fixture:

```yaml
bootstrap:
  authFile: ./local/user1-auth.json
  authMode: always
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
- [../../docs/run-cloud-desktop.md](../../docs/run-cloud-desktop.md)
- [../../docs/architecture.md](../../docs/architecture.md)
- [../../docs/app-server.md](../../docs/app-server.md)
- [../../docs/release.md](../../docs/release.md)
