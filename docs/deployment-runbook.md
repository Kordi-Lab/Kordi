# Deployment runbook

This runbook covers the Phase 1 operational-safety interfaces from the CI/CD redesign:
shared deployment locking, deployment records, and the non-production rollback/restore
rehearsal. It does not add deployment automation. Existing operator scripts keep working
unchanged; operators wrap them with the shared lock and record the outcome.

Related documents:

- [Development environment isolation](development-environments.md)
- [Hosted cloud developer guide](hosted-cloud-developer-guide.md)
- [Database upgrade validation](database-upgrade-validation.md)
- [Local development with an isolated backend](self-hosted-debug.md)

## 1. Shared deployment locks

GitHub concurrency groups serialize workflow runs only. A laptop deployment bypasses them,
so every path that touches the same host resources must take the same host-side lock.

### Lock names

| Lock | Use |
| --- | --- |
| `stack-<id>` | One development or issue stack. Serializes deployments of that stack only. |
| `host-wide` | Resources that are genuinely shared by every stack on the host, such as a single source-sync/build directory or a node-level operation. |

Take the narrowest lock that protects the resources you touch. Take `host-wide` only when
two deployments really cannot proceed at the same time.

### Location and ownership

- Locks live in `${KORDI_DEPLOY_LOCK_DIR:-/tmp/kordi-deploy-locks}` on the machine that
  executes the deployment.
- Each lock uses `<name>.lock` plus an owner metadata file `<name>.owner` containing
  `lock`, `host`, `user`, `pid`, and `acquired_at`.
- The owner is the process that holds the lock. The backend lock is authoritative; the
  metadata file is diagnostics only and is rewritten by the next owner.

### Timeout

- `scripts/with-deploy-lock.sh` defaults to 600 seconds. Override with `--timeout <seconds>`
  or `KORDI_DEPLOY_LOCK_TIMEOUT`.
- `--timeout 0` fails immediately instead of waiting; use it for "is this lock free?" checks.
- Timeouts are integer seconds. A timeout exits non-zero and prints the current owner
  metadata and the lock path so the operator can coordinate instead of guessing.

### Crash recovery

- `flock` releases automatically when the holding process exits, including `SIGKILL`.
  Leftover `<name>.owner` metadata is stale but harmless and is replaced on the next
  successful acquire.
- On hosts without `flock` (for example stock macOS), `scripts/lib/deploy-lock.sh` uses a
  portable hardlink lock. It removes a stale lock only when the metadata names the current
  host and a process id that is no longer alive. It never breaks a live pid and never
  breaks a lock recorded on another host.
- Never delete a live lock file, and never kill the holder, to clear a stuck deployment.
  Investigate the owner metadata first.

### Cleanup

- Always acquire through `scripts/with-deploy-lock.sh`. It releases the lock on normal exit,
  `SIGINT`, `SIGTERM`, and `SIGHUP`, and propagates the wrapped command's exit code.
- `kordi_deploy_unlock <lock-name>` releases a lock held by the current shell when sourcing
  `scripts/lib/deploy-lock.sh` directly. It is idempotent.
- Stale `.owner` files may be deleted when no deployment is running; they are not locks.

## 2. Deployment records

`scripts/record-deployment.mjs` writes a deterministic JSON record for one deployment
attempt. Records are local operational evidence; they are not committed (see
`deploy/deployment-records/.gitignore`).

```text
node scripts/record-deployment.mjs \
  --environment <dev|production> \
  --stack <id> \
  --sha <full-40-char-sha> \
  --actor <login> \
  --artifact <digest> \
  [--backup <id>] \
  [--verification <summary|file>] \
  [--rollback <outcome>] \
  [--workflow <url>] \
  [--out <path>] \
  [--dry-run] [--force]
```

- Default output path:
  `deploy/deployment-records/<environment>/<YYYYMMDDTHHMMSSZ>-<sha12>.json`.
  `--out <path>` overrides it; an existing directory receives the default filename.
- `--verification` accepts an inline summary, or the path to an existing file whose trimmed
  contents are recorded (maximum 16 KiB).
- `--dry-run` validates and prints the record without writing it.
- An existing record is never overwritten unless `--force` is passed, so a repeated deploy
  of the same revision cannot silently replace evidence.
- Records are written with owner-only permissions (`0600`).

### Record fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Record format version (`1`). |
| `environment` | `dev` or `production`. |
| `stack` | Lowercase stack identifier, for example `issue-1592` or `production-main`. |
| `revision` | Full 40-character commit SHA that was deployed. |
| `actor` | Account login that performed the deployment. |
| `artifact` | Immutable artifact digest: `sha256:<hex>`, a bare 64/96/128-character hex digest, or `<reference>@sha256:<hex>`. |
| `backup` | Pre-deploy backup identifier when applicable, otherwise `null`. |
| `verification` | Smoke/health verification summary, otherwise `null`. |
| `rollback` | Rollback outcome when one was exercised, otherwise `null`. |
| `workflow` | Workflow or build URL for the deployment, otherwise `null`. |
| `recordedAt` | UTC ISO-8601 timestamp of record creation. |

Free-text fields are scrubbed for obvious credential patterns (private keys, common token
formats, `password=...`/`token=...` assignments, credentials embedded in URLs). Redaction is
best-effort defense in depth: never put secrets in a record in the first place, and never
copy production data into one.

### Examples

Record a development stack deployment:

```bash
node scripts/record-deployment.mjs \
  --environment dev \
  --stack issue-1592 \
  --sha "$(git rev-parse HEAD)" \
  --actor operator-one \
  --artifact "sha256:${ARTIFACT_HEX}" \
  --verification "$(cat /tmp/smoke-summary.txt)" \
  --out deploy/deployment-records/dev
```

Record a production deployment with a verified backup and no rollback exercised:

```bash
node scripts/record-deployment.mjs \
  --environment production \
  --stack production-main \
  --sha "$(git rev-parse HEAD)" \
  --actor operator-one \
  --artifact "$IMAGE_REF@$IMAGE_DIGEST" \
  --backup "$BACKUP_ID" \
  --verification /tmp/production-verification.txt \
  --rollback "application rollback not exercised; forward-fix strategy recorded" \
  --workflow "$WORKFLOW_RUN_URL"
```

## 3. Operator adoption

Wrap existing operator scripts with the shared lock. The wrapper runs the command as-is and
propagates its exit code, so it composes with existing shells and CI steps.

```bash
# Legacy single-host systemd path (sync/build runs locally; install runs on the host).
scripts/with-deploy-lock.sh host-wide --timeout 900 -- \
  bash bridges/cloud-server/deploy/sync-and-build.sh

# k3s deployment path. Use host-wide when the script touches shared host resources,
# or stack-<id> when the script is scoped to one stack.
scripts/with-deploy-lock.sh host-wide --timeout 900 -- \
  bash bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh

# Isolated development stack.
scripts/with-deploy-lock.sh stack-issue-1592 --timeout 900 -- \
  bash scripts/dev-cloud-up.sh
```

A recorded deployment runs all of the following inside one `scripts/with-deploy-lock.sh`
invocation, so the lock covers backup, deploy, verification, and recording:

1. Acquire the lock with `scripts/with-deploy-lock.sh`.
2. Create or identify the pre-deploy backup and record its identifier.
3. Deploy the exact revision or immutable artifact digest.
4. Verify rollout, health, and smoke checks (`scripts/dev-cloud-smoke.sh` for development
   stacks).
5. Write the deployment record with `--backup` and `--verification` while the lock is held.
6. Release the lock by exiting the wrapper.

Record the deployment even when verification fails, with the failure summary in
`--verification`; a failed attempt is still deployment evidence.

## 4. Application rollback versus database restore

Application rollback and database restore are different procedures. Do not treat them as
interchangeable.

| | Application rollback | Database restore |
| --- | --- | --- |
| Action | Deploy a previous revision of the application. | Restore the pre-deploy database backup. |
| Data impact | None by itself. | Destroys all writes made after the backup was taken. |
| Safe when | The current schema is backward compatible with the previous revision. | Schema or data is corrupted and no forward-fix is viable. |
| Prerequisite | The previous revision and its artifact are still available. | A verified backup exists and restore has been rehearsed. |
| Record | `--rollback` outcome. | `--rollback` outcome plus the backup identifier in `--backup`. |

Rules:

- A binary rollback is only safe when the schema still supports the older binary. Never
  assume it is safe because the image starts.
- Database restore requires the deployment lock, an explicit operator decision, and an
  acknowledged data-loss window. It is not an automatic failure handler.
- Before any production deploy, confirm the backup exists and is restorable, and record the
  schema-compatibility decision and the rollback plan.

## 5. Incompatible migrations and forward-fix

When a migration is not backward compatible, an automatic binary rollback is unsafe.

1. Prefer a forward-fix: deploy the corrected revision through the normal gated path. This
   preserves data and is the default strategy.
2. Split schema changes using expand/contract: add the new shape additively, deploy code
   that tolerates both shapes, migrate data, then remove the old shape in a later release.
3. Restore from backup only when a forward-fix cannot recover the service, and only with
   explicit operator authorization.

Record the chosen strategy in the deployment record (`--verification` for the compatibility
decision, `--rollback` for the exercised outcome) before or during the deployment, not after.

## 6. Non-production rollback rehearsal

Rollback and restore must be rehearsed on disposable, non-production data before production
automation depends on them. The rehearsal itself requires host access and is executed by an
operator; this repository only defines the procedure and records the outcome.

Procedure:

1. Select an isolated development stack and its `stack-<id>` lock. Never use production data
   or the production environment.
2. Deploy revision A. Record it with `--environment dev`, `--verification` for the smoke
   result, and no rollback field.
3. Deploy revision B that includes a schema change. Verify and record it.
4. Rehearse application rollback to revision A while the schema is still compatible with A.
   Verify health and smoke checks, then record `--rollback "application rollback to <sha12>: <outcome>"`.
5. Rehearse database restore from the pre-B backup on the isolated stack. Verify data and
   health, then record the restore outcome and backup identifier.
6. Clean up only resources owned by that stack. Use stack-scoped commands such as the
   development reset helper; never delete another stack's resources.
7. Attach the record paths to issue #1592 as the exercise evidence.

The rehearsal proves the procedure, not just the command. If either step fails, fix the
procedure and repeat before recording a passing outcome.

## 7. Interfaces reference

| Path | Purpose |
| --- | --- |
| `scripts/with-deploy-lock.sh` | Acquire a shared lock, run a command, release on exit/signals, propagate exit code. |
| `scripts/lib/deploy-lock.sh` | `kordi_deploy_lock <name> <timeout-seconds>` and `kordi_deploy_unlock <name>`. |
| `scripts/record-deployment.mjs` | Validate inputs and write a deployment record. |
| `bridges/cloud-server/deploy/sync-and-build.sh` | Legacy single-host sync/build operator path. |
| `bridges/cloud-server/deploy/k3s/deploy-*.sh` | k3s deployment operator paths. |
| `scripts/dev-cloud-up.sh`, `scripts/dev-cloud-smoke.sh`, `scripts/dev-cloud-reset.sh` | Development stack lifecycle. |

Tests for the locking and record interfaces run with `node --test scripts/deploy-lock.test.mjs
scripts/record-deployment.test.mjs` and as part of `pnpm test:scripts`.
