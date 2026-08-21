# Run Kordi Desktop

This guide is for running the account-based Kordi desktop app from a local checkout.

Production API:

```text
https://kordi.ai
```

For development, select the environment in [Development environment isolation](development-environments.md), then use the isolated backend from the current checkout or an approved remote development backend through its loopback tunnel. For approved shared QA, use an operator-provided public test API base:

```text
<PUBLIC_TEST_CLOUD_API_BASE>
```

Do not use the production server for destructive, load, or throwaway multi-account testing unless explicitly authorized.

## Required environment preflight

Before launching a preview or debug session, follow the [canonical environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug):

- If the current operator session can affect or require restarting the product server, develop and test on the corresponding product-server machine. Validate the deployed product through `https://kordi.ai`, never through a local community/debug-server profile.
- If the remote operator preview is desktop-only, check the active GitHub account against `deploy/dev/operator-github-allowlist.txt` and use the approved `https://kordi.ai` launcher.
- Isolated local or IAP-tunneled development uses the loopback origin, `VITE_KORDI_DEV_PROFILE=community`, and a named `io.kordi.cloud.*` desktop profile. It does not substitute for product-server validation.
- If impact is uncertain or required access is missing, stop and fail closed.

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

The base backend does not start LiveKit. Before testing voice or video, follow
[Hosting Kordi voice and video calls](call-hosting.md) and keep its API,
signaling, and RTC tunnels open for the full test.

Launch the desktop with the explicit loopback origin and an isolated named profile:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-isolated --title "Kordi Dev" --port 1422
```

Development launches fail closed when the API origin is missing, invalid, or points at production. The community profile uses the gray development icon, while Product and allowlisted operator previews use the color icon. To use an approved public staging or self-hosted API, set that origin explicitly:

```bash
VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE> \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile approved-staging --title "Kordi Staging" --port 1422
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

Before a release is accepted or published, run its installed app against the
product call deployment and complete the [two-account call acceptance
test](call-hosting.md#required-two-account-acceptance-test).

## Optional: run multiple isolated users

Use this when testing contacts, groups, unread state, or multi-user sync. Each user gets isolated local desktop data, while product data comes from `VITE_KORDI_CLOUD_API_BASE`.

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm dev:cloud:multi -- --reset --users user1,user2,user3
```

Never use a tunnel/local backend as product-server validation. Use tunnel/local options only with explicit operator authorization or for an intentionally isolated compatible API. Product-server-affecting work moves to the corresponding product-server machine and `https://coordinar.io`. Keep real private host details out of docs, PRs, issues, and shared logs. See [Internal/operator local tunnel debug pipeline](hosted-cloud-developer-guide.md#internaloperator-local-tunnel-debug-pipeline).

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
- For product-server-affecting work, verify `https://kordi.ai/health` before the change and after every restart/deploy, then confirm the allowlisted desktop logs show `https://kordi.ai` for the end-to-end test.
- If Tauri fails before the app opens, run `pnpm install` again and confirm the Rust toolchain is installed.
- If multi-instance ports are already in use, leave their owners running and select unused ports or a different user set. Never stop an instance that the current task did not launch.
- Do not use `--reset` unless you intentionally want to delete that local test user's desktop state.

## Related docs

- [Development environment isolation](development-environments.md)
- [Local development with an isolated backend](self-hosted-debug.md)
- [Kordi architecture and backend notes](cloud-edition.md)
- [Hosted developer guide](hosted-cloud-developer-guide.md)
- [Voice and video call hosting](call-hosting.md)
- [Desktop app README](../app/desktop/README.md)
- [Development command map](development.md)
