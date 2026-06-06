# Kordi Desktop

Kordi Desktop is the macOS Cloud product shell for Kordi.

## Role in Kordi

This directory owns:

- the React Cloud product interface
- the Tauri desktop shell
- account login/session restoration
- chats, contacts, groups, and Cloud sync UI
- desktop packaging and release checks

The product backend is the hosted Cloud API. Production builds use:

```text
https://coordinar.io
```

For development or QA, use an operator-provided public test Cloud API base or host your own compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

## Commands from the repository root

```bash
cd /path/to/kordi
pnpm install
```

### Start Cloud desktop

```bash
pnpm dev
```

This opens the Cloud desktop app. To target a test or self-hosted Cloud API:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

### Launch multiple isolated Cloud users

Use this for contacts, groups, unread state, and sync testing. Each local window gets isolated local app data, but all product data comes from the selected Cloud API.

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

Create local-only multi-user configs under `/tmp` or another untracked path. Do not commit real account sessions or auth fixtures.

### Build Cloud desktop

```bash
pnpm build:desktop
```

This uses the Cloud packaging path. Release builds must pass the release secret guard and should not include local account/session secrets.

## Package-local commands

Use these only when you intentionally work inside `app/desktop`:

```bash
cd /path/to/kordi/app/desktop
pnpm tauri:dev
pnpm tauri:build
```

Both commands use the Cloud product configuration.

## Directory guide

| Path | Purpose |
|------|---------|
| `src/` | React Cloud desktop application |
| `src/features/cloud/` | Cloud auth, sync, contacts, sessions, and Cloud API clients |
| `src-tauri/` | Native shell, Cloud session storage, OAuth loopback, packaging config |
| `scripts/` | Desktop build/dev/release helpers |
| `tests/` | Desktop unit and source-guard tests |

## Validation

```bash
cd /path/to/kordi
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx tests/cloudSurfaceCleanup.test.ts tests/cloudNoLegacyBridgeTransport.test.ts
```

## Related docs

- [../../README.md](../../README.md)
- [../../docs/development.md](../../docs/development.md)
- [../../docs/run-cloud-desktop.md](../../docs/run-cloud-desktop.md)
- [../../docs/cloud-edition.md](../../docs/cloud-edition.md)
- [../../docs/hosted-cloud-developer-guide.md](../../docs/hosted-cloud-developer-guide.md)
- [../../docs/release.md](../../docs/release.md)
