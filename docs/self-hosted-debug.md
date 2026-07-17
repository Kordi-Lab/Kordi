# Self-hosted developer debug environment

Use this environment for feature work, multi-account sync checks, schema work, and destructive testing. It runs the current Kordi server plus Postgres, Redis, NATS JetStream, and MinIO entirely on the developer's machine.

The helper never copies production data, credentials, snapshots, or configuration. The API and object-store ports bind to `127.0.0.1`, while Postgres, Redis, and NATS have no host ports at all.

## Start the backend

Prerequisites:

- Docker Desktop or Docker Engine with Compose v2
- Node.js and pnpm
- `openssl` and `curl`

From the repository root:

```bash
pnpm install
pnpm debug:cloud:up
```

The first run builds the Rust server image and can take several minutes. The helper creates `deploy/dev/.env` with random local credentials, starts the containers, and waits for this health endpoint:

```text
http://127.0.0.1:17081/health
```

The generated `.env` file is ignored by Git. Do not paste it into issues, commits, screenshots, or chat.

If an image pull fails while normal web traffic works through a VPN or proxy, configure that proxy in Docker Desktop or the Docker daemon as well. Shell proxy variables do not always apply to daemon-side image pulls. Use your own proxy address; do not commit it to this repository.

## Start the desktop

Use the explicit local API origin printed by the helper:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

Create test accounts through the normal sign-up screen. These accounts exist only in the local Postgres volume. Provider API keys or subscription sessions entered in this build remain developer-owned test credentials; do not reuse production service credentials.

Development launches fail closed when `VITE_KORDI_CLOUD_API_BASE` is absent, invalid, or exactly the production origin. Release builds retain the normal product default. This guard prevents accidental development traffic; it is not a security boundary against someone intentionally modifying source code.

## Check, inspect, and reset

Check the running services and API:

```bash
pnpm debug:cloud:smoke
docker compose --env-file deploy/dev/.env -f deploy/dev/compose.yaml ps
docker compose --env-file deploy/dev/.env -f deploy/dev/compose.yaml logs -f cloud-server
```

MinIO's local console is available at `http://127.0.0.1:19001`. Its local credentials are in the ignored `deploy/dev/.env` file.

Permanently delete all local debug volumes and rotate the generated credentials on the next start:

```bash
pnpm debug:cloud:reset -- --yes
```

That command is scoped to the `kordi-debug` Compose project. It does not contact or modify a hosted environment.

## What developers can and cannot access

A developer can inspect and change everything inside their own local containers and local test database. That is intentional and makes backend debugging reproducible.

Repository code and desktop UI checks cannot protect a public production API from a malicious developer. Production access is controlled by server-side IAM, authenticated application APIs, database/network policy, audit logging, and the absence of production credentials on developer machines. Contributors should not receive production SSH, Kubernetes, database, object-store, signing, release, or secret-manager roles for ordinary feature work.

Use separate non-production identities and infrastructure for any shared staging environment. A staging server should have its own database, buckets, encryption keys, OAuth applications, runner tokens, and logs; never clone the production secret set.

## Limitations

- Password sign-up and login work without third-party OAuth configuration.
- GitHub or Google login requires OAuth applications owned by the developer or staging environment, with loopback callbacks configured there.
- The stack does not start a remote cloud-agent runner. Desktop-managed agents still run through the local desktop runtime; runner-specific changes need a separate local runner setup.
- The object-store API and console are loopback-only for debugging and must not be exposed as a deployment pattern.
