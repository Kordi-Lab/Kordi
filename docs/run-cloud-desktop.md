# Run Kordi Cloud Desktop

This guide is for running the account-based Kordi Cloud desktop app from a local checkout.

Production Cloud API:

```text
https://coordinar.io
```

For development or QA, use an operator-provided public test Cloud API base or host your own compatible Cloud server:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not use the production server for destructive, load, or throwaway multi-account testing unless explicitly authorized.

## Prerequisites

- macOS development machine with Tauri prerequisites installed.
- Node.js 20+ and `pnpm` 10+.
- Rust toolchain from `rustup`.
- A reachable Cloud API.

Install dependencies once:

```bash
cd /path/to/kordi
pnpm install
```

## Run Cloud Desktop

Use the product default:

```bash
pnpm dev
```

Target a public test or self-hosted Cloud API:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

What to expect:

1. The desktop app opens in Cloud login mode.
2. Sign in with an account or configured OAuth provider.
3. Contacts, chats, groups, read state, and Cloud agent fallback route through the selected Cloud API.

## Build a Cloud Desktop package

```bash
pnpm build:desktop
```

The Cloud build path sets the Cloud edition environment for the desktop frontend/native shell.

## Optional: run multiple isolated Cloud users

Use this when testing contacts, groups, unread state, or multi-user sync. Each user gets isolated local desktop data, while Cloud product data comes from the configured Cloud API.

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
pnpm dev:cloud:multi -- --users user1,user2,user3
```

Only use tunnel/local backend options if you have explicit operator access or are running your own compatible Cloud API.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VITE_KORDI_CLOUD_API_BASE` | Cloud API base URL. Use `<PUBLIC_TEST_CLOUD_API_BASE>` for testing or `https://coordinar.io` for production. |
| `KORDI_CLOUD_API_BASE` | Native/backend Cloud API override when a helper needs it. |
| `KORDI_CLOUD_USE_LOCAL_TUNNEL=1` | Internal/operator tunnel mode for multi-instance development. |

Cloud edition is the default product mode. Explicit `VITE_KORDI_EDITION=cloud` and `KORDI_EDITION=cloud` are still accepted for scripts and release builds.

## Troubleshooting

- If login or sync fails, verify the selected API base is reachable:

  ```bash
  curl <PUBLIC_TEST_CLOUD_API_BASE>/health
  ```

- If Tauri fails before the app opens, run `pnpm install` again and confirm the Rust toolchain is installed.
- If multi-instance ports are already in use, stop old instances or choose a smaller user set.
- Do not use `--reset` unless you intentionally want to delete that local test user's desktop state.

## Related docs

- [Cloud Edition architecture and backend notes](cloud-edition.md)
- [Hosted Cloud developer guide](hosted-cloud-developer-guide.md)
- [Desktop app README](../app/desktop/README.md)
- [Development command map](development.md)
