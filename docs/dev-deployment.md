# Development deployment

This document describes the Phase 2 self-service development deployment path from the
CI/CD redesign (#1595, design section 7 of #1590). Authorized developers dispatch
`deploy-dev.yml` to deploy an exact commit to an allocated development stack on the shared
development host over an IAP tunnel. The workflow stays `workflow_dispatch` while the host
is shared.

Related documents:

- [Deployment runbook](deployment-runbook.md) — shared locking, deployment records, rollback.
- [Development environment isolation](development-environments.md) — environment selection.
- [Hosted cloud developer guide](hosted-cloud-developer-guide.md) — operator tunnel path.

Existing operator scripts keep working unchanged. This phase adds a tested transport
interface around them; it does not replace them.

## 1. Dispatch inputs

| Input | Required | Contract |
| --- | --- | --- |
| `sha` | yes | Full 40-character lowercase commit SHA. `scripts/dev-stack-allocate.mjs validate-inputs` rejects anything else. |
| `stack` | yes | Allocated stack identifier from `deploy/dev/stack-allocations.json`. Lowercase letters, digits, and single dashes, 2-32 characters, not reserved. |

The workflow refuses a dispatch from any ref other than the default branch, then checks out
the default branch as trusted workflow code. The `sha` input selects the revision that is
fetched and built on the development host; it never selects the code that runs on the
runner.

## 2. Authorization model

Every dispatch is authorized from trusted event and repository data, never from the inputs.

| Gate | Source of truth | Failure behavior |
| --- | --- | --- |
| Dispatch ref | `github.ref` must equal the default branch | Hard failure before any credential is requested. |
| Deployer | `KORDI_DEV_DEPLOYERS` repository or `dev` environment variable (comma-separated GitHub logins, case-insensitive) | Missing or empty configuration refuses every deployer; an unlisted actor is denied. |
| Stack ownership | `deploy/dev/stack-allocations.json` committed to the repository | Missing, malformed, unallocated, expired, or not-owned stacks are denied. |
| Check evidence | `scripts/check-sha-readiness.mjs` for the exact `sha` and the `CI required` check | A missing readiness script is a hard failure, not a skip; failed or stale evidence is denied. |
| Destructive actions | `--confirm-stack <id>` in the transport, only in `cleanup` | Missing or mismatched confirmation refuses the command. |

Arbitrary fork code does not obtain development privileges by passing tests: the actor must
be allowlisted, the stack must be allocated to that actor, and the revision must have
successful applicable checks recorded for the exact SHA.

The `dev` environment exists so the workflow can use environment-scoped credentials. While
the host is shared it has no required reviewers; do not add a public URL to it.

## 3. Allocation registry

`deploy/dev/stack-allocations.json` is the trusted allocation registry:

```json
{
  "version": 1,
  "stacks": [
    {
      "id": "issue-1234",
      "owner": "github-login",
      "createdAt": "2026-09-19T00:00:00Z",
      "expiresAt": "2026-10-19T00:00:00Z"
    }
  ]
}
```

Rules enforced by `scripts/dev-stack-allocate.mjs`:

- `version` must be `1`; `stacks` must be an array of well-formed entries. Unknown fields
  are rejected so a typo cannot silently change allocation semantics.
- `id` is lowercase alphanumeric and dashes, 2-32 characters, no leading/trailing or
  consecutive dashes. Duplicate ids and reserved ids are rejected.
- Reserved ids: `default`, `host-wide`, `main`, `operator`, `prod`, `production`, `shared`,
  `staging`.
- `owner` is a GitHub login. Ownership is compared case-insensitively.
- `createdAt` and the optional `expiresAt` are ISO-8601 UTC timestamps; `expiresAt` must be
  later than `createdAt`. An expired allocation is denied.
- Active allocations may not share a derived port plan. Ports are derived deterministically
  from the stack id inside reserved ranges, so a collision is detected before deployment and
  fails closed.
- A missing or unreadable registry file is a hard failure. The workflow never invents an
  allocation.

Allocation changes are reviewed repository changes: add or extend an entry through a pull
request and let the owners review it. This command never writes the registry and performs no
destructive operations.

```text
node scripts/dev-stack-allocate.mjs validate-inputs --stack <id> --sha <full-sha>
node scripts/dev-stack-allocate.mjs check --stack <id> --actor <login>
node scripts/dev-stack-allocate.mjs plan --stack <id> --actor <login> --json
node scripts/dev-stack-allocate.mjs list
```

`plan` prints the deterministic runtime plan the workflow passes to the transport:

| Field | Meaning |
| --- | --- |
| `composeProject` | `kordi-<id>`; the only Compose project the stack may touch. |
| `lock` | `stack-<id>`; the host-side lock name. |
| `workdirName` | Per-stack checkout directory name under the configured stack root. |
| `envFile` | Stack-local `deploy/dev/.env` relative to the checkout. |
| `ports` | Distinct `api`, `minio`, and `minioConsole` host ports. |

Exit codes: `0` allowed, `1` denied or invalid, `2` usage error.

## 4. IAP transport

The workflow authenticates with workload identity federation (WIF/OIDC); there are no
long-lived cloud keys. `google-github-actions/auth` is pinned by commit SHA and receives the
provider and service account from environment-scoped secrets.

| Name | Kind | Purpose |
| --- | --- | --- |
| `KORDI_DEV_WIF_PROVIDER` | environment secret (`dev`) | Workload identity provider resource. |
| `KORDI_DEV_DEPLOY_SERVICE_ACCOUNT` | environment secret (`dev`) | Deployment service account. |
| `KORDI_DEV_GCP_PROJECT` | repository or environment variable | Explicit Google Cloud project. |
| `KORDI_DEV_SSH_ZONE` | repository or environment variable | Explicit zone. |
| `KORDI_DEV_SSH_TARGET` | repository or environment variable | Explicit instance. |
| `KORDI_DEV_STACK_ROOT` | repository or environment variable | Absolute host directory that contains the per-stack checkouts. |
| `KORDI_DEV_DEPLOYERS` | repository or environment variable | Comma-separated authorized GitHub logins. |

If the transport ever requires a long-lived SSH key instead of WIF and OS Login, it must be
an environment-scoped secret named `KORDI_DEV_SSH_PRIVATE_KEY`, least-privileged, rotatable,
and separate from personal accounts. Do not describe key-based SSH as free of long-lived
secrets.

`scripts/dev-deploy-stack.sh` never inherits gcloud defaults. Project, zone, instance, stack
root, compose project, ports, and repository URL must all be provided explicitly; any missing
value fails closed. The transport:

1. uploads the trusted `scripts/with-deploy-lock.sh` and `scripts/lib/deploy-lock.sh` into a
   host-side tooling directory (from the runner's default-branch checkout);
2. runs the requested subcommand under the host-side `stack-<id>` lock;
3. deploys by fetching the exact SHA into the stack's own checkout and running
   `scripts/dev-cloud-up.sh` with the stack's compose project, env file, and ports;
4. runs `scripts/dev-cloud-smoke.sh` for the `smoke` subcommand;
5. prints `KORDI_DEV_ARTIFACT_DIGEST=sha256:<hex>` for the deployed `cloud-server` image.

```text
bash scripts/dev-deploy-stack.sh deploy --stack <id> --sha <full-sha>
bash scripts/dev-deploy-stack.sh smoke --stack <id>
bash scripts/dev-deploy-stack.sh cleanup --stack <id> --confirm-stack <id>
```

Add `--dry-run` to print the exact remote script, lock invocation, and transport command
without executing anything.

Stacks are not publicly reachable. The transport only publishes host ports on loopback and
does not create ingress rules, load balancers, or public preview URLs.

## 5. Locking

CI and laptop paths share the host-side per-stack lock `stack-<id>`; GitHub concurrency
groups serialize workflow runs but do not protect against a laptop deployment.

- The workflow uses `concurrency.group: deploy-dev-<stack>` with
  `cancel-in-progress: false`, so a running development deploy is never cancelled.
- The transport takes `stack-<id>` through `scripts/with-deploy-lock.sh` on the development
  host before it mutates the stack checkout or containers.
- The default timeout is 1800 seconds (`KORDI_DEV_LOCK_TIMEOUT`); a timeout exits non-zero
  and prints the current owner metadata.
- Lock files live in `${KORDI_DEPLOY_LOCK_DIR:-/tmp/kordi-deploy-locks}` on the host. Crash
  recovery, stale-lock rules, and manual cleanup are defined in
  [deployment runbook](deployment-runbook.md).
- A laptop operator deploying the same stack on the development host must take the same
  host-side lock, for example (run on the host, or through an SSH session on the host):

```bash
scripts/with-deploy-lock.sh stack-<id> --timeout 1800 -- bash scripts/dev-cloud-up.sh
```

Take `host-wide` only for resources genuinely shared by every stack, never to work around a
stack lock.

## 6. Smoke checks

`scripts/dev-cloud-smoke.sh` runs on the development host through the same transport and
lock. It verifies that `postgres`, `redis`, `nats`, `minio`, `cloud-server`, and
`cloud-agent-runner` are running and that the Cloud API `/health` endpoint reports healthy,
then reports which developer-owned OAuth providers are configured. A failed smoke check
fails the workflow and is recorded in the deployment record as the verification summary.

## 7. Deployment records

After a successful deploy and smoke check the workflow writes a record with
`scripts/record-deployment.mjs`:

```bash
node scripts/record-deployment.mjs \
  --environment dev \
  --stack <id> \
  --sha <full-sha> \
  --actor <login> \
  --artifact sha256:<deployed-image-id-hex> \
  --verification "smoke check passed; workflow run <run-url>" \
  --workflow <run-url>
```

The record contains the environment, stack, revision, actor, artifact digest, verification
summary, and workflow URL, with credential-shaped text redacted. Records are host-local
operational evidence and are not committed (see `deploy/deployment-records/.gitignore`).
The workflow uploads the record with the redacted diagnostics artifact so it remains
available without granting `contents: write` to the deployment job.

## 8. Job summary and diagnostics

The job summary reports the revision, stack, actor, deploy/smoke/record outcomes, the
deployment record path, and a link to the diagnostics artifact. It also points to this
document for the private connection procedure; it never prints host identifiers.

Raw transport output is captured to files, redacted (credential patterns plus the configured
identifier values), and only then printed and uploaded as the
`dev-deploy-diagnostics-<run-id>` artifact. Raw logs are never uploaded. If redaction cannot
run, the artifact upload fails closed.

## 9. Cleanup and destructive actions

- `cleanup` requires `--confirm-stack <id>` equal to `--stack`. It stops only
  `kordi-<id>` with `docker compose down --remove-orphans`; it never removes volumes and
  never touches another stack's Compose project.
- Removing a stack checkout directory or its volumes is an operator action outside this
  transport. Confirm the stack is expired or released in the allocation registry, take the
  `stack-<id>` lock, and remove only that stack's directory and project.
- The workflow never runs cleanup; destructive actions are not part of the dispatch path.

## 10. Connecting to an allocated stack

Stacks stay private. Use the existing IAP tunnel procedure with the operator-provided
target values; do not commit them.

```bash
gcloud compute ssh <instance> \
  --project <project> \
  --zone <zone> \
  --tunnel-through-iap \
  -- -N -L 127.0.0.1:<local-port>:127.0.0.1:<stack-api-port>
```

Then verify `http://127.0.0.1:<local-port>/health` and point an isolated desktop profile at
that loopback origin. The full preflight and profile rules are in
[development environment isolation](development-environments.md) and the
[hosted cloud developer guide](hosted-cloud-developer-guide.md). Never expose a stack
publicly to provide a preview URL.

## 11. Failure behavior

The workflow fails closed when any of the following is true:

- the dispatch ref is not the default branch;
- the actor is missing from `KORDI_DEV_DEPLOYERS` or the variable is empty;
- the registry is missing or malformed, the stack is reserved, unallocated, expired, owned
  by someone else, or collides with another active stack's ports;
- `scripts/check-sha-readiness.mjs` is absent or reports missing/failed evidence for the
  exact SHA;
- any explicit transport identifier is unset;
- the host-side lock cannot be acquired before the timeout;
- deploy, smoke, or recording fails, or the deploy reports no valid artifact digest.
