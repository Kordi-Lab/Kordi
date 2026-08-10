# Kordi Desktop

Kordi Desktop is the macOS product shell for Kordi.

## Role in Kordi

This directory owns:

- the React product interface
- the Tauri desktop shell
- account login/session restoration
- chats, contacts, groups, and sync UI
- desktop packaging and release checks

The product backend is the hosted API. Production builds use:

```text
https://kordi.ai
```

For development or QA, use an operator-provided public test API base or host your own compatible server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Before a remote operator preview or debug session, follow the [required environment preflight](../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug). Work that can affect or require restarting the product server must be developed and tested on the corresponding product-server machine, with the first end-to-end validation through `https://coordinar.io`, never `https://kordi.ai`. Desktop-only remote previews use the allowlisted `https://kordi.ai` operator launcher. Isolated contributor testing remains documented separately and does not substitute for product-server validation.

## Commands from the repository root

```bash
cd /path/to/kordi
pnpm install
```

### Start desktop

```bash
pnpm dev
```

This opens the desktop app. To target a test or self-hosted API, set the hosted API base explicitly:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

### Launch multiple isolated users

Use this for contacts, groups, unread state, and sync testing. Each local window gets isolated local app data, but all product data comes from `VITE_KORDI_CLOUD_API_BASE`.

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

Create local-only multi-user configs under `/tmp` or another untracked path. Do not commit real account sessions or auth fixtures.

### Build desktop

```bash
pnpm build:desktop
```

This uses the desktop packaging path. Release builds must pass the release secret guard and should not include local account/session secrets.

## Package-local commands

Use these only when you intentionally work inside `app/desktop`:

```bash
cd /path/to/kordi/app/desktop
pnpm tauri:dev
pnpm tauri:build
```

Both commands use the product configuration.

## Directory guide

| Path | Purpose |
|------|---------|
| `src/` | React desktop application |
| `src/features/cloud/` | Account auth, sync, contacts, sessions, and hosted API clients |
| `src-tauri/` | Native shell, account session storage, OAuth loopback, packaging config |
| `scripts/` | Desktop build/dev/release helpers |
| `tests/` | Desktop unit and source-guard tests |

## Validation

```bash
cd /path/to/kordi
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop exec tsx --test tests/productShell.test.tsx tests/cloudSurfaceCleanup.test.ts tests/cloudNoLegacyBridgeTransport.test.ts
```

## Related docs

- [../../README.md](../../README.md)
- [../../docs/development.md](../../docs/development.md)
- [../../docs/run-cloud-desktop.md](../../docs/run-cloud-desktop.md)
- [../../docs/architecture.md](../../docs/architecture.md)
- [../../docs/hosted-cloud-developer-guide.md](../../docs/hosted-cloud-developer-guide.md)
- [../../docs/release.md](../../docs/release.md)
