# Shared development and CI/CD testing

Use the approved shared development backend for everyday desktop UI, account,
messaging, and multi-account checks. Use an allocated stack or local Docker for
backend changes, migrations, load tests, resets, and failure injection. Contributors
without shared-environment access can use the [local backend](../self-hosted-debug.md).

Each desktop preview has its own profile and frontend port. The shared API, its
test data, and its OAuth callback port remain stable across previews and deployments.

## Connect once, launch separate previews

Start from an updated checkout and install dependencies with
`pnpm install --frozen-lockfile`. Obtain the approved development target settings,
local preview allowlist, and test-account login details privately from a maintainer.
An entry in the deployment allocation registry does not grant preview allowlist access.

In the terminal that will own the shared connection:

```bash
export KORDI_DEV_GCP_PROJECT="<DEV_GCP_PROJECT>"
export KORDI_DEV_SSH_ZONE="<DEV_GCP_ZONE>"
export KORDI_DEV_SSH_TARGET="<DEV_GCE_INSTANCE>"
export KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE="<LOCAL_PREVIEW_ALLOWLIST>"
pnpm dev:cloud:connect
```

The shared defaults are local and remote API port `18181`. If the provisioned
stack uses different ports, set `KORDI_DEV_LOCAL_API_PORT` and
`KORDI_DEV_REMOTE_API_PORT` explicitly. Keep this terminal open. If the connection
already belongs to another developer session, coordinate with its owner and use
the approved shared connection; do not kill its listener or start a competing tunnel.

In each preview terminal, set the same allowlist file and local API port, then run
one of these commands from the checkout being tested:

```bash
export KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE="<LOCAL_PREVIEW_ALLOWLIST>"
export KORDI_DEV_LOCAL_API_PORT=18181

# First preview terminal
pnpm dev:cloud:shared --profile test-a --port 1438 --title "Kordi Test A"

# Second preview terminal
pnpm dev:cloud:shared --profile test-b --port 1439 --title "Kordi Test B"
```

Use different profile names and frontend ports for concurrent tasks, and retain a
profile when testing session restoration. Closing a preview leaves the shared
connection running. Stop the connection only after its consumers have finished.
These are development profiles with gray icons and production updates disabled.

To check an existing connection without launching another app:

```bash
pnpm doctor:dev --api-base http://127.0.0.1:18181
```

The diagnostic checks health, both OAuth providers, exact callback routing, and a
temporary one-use state round trip. It cancels its own probe states. It does not
test a password, grant provider consent, or prove a complete interactive login.

## Two-account acceptance check

Use the established test accounts supplied for this environment. Profile names
such as `test-a` and `test-b` are local storage labels, not login credentials, and
creating a profile does not create a backend account.

1. Run the diagnostic and confirm both previews use the shared API origin.
2. Sign in with one test account in each preview using its existing login details.
   When switching backends, start a fresh sign-in; do not reuse an old OAuth callback.
3. Confirm known conversations, group membership, and earlier messages are present.
4. Send a clearly labeled test message in each direction and check delivery, read
   state, and synchronization in both windows.
5. Open an existing image or file, then upload and download a small synthetic file.
   If agent/provider behavior changed, verify the selected test account's connection
   and run one bounded test request.
6. Close and reopen one preview with the same profile. Confirm its session and
   history restore, and the other preview remains connected.
7. For authentication changes, test Google and GitHub interactively as applicable.
   A passing doctor check is not a substitute for the browser-to-app return.

For calls, follow the separate [call hosting checks](../call-hosting.md); API health
does not verify media transport. Native testing uses **Kordi Beta**. Its checked-in
loopback default is `17081`, so this desktop shared-connection command does not
automatically route an iOS app to `18181`; follow the approved
[iOS environment setup](../development-environments.md#native-iphone-environments).

## Preserve test data

- Shared accounts, conversations, and files are persistent fixtures. Normal CD
  updates retain the existing environment file and named database/object-store volumes.
- Do not reset the shared stack, delete its volumes, reseed its accounts, or change
  its OAuth configuration as part of a feature test. Use an isolated stack instead.
- If history or an account appears missing, check the API origin and stack first.
  Local Docker, allocated stacks, and shared development have separate databases.
  A fresh app profile can also require sign-in without implying backend data loss.
- Moving a test account requires an explicit, scoped data transfer. The operator
  backs up both databases and related files, rehearses the import in temporary
  databases, checks conflicts, and preserves existing destination records.
- A transfer must account for password hashes, public account IDs, message and
  group references, attachments, and any encrypted provider data. Verify the target
  encryption key, generated columns, triggers, and foreign-key integrity. Do not
  copy unrelated users' credentials, old sessions, or replay queued work.
- Keep source data and verified backups until the transfer has been accepted.
  Remove only task-owned temporary validation resources. Record incomplete uploads
  and pre-existing fixture inconsistencies privately rather than silently rewriting them.

## CI, allocated stacks, and promotion

Run `pnpm check:ci` for the selected checks before submitting a change. CI uses
synthetic fixtures and isolated test services; it must not depend on shared test
accounts, their passwords, or the shared database. The live two-account check above
adds integration evidence; it does not replace `CI required`.

For a backend change, deploy the tested revision to an allocated stack with
`pnpm deploy:dev --stack <allocated-stack>`, then use `pnpm dev:cloud:remote` with
explicit task ports and a separate profile. Check callback routing for that stack
before login. See the [development deployment guide](../dev-deployment.md).

After merge, the exact `main` revision must pass `CI required` and
`Post-merge CI required`. Backend delivery builds one immutable bundle, updates
shared development, and records the actual deployed revision and image digests.
A successful matching development result can queue production promotion. One
administrator approval is sufficient, including approval by the triggering
administrator. Production verifies a backup/restore receipt and promotes those
same images. It never copies the shared development database or test accounts.

For a review, record the frontend revision, tested backend revision, environment
category, checks run, and observed result. Keep credentials, private targets,
account sessions, and raw logs out of PRs and CI artifacts. A green workflow that
skipped a superseded deployment is not evidence that the candidate is running;
check the deployment result and host record.

## Common failures

| Symptom | Check and recovery |
| --- | --- |
| Local API port already occupied | Determine whether it is the approved shared connection. Use the shared launcher for that connection; otherwise choose a task-owned port. Never stop an unrelated listener. |
| `invalid_oauth_state` | Check that login start and provider callback reach the same backend. Run the doctor, correct the owning stack's callback setup, then begin a fresh login. |
| `redirect_uri_mismatch` | Register the exact callback in the development provider application. See [OAuth setup](../development-environments.md#development-oauth-applications). |
| Generic connection error while health succeeds | Inspect the app's transport error and native HTTP permissions. A local app permission/configuration error can fail before a request reaches the backend. |
| Existing account or history missing | Verify stack, API port, profile, and sign-in. Do not reset or create replacement fixtures as a first response. |
| Deployment green but old backend still running | Inspect the actual deployment outcome, revision, and digests; a superseded candidate may have been skipped. |

See [CI/CD contract](../ci-cd.md), [production promotion](../production-deployment.md),
and the [deployment runbook](../deployment-runbook.md) for the required evidence and recovery procedures.
