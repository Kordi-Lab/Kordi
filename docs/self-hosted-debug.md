# Local development with an isolated Kordi backend

This is the recommended setup for contributors working on the desktop app, account and messaging flows, backend routes, database migrations, attachments, unread state, or multi-account synchronization.

The environment runs the current checkout of the Kordi server with Postgres, Redis, NATS JetStream, and MinIO on the developer's machine. It never copies production data, credentials, snapshots, or configuration.

This isolated workflow does not authorize or replace product-server validation. If an approved operator session will apply a change to, or restart, the product server, stop the local path and follow the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug): work on the corresponding product-server machine and run the first end-to-end test through `https://coordinar.io`, never `https://kordi.ai`.

## Safety model

The local stack is intentionally separated from the hosted product:

- The desktop must receive an explicit non-production API origin in development.
- A missing, invalid, or production API origin causes the development launch to fail closed.
- The API and MinIO ports bind only to `127.0.0.1`.
- Postgres, Redis, and NATS have no host-published ports.
- Local credentials are generated into an ignored file and are not shared with any hosted environment.
- Reset commands are scoped to the `kordi-debug` Compose project.

These launch safeguards prevent accidental production traffic. They are not a security boundary against someone intentionally modifying source code. Production protection still depends on server-side authentication, IAM, network policy, audit logging, and keeping production credentials off contributor machines.

## What runs locally

| Component | Purpose | Host access |
| --- | --- | --- |
| Kordi Desktop | Native React and Tauri client | Local process |
| Cloud API | Accounts, contacts, chats, groups, and synchronization | `127.0.0.1:17081` |
| Postgres | Product data for local test accounts | Docker network only |
| Redis | Sessions and transient coordination | Docker network only |
| NATS JetStream | Local event delivery | Docker network only |
| MinIO | Attachments and object-storage testing | `127.0.0.1:19000` |
| MinIO console | Local object-store inspection | `127.0.0.1:19001` |
| Cloud agent runner | Scheduled and hosted-agent work | Docker network only |

The runner uses a local sandbox volume and talks only to the isolated Cloud API. It does not use the hosted runner, production data, or a Kubernetes cluster.

## Prerequisites

- macOS with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed
- Node.js 22+
- pnpm 10.29.3+
- Rust installed through `rustup`
- Docker Desktop or Docker Engine with Compose v2
- `openssl` and `curl`

Confirm the main tools before starting:

```bash
node --version
pnpm --version
rustc --version
docker version
docker compose version
```

## First-time setup

Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm debug:cloud:up
```

The first backend build compiles the Rust server and can take several minutes. The helper:

1. Generates random local credentials in `deploy/dev/.env` if the file does not exist.
2. Builds the server from the current checkout.
3. Starts the dependency containers.
4. Waits for the API health check.

Expected health endpoint:

```text
http://127.0.0.1:17081/health
```

Verify the stack before opening the desktop:

```bash
pnpm debug:cloud:smoke
```

Expected result:

```text
[kordi-debug] Healthy isolated Cloud API: http://127.0.0.1:17081/health
```

## Start one desktop instance

Launch the native desktop against the local API:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

Create a test account through the normal sign-up screen. The account, sessions, messages, and attachments remain inside the local Docker volumes.

Use dummy account data for development. Provider API keys or subscription sessions entered into the desktop remain developer-owned credentials; do not use production service identities or credentials supplied by another person.

## Start multiple isolated desktop users

Use two or more local profiles for contacts, groups, unread state, message synchronization, and reconnect testing:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm dev:cloud:multi -- --reset --users user1,user2
```

Each window receives its own local desktop profile and Vite port while sharing the same local backend. Sign in with a different local test account in each window.

The default profiles use:

| Profile | Local UI port |
| --- | --- |
| `user1` | `127.0.0.1:1482` |
| `user2` | `127.0.0.1:1484` |
| `user3` | `127.0.0.1:1486` |

`--reset` deletes only the selected desktop profiles before launch. It does not delete accounts stored in the local Postgres volume. Omit it when testing session restoration or cached state.

Instance logs are written under:

```text
app/desktop/.multi-instance-logs/
```

## Common development workflows

### Desktop-only change

Keep the backend running and restart the desktop after changing branches or native code:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

For frontend-only iteration, `pnpm dev:web` is faster, but it does not validate native Tauri commands, keychain storage, OAuth loopback behavior, sidecars, system proxy handling, or the updater.

### Cloud API change

Rebuild and restart the local server from the current checkout:

```bash
pnpm debug:cloud:up
pnpm debug:cloud:smoke
```

Follow the server logs while reproducing a request:

```bash
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml logs -f cloud-server
```

### Database migration change

Test both paths:

1. Start with existing local volumes and confirm the migration upgrades them.
2. Reset the stack and confirm a fresh database starts successfully.

The reset command permanently deletes local debug data, so run it only after preserving anything you still need:

```bash
pnpm debug:cloud:reset -- --yes
pnpm debug:cloud:up
```

### Attachment change

Inspect the local object store at:

```text
http://127.0.0.1:19001
```

The local MinIO credentials are in the ignored `deploy/dev/.env` file. Never paste that file into an issue, PR, screenshot, commit, or chat.

## Inspect the environment

Show service health and published ports:

```bash
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml ps
```

Check the API directly:

```bash
curl -fsS http://127.0.0.1:17081/health
```

Follow all container logs:

```bash
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml logs -f
```

Stop the containers while preserving local test data:

```bash
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml stop
```

Start them again with the normal helper:

```bash
pnpm debug:cloud:up
```

## Troubleshooting

### Docker image pull returns `EOF`, times out, or ignores the VPN

Docker image pulls are performed by the Docker daemon. Shell proxy variables do not always reach the daemon even when normal terminal traffic works.

Configure Docker Desktop or the Docker daemon to use your own proxy URL, then retry:

```text
HTTP proxy:  <YOUR_PROXY_URL>
HTTPS proxy: <YOUR_PROXY_URL>
```

Do not hard-code a personal proxy address in repository files. If Docker is using system-proxy mode but pulls still fail, switch Docker to a correctly configured manual proxy or repair the daemon configuration rather than weakening the application's production guard.

### Port is already in use

Find the process or container using a local port:

```bash
lsof -nP -iTCP:17081 -sTCP:LISTEN
docker compose ls
```

Stop the stale Kordi debug stack or choose unused ports through the `KORDI_DEBUG_API_PORT`, `KORDI_DEBUG_MINIO_PORT`, and `KORDI_DEBUG_MINIO_CONSOLE_PORT` variables in the ignored `deploy/dev/.env` file.

When changing the API port, pass the same origin to the desktop.

### Backend is unhealthy

```bash
pnpm debug:cloud:smoke
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml ps
docker compose --env-file deploy/dev/.env \
  -f deploy/dev/compose.yaml logs --tail=200 cloud-server postgres redis nats minio
```

Resolve the unhealthy dependency first, then rerun `pnpm debug:cloud:up`.

### Development launch rejects the API origin

This is expected when the variable is missing, invalid, or points at production. Use the explicit loopback origin:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

Do not patch around the guard. If a shared non-production environment is required, use an operator-approved staging origin with independent data and credentials.

### OAuth login is unavailable

Password sign-up and login work without third-party OAuth configuration. The desktop reads the server's authentication capabilities, so Google and GitHub buttons appear gray and cannot be clicked when their OAuth credentials are absent. Use email and password for normal local account testing.

Google or GitHub login requires separate developer-owned OAuth applications. Never copy the production client ID or secret. Configure these exact loopback callbacks:

```text
http://127.0.0.1:17081/v1/cloud/auth/oauth/github/callback
http://127.0.0.1:17081/v1/cloud/auth/oauth/google/callback
```

Enter each provider's matching values with the interactive helper. It hides the
secret while typing, atomically updates the ignored `deploy/dev/.env`, and only
recreates the development Cloud API and runner:

```bash
pnpm debug:cloud:oauth -- github
pnpm debug:cloud:oauth -- google
```

The helper writes these keys without printing their values:

```text
KORDI_OAUTH_GITHUB_CLIENT_ID=...
KORDI_OAUTH_GITHUB_CLIENT_SECRET=...
KORDI_OAUTH_GOOGLE_CLIENT_ID=...
KORDI_OAUTH_GOOGLE_CLIENT_SECRET=...
```

Never paste an OAuth client secret into an issue, pull request, chat, or shell
command. Enter it only at the helper's hidden terminal prompt.

The server never returns missing environment-variable names or OAuth secrets to the login screen.

## Validation before opening a PR

Run the focused local-stack contracts:

```bash
node --test scripts/local-debug-stack.test.mjs
```

Run the complete repository checks when the change is ready:

```bash
pnpm check:ci
```

For behavior changes, manually verify the relevant paths with local test accounts:

- Fresh sign-up and login
- Relaunch with preserved session data
- Direct messages in both directions
- Group messages and session switching
- Unread state across two desktop profiles
- Offline/reconnect synchronization
- Attachment upload and download when affected

Include the exact commands and results in the PR description. Redact tokens, account identifiers when necessary, filesystem paths, credentials, and private infrastructure details.

## Reset everything

Permanently delete all local debug containers, networks, volumes, and generated credentials:

```bash
pnpm debug:cloud:reset -- --yes
```

The next `pnpm debug:cloud:up` generates new local credentials and a fresh database. The reset helper is scoped to the `kordi-debug` Compose project and does not contact or modify a hosted environment.

## Contributor access boundaries

Ordinary feature development should not require production SSH, Kubernetes, database, object-store, signing, release, or secret-manager access.

A shared staging environment, when needed, must use separate identities, databases, buckets, encryption keys, OAuth applications, runner tokens, and logs. Never clone the production secret set into staging or a developer laptop.

Repository code and local Docker access give a contributor full control over their own test environment only. Production access is controlled by server-side IAM and infrastructure policy, not by hiding local debug functionality.

The allowlisted operator launcher described in [`hosted-cloud-developer-guide.md`](hosted-cloud-developer-guide.md) is for approved core-maintainer diagnostics only. It is not an alternative contributor setup and never gives the desktop direct database credentials.

## Related guides

- [`community-contributor-guide.md`](community-contributor-guide.md): community contribution paths and review expectations
- [`development.md`](development.md): monorepo command map
- [`run-cloud-desktop.md`](run-cloud-desktop.md): desktop launch reference
- [`hosted-cloud-developer-guide.md`](hosted-cloud-developer-guide.md): approved shared staging and operator workflows
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): branch, validation, and review workflow
