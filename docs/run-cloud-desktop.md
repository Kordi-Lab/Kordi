# Run Kordi Cloud Desktop

This guide is for running the account-based Cloud Edition desktop app from a local checkout. Cloud Edition uses the hosted Kordi Cloud API for auth, contacts, direct messages, groups, read receipts, and Cloud sync while still running your local desktop agent sidecars on your machine.

## Prerequisites

- macOS development machine with Tauri prerequisites installed.
- Node.js 20+ and `pnpm` 10+.
- Rust toolchain from `rustup`.
- A reachable Cloud API. For normal use, use `https://kordi.cloud`.

Install dependencies once from the repository root:

```bash
cd /path/to/kordi
pnpm install
```

## Run Cloud Desktop in development

From the repository root:

```bash
VITE_KORDI_EDITION=cloud \
KORDI_EDITION=cloud \
VITE_KORDI_CLOUD_API_BASE=https://kordi.cloud \
pnpm dev:desktop
```

This launches the Tauri desktop app in Cloud Edition mode and points it at the hosted Cloud API.

What to expect:

1. The desktop app opens in Cloud login mode.
2. Sign in with an email/password account or a configured OAuth provider.
3. The local desktop sidecars are still prepared and run locally; Cloud only handles account/network sync.

## Build a Cloud Desktop package

To produce a Cloud Edition desktop build:

```bash
VITE_KORDI_CLOUD_API_BASE=https://kordi.cloud \
pnpm --dir app/desktop tauri:build:cloud
```

The `tauri:build:cloud` script sets `VITE_KORDI_EDITION=cloud` and `KORDI_EDITION=cloud` for the build.

## Optional: run multiple isolated Cloud users for development

Use this when testing Cloud contacts, groups, or multi-user sync locally. Each user gets isolated app data under `app/desktop/.multi-instance-data/<user>/`.

```bash
VITE_KORDI_CLOUD_API_BASE=https://kordi.cloud \
pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2,user3
```

To point those instances at a local Cloud API tunnel instead:

```bash
KORDI_CLOUD_USE_LOCAL_TUNNEL=1 \
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2,user3
```

Only use the local tunnel option if you have access to the development Cloud server or are running your own compatible Cloud API.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_KORDI_EDITION=cloud` | Dev run | Enables Cloud Edition UI/runtime behavior in the frontend. |
| `KORDI_EDITION=cloud` | Dev run | Enables Cloud Edition behavior for the desktop shell/sidecars. |
| `VITE_KORDI_CLOUD_API_BASE` | Recommended | Cloud API base URL. Use `https://kordi.cloud` for hosted Cloud. |
| `KORDI_CLOUD_USE_LOCAL_TUNNEL=1` | Optional | Multi-instance helper flag for local tunnel development. |

## Troubleshooting

- If the app opens in local mode, confirm both `VITE_KORDI_EDITION=cloud` and `KORDI_EDITION=cloud` are set for dev runs.
- If login or sync fails, verify the API base URL is reachable:

  ```bash
  curl https://kordi.cloud/health
  ```

- If Tauri fails before the app opens, run `pnpm install` again and confirm the Rust toolchain is installed.
- If multi-instance ports are already in use, stop the old instances or choose a smaller user set.
- Do not use `--reset` with multi-instance data unless you intentionally want to delete that user's local dev state.

## Related docs

- [Cloud Edition architecture and backend notes](cloud-edition.md)
- [Desktop app README](../app/desktop/README.md)
- [Development command map](development.md)
