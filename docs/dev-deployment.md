# Development backend deployment

Every successful post-merge pipeline can update the shared development backend automatically.
Contributors can also deploy a tested branch to a privately allocated stack.
Neither path exposes a public preview or uses production credentials.

## Shared development

`backend-delivery.yml` starts after **Post-merge CI** succeeds on `main`. It verifies both
`CI required` and `Post-merge CI required` for the exact revision, from GitHub Actions in
this repository, using push evidence on `main`. Failed or newer superseding checks block it.

The workflow builds the cloud server and cloud agent runner together for Linux amd64.
Each image is exported as Docker and OCI archives from the same build. The bundle manifest
binds the revision, build run ID, image configuration IDs, OCI digests, and archive checksums.
Build outputs are retained for 30 days. Production promotes this bundle without rebuilding.

After building, the workflow serializes shared-development updates and compares the
candidate with the revision actually deployed on the host. Unrelated new main commits do
not prevent a tested backend from deploying. An older late-finishing build cannot overwrite
a newer deployed revision. The host rechecks the observed state under its lock before any
image or container changes.
The deployment job uses the `dev` environment and short-lived OIDC credentials over IAP.
All image verification, the host lock, Compose update, health checks, and durable records
run on the destination machine. Both backend services use the built images with
`--no-build`. The existing development environment file and volumes remain in use.

The public workflow exposes revision/digest/outcome metadata only. Raw command output stays
private. A failed deployment is recorded even when no image was applied. Development
migration failures require a forward fix; an application rollback does not restore a database.

## Your allocated stack

1. Obtain an allocation in `deploy/dev/stack-allocations.json` through a reviewed PR.
2. Push your branch and wait for `CI required` to pass.
3. Run `pnpm deploy:dev --stack <allocated-stack>`. It uses the full local HEAD revision.
   Add `--sha <full-sha>` to choose another tested revision.
4. Follow the **Deploy development stack** workflow for smoke results and the deployment record.

Any contributor with repository write access can request deployment. The triggering user's
current access and allocation ownership are checked server-side. Fork-origin evidence,
missing credentials, expired allocations, port collisions, and unverified revisions fail closed.
The workflow itself always runs from `main`; branch code receives no production privileges.

New stacks initialize their checkout before the dirty-tree guard is applied. Existing dirty
checkouts are rejected so local operator changes cannot be overwritten.

Useful allocation commands:

```sh
node scripts/dev-stack-allocate.mjs list
node scripts/dev-stack-allocate.mjs plan --stack <allocated-stack> --actor <github-login> --json
```

Connect through the approved IAP tunnel using a task-owned loopback port. See
[development environments](development-environments.md) and the
[hosted developer guide](hosted-cloud-developer-guide.md). Desktop backend previews use the
community profile; native iPhone backend tests use **Kordi Beta**.

## Environment setup

Configure `dev` with a `main`-only deployment branch policy and no approval requirement.
Keep infrastructure identifiers in environment secrets, never repository files or public logs.

| Secret | Purpose |
| --- | --- |
| `KORDI_DEV_WIF_PROVIDER` | OIDC workload identity provider restricted to this repository and dev environment |
| `KORDI_DEV_DEPLOY_SERVICE_ACCOUNT` | Development-only deployment identity |
| `KORDI_BACKEND_PROJECT`, `KORDI_BACKEND_ZONE`, `KORDI_BACKEND_TARGET` | Explicit shared-development destination |
| `KORDI_BACKEND_STATE` | Absolute host state/record directory owned by the deploy identity |
| `KORDI_BACKEND_ENV_FILE` | Existing isolated development credentials file |
| `KORDI_BACKEND_API_PORT` | Dedicated loopback API port; existing task ports are preserved |
| `KORDI_BACKEND_LOCK_DIR` | Provisioned group-writable host lock directory shared with operators |
| `KORDI_BACKEND_SSH_USER`, `KORDI_BACKEND_SSH_KEY` | Optional dedicated account/key when OS Login is unavailable; rotate the key and keep it environment-scoped |
| `KORDI_BACKEND_COMPOSE_PROJECT` | Existing shared-development Compose project |
| `KORDI_DEV_GCP_PROJECT`, `KORDI_DEV_SSH_ZONE`, `KORDI_DEV_SSH_TARGET` | Explicit allocated-stack destination |
| `KORDI_DEV_STACK_ROOT` | Allocated-stack checkout root |

The shared stack must already be provisioned with its isolated credentials and loopback API
at its explicitly configured loopback port. The host requires Python 3, Docker with Compose, and access to the shared
host lock directory. Allocate permissions to this development host only; its identity must
not access production services, credentials, or data.

A manual **Backend delivery** run can retry a tested main revision. A tested revision can update shared development if it advances or matches the deployed
revision. Rerunning an older build does not silently roll development backward.

## Cleanup and recovery

Allocated-stack cleanup remains explicit:

```sh
bash scripts/dev-deploy-stack.sh cleanup --stack <allocated-stack> --confirm-stack <allocated-stack>
```

It stops the named Compose project without deleting volumes. Coordinate ownership before
removing expired stacks. Shared-development updates never call stack cleanup, delete volumes,
or reconcile production infrastructure. See the [deployment runbook](deployment-runbook.md)
for locks, failure records, and the distinction between application rollback and database restore.
