# Kordi Desktop

Kordi Desktop is the macOS product shell for Kordi.

Kordi Desktop requires macOS 12 or later.

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

Before any preview or debug session, use [Development environment isolation](../../docs/development-environments.md) and the [required environment preflight](../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug):

- Product-server-affecting work, including behavior requiring a server restart, must be developed and tested on the corresponding product-server machine through `https://kordi.ai`, never through a local community/debug-server profile.
- Desktop-only Kordi previews must pass the GitHub allowlist check and use `scripts/dev-cloud-operator.sh https://kordi.ai` with `KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1`.
- Isolated local or approved remote development uses a loopback API origin, `VITE_KORDI_DEV_PROFILE=community`, and a named `io.kordi.cloud.*` profile with production updater endpoints disabled.
- Unknown impact or missing access fails closed; do not switch environments or bypass checks.

`<PUBLIC_TEST_CLOUD_API_BASE>` remains available only for an explicitly authorized compatibility or self-hosted run. It is not a fallback for either required path.

Before a remote operator preview or debug session, follow the [required environment preflight](../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug). Work that can affect or require restarting the product server must be developed and tested on the corresponding product-server machine, with the first end-to-end validation through `https://kordi.ai`. Desktop-only remote previews use the allowlisted `https://kordi.ai` operator launcher. Isolated contributor testing remains documented separately and does not substitute for product-server validation.

## Commands from the repository root

```bash
cd /path/to/kordi
pnpm install
```

### Start desktop

For an isolated local or IAP-tunneled development backend, run from the repository root:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-isolated --title "Kordi Dev" --port 1422
```

The API-only development path does not provide LiveKit media. Follow the
[call hosting guide](../../docs/call-hosting.md) before testing voice or video.

For a desktop-only production operator preview, run:

```bash
KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
  scripts/dev-cloud-operator.sh https://kordi.ai
```

`pnpm dev` is a lower-level command that inherits the packaged `https://kordi.ai` default. Do not use it until the environment preflight selects that path. To target an explicitly authorized compatibility or self-hosted API, set the hosted API base explicitly:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile approved-staging --title "Kordi Staging" --port 1422
```

### Launch multiple isolated users

For Kordi operator testing, launch each isolated window through `scripts/dev-cloud-operator.sh` with a unique `--port` and `--profile`. The [hosted guide](../../docs/hosted-cloud-developer-guide.md#launch-multiple-local-users) provides the approved example.

Use the direct multi-user command only for an explicitly authorized compatibility or self-hosted API. Each local window gets isolated local app data, but all product data comes from `VITE_KORDI_CLOUD_API_BASE`.

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

A packaged call-capable release is not accepted by build success alone. Test
the installed app with two product accounts using the [required call acceptance
test](../../docs/call-hosting.md#required-two-account-acceptance-test).

Notification changes must pass the [packaged macOS notification QA](../../docs/development/macos-notification-qa.md).

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
- [../../docs/development-environments.md](../../docs/development-environments.md)
- [../../docs/development.md](../../docs/development.md)
- [../../docs/run-cloud-desktop.md](../../docs/run-cloud-desktop.md)
- [../../docs/architecture.md](../../docs/architecture.md)
- [../../docs/hosted-cloud-developer-guide.md](../../docs/hosted-cloud-developer-guide.md)
- [../../docs/call-hosting.md](../../docs/call-hosting.md)
- [../../docs/release.md](../../docs/release.md)
