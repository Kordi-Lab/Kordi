# Development environment isolation

Use this document before starting any Kordi preview, debug session, backend process, or OAuth test. The environment must be selected before a client is launched.

## Decision matrix

| Work | Required environment | Client origin |
| --- | --- | --- |
| Ordinary contributor or isolated feature work | Local Docker backend | `http://127.0.0.1:17081` |
| Approved isolated work on a remote development host | Private development host reached through an IAP-style SSH tunnel | `http://127.0.0.1:17081` through the tunnel |
| Native iPhone backend development | `Kordi Beta` scheme plus either isolated backend above | `http://127.0.0.1:17081` |
| Desktop-only production operator preview | Allowlisted operator launcher | `https://kordi.ai` |
| Work that can affect or restart a product server | Corresponding product-server machine | Validate through canonical production origin `https://kordi.ai` |

If the impact, authorization, or environment identity is uncertain, stop and fail closed. An isolated environment cannot substitute for required product-server validation.

## Isolation invariants

- Start work from the latest `origin/main`.
- Never copy production credentials, account sessions, databases, object storage, or user data into a development environment.
- Use separate developer-owned GitHub and Google OAuth applications. Never reuse production OAuth clients.
- Keep PostgreSQL, Redis, NATS, MinIO, and sandbox services private. Every deliberately host-published development port, including the application API, must bind to loopback.
- A remote development host must accept administrative access through an approved private access path such as IAP, must not carry a product service account, and must not have network access to product services.
- Each isolated desktop window must use `VITE_KORDI_DEV_PROFILE=community`, a unique `io.kordi.cloud.*` profile, the gray development icon, and no production updater endpoint.
- The allowlisted desktop operator profile uses the color product icon. The profile launcher derives the icon from the validated environment profile, so a title or profile name cannot make a development client look like Product.
- The `Kordi Beta` iOS scheme must keep its `ai.kordi.ios.beta` identity, `kordi-beta://oauth/callback`, gray icon, and loopback origin. The `Kordi` scheme must keep the production identity, callback, color icon, and `https://kordi.ai` origin.
- Keep real project names, instance names, IP addresses, account names, and credentials out of commits, issues, pull requests, screenshots, and shared logs.

## Local isolated backend

Run the complete isolated stack from the repository root:

```bash
pnpm debug:cloud:up
pnpm debug:cloud:smoke
```

Launch a named desktop profile against the loopback API:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-isolated --title "Kordi Dev" --port 1422
```

See [Local development with an isolated Kordi backend](self-hosted-debug.md) for OAuth, multi-user, log, validation, and reset commands.

## Remote isolated backend through IAP

The approved remote development host runs the same isolated Docker stack. Its API remains bound to its own loopback interface. Export private values only in the local terminal, then use the lifecycle-bound launcher:

```bash
export KORDI_DEV_GCP_PROJECT="<DEV_GCP_PROJECT>"
export KORDI_DEV_SSH_ZONE="<DEV_GCP_ZONE>"
export KORDI_DEV_SSH_TARGET="<DEV_GCE_INSTANCE>"

pnpm dev:cloud:remote
```

The launcher verifies the active GitHub account against the ignored local allowlist, creates an IAP loopback tunnel, waits for the health endpoint, requires both development OAuth providers, and launches the gray isolated desktop profile. Exiting the desktop command also closes its tunnel. It refuses to reuse an already-serving local port because that would make the remote target ambiguous.

For transport-only diagnosis, the equivalent low-level tunnel is:

```bash
gcloud compute ssh "<DEV_GCE_INSTANCE>" \
  --project "<DEV_GCP_PROJECT>" \
  --zone "<DEV_GCP_ZONE>" \
  --tunnel-through-iap -- \
  -N -L 127.0.0.1:17081:127.0.0.1:17081
```

Keep a manually created diagnostic tunnel open, then validate and launch the same named profile from a second terminal:

```bash
curl --fail --silent --show-error http://127.0.0.1:17081/health

VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile dev-isolated --title "Kordi Dev" --port 1422
```

The tunnel is transport only. It does not authorize product access, and the remote host must continue to satisfy every isolation invariant above.

## Native iPhone environments

The generated Xcode project contains two installable app identities:

| Scheme | Display name | Bundle identifier | API | OAuth callback | Icon |
| --- | --- | --- | --- | --- | --- |
| `Kordi Beta` | Kordi Beta | `ai.kordi.ios.beta` | `http://127.0.0.1:17081` | `kordi-beta://oauth/callback` | Gray |
| `Kordi` | Kordi | `ai.kordi.ios` | `https://kordi.ai` | `kordi://oauth/callback` | Color |

The bundle identifiers isolate Keychain, UserDefaults, local databases, cached files, and installation state, so both apps can remain installed on one device. The client validates the entire bundle/origin/callback combination at launch and fails closed if build settings are crossed.

For Beta development, start the local stack or keep the approved development-host tunnel open, then select `Kordi Beta` in Xcode. The loopback route works in the iOS Simulator. A physical iPhone cannot use a loopback service on the Mac; do not weaken the checked-in origin or expose the development API publicly to work around that boundary.

## Development OAuth applications

Create separate developer-owned OAuth applications with these exact callback URLs:

```text
http://127.0.0.1:17081/v1/cloud/auth/oauth/github/callback
http://127.0.0.1:17081/v1/cloud/auth/oauth/google/callback
```

The GitHub OAuth application callback URL must contain the complete path. In Google Auth Platform, add `http://127.0.0.1:17081` as an authorized JavaScript origin and add the complete Google callback URL as an authorized redirect URI.

Kordi-controlled development and product servers must report both `google` and `github` from `/v1/cloud/auth/capabilities` before OAuth testing begins. The desktop login surface keeps both official entry points available even if capability discovery is delayed or temporarily fails; provider-start errors remain visible and actionable instead of degrading the page to password-only guidance.

The isolated backend also permits the native Beta handoff at `kordi-beta://oauth/callback`. That custom scheme is an app return target, not a provider callback, so it belongs in the server redirect-after allowlist and must not be entered in GitHub or Google provider consoles.

Store credentials only through the hidden-input helper on the machine running the backend:

```bash
pnpm debug:cloud:oauth -- github
pnpm debug:cloud:oauth -- google
```

The helper writes the ignored `deploy/dev/.env` file with mode `0600` and restarts only the isolated API and runner services. Do not paste secrets into shell history, documentation, issues, or pull requests.

## Product paths

For a desktop-only production operator preview, first verify that the active GitHub account is listed in `deploy/dev/operator-github-allowlist.txt`, then use the approved launcher and acknowledgement:

```bash
KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
pnpm dev:cloud:operator -- "https://kordi.ai"
```

Work that changes hosted server or runner code, routes, authentication, schema or data, server configuration, destructive or recovery behavior, deployment state, or anything requiring a product-server restart must use the corresponding product-server machine. Follow the [hosted environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug) and validate the deployed product through `https://kordi.ai`.

Product deployment helpers fail closed unless `KORDI_CLOUD_GCP_PROJECT`, `KORDI_CLOUD_SSH_ZONE`, and `KORDI_CLOUD_SSH_TARGET` are all set explicitly. Never rely on the active gcloud project for a deploy.

## Before committing or pushing

Stage the intended files, then run:

```bash
pnpm check:english
git diff --check --cached
pnpm test:scripts
```

`pnpm check:english` rejects Han characters in changed files and branch commit messages relative to `origin/main`. Set `KORDI_ENGLISH_BASE=<ref>` only when the pull request intentionally targets a different base.
