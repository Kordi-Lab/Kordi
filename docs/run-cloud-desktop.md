# Run Kordi Desktop

This guide is for running the account-based Kordi desktop app from a local checkout.

Production API:

```text
https://kordi.ai
```

For development, use the isolated backend from the current checkout. For approved shared QA, use an operator-provided public test API base:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not use the production server for destructive, load, or throwaway multi-account testing unless explicitly authorized.

## Prerequisites

- macOS development machine with Tauri prerequisites installed.
- Node.js 22+ and `pnpm` 10.29.3+.
- Rust toolchain from `rustup`.
- Docker Desktop or Docker Engine with Compose v2 for the isolated backend.

Install dependencies once:

```bash
cd /path/to/kordi
pnpm install --frozen-lockfile
```

## Run Kordi Desktop

Start and verify the isolated backend:

```bash
pnpm debug:cloud:up
pnpm debug:cloud:smoke
```

Launch the desktop with the explicit local API origin:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

Development launches fail closed when the API origin is missing, invalid, or points at production. To use an approved public staging or self-hosted API, set that origin explicitly:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> pnpm dev
```

What to expect:

1. The desktop app opens in account login mode.
2. Sign in with an account or configured OAuth provider.
3. Contacts, chats, groups, read state, and hosted agent fallback route through the selected hosted API.

## Build a Kordi Desktop package

```bash
pnpm build:desktop
```

The desktop build path uses the product configuration.

## Optional: run multiple isolated users

Use this when testing contacts, groups, unread state, or multi-user sync. Each user gets isolated local desktop data, while product data comes from `VITE_KORDI_CLOUD_API_BASE`.

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm dev:cloud:multi -- --reset --users user1,user2,user3
```

Only use tunnel/local backend options if you have explicit operator access or are running your own compatible hosted API. For operator tunnel debugging, use environment placeholders and keep real private host details out of docs, PRs, issues, and shared logs. See [Internal/operator local tunnel debug pipeline](hosted-cloud-developer-guide.md#internaloperator-local-tunnel-debug-pipeline).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VITE_KORDI_CLOUD_API_BASE` | Required non-production API base URL for development. Use the loopback debug API or `<PUBLIC_TEST_CLOUD_API_BASE>`. |
| `KORDI_CLOUD_API_BASE` | Native/backend hosted API override when a helper needs it. |
| `KORDI_CLOUD_USE_LOCAL_TUNNEL=1` | Internal/operator tunnel mode for multi-instance development. |

`main` contains one product path.

## Troubleshooting

- If local login or sync fails, verify the isolated API first:

  ```bash
  pnpm debug:cloud:smoke
  curl -fsS http://127.0.0.1:17081/health
  ```

- For operator tunnel debugging, verify the local tunnel endpoint and each desktop log's `VITE_KORDI_CLOUD_API_BASE` before changing code. Do not switch to production as a workaround unless an operator explicitly asks.
- If Tauri fails before the app opens, run `pnpm install` again and confirm the Rust toolchain is installed.
- If multi-instance ports are already in use, stop old instances or choose a smaller user set.
- Do not use `--reset` unless you intentionally want to delete that local test user's desktop state.

## Related docs

- [Local development with an isolated backend](self-hosted-debug.md)
- [Kordi architecture and backend notes](cloud-edition.md)
- [Hosted developer guide](hosted-cloud-developer-guide.md)
- [Desktop app README](../app/desktop/README.md)
- [Development command map](development.md)
