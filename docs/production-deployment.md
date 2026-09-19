# Production deployment

This document is the contract for the Phase 3 protected production deployment path
(`.github/workflows/deploy-production.yml`, `scripts/production-deploy.sh`,
`scripts/production-deploy-guard.mjs`, and `scripts/check-sha-readiness.mjs`). It covers the
protected environment, dispatch inputs, exact-SHA readiness, immutable artifacts, the shared
deployment lock, backup validation, rollout/health/smoke verification, deployment records,
application rollback versus database restore, forward-fix strategy, and rollback rehearsal.

It does not claim that repository settings or host access have already been changed. A
maintainer must verify every administrative setting and the host-validation steps listed in
[section 11](#11-required-settings-and-remaining-host-validation) before the workflow is used
for production.

Related documents:

- [Deployment runbook](deployment-runbook.md) — shared locking, deployment records, and the
  non-production rollback rehearsal interfaces.
- [Database upgrade validation](database-upgrade-validation.md) — migration compatibility.
- [Development environment isolation](development-environments.md) — never treat an isolated
  development host as a production target.
- [CI/CD](ci-cd.md) — check inventory, merge gate, and failure reporting.

## 1. Protected environment and reviewers

The workflow dispatches manually and the `deploy` job references the protected `production`
environment. Configure the environment as follows; this repository does not change these
settings:

| Setting | Required value |
| --- | --- |
| Environment | `production` |
| Required reviewers | At least two eligible users or one team with at least two eligible members. |
| Prevent self-review | Enabled, so the user who triggered the run cannot approve it. |
| Deployment branches | Protected branch only (`main`); no tag or wildcard patterns. |
| Environment secrets | Only the names in [section 11](#11-required-settings-and-remaining-host-validation). |
| Environment variables | Only the names in [section 11](#11-required-settings-and-remaining-host-validation). |

GitHub requires only one required reviewer to approve, and self-review prevention is an
explicit option. Enable it and keep more than one eligible reviewer available so a deployment
is not blocked when the initiator is the only configured reviewer.

The `preflight` job runs without the environment and has no access to environment secrets. The
`deploy` job cannot read environment secrets until an eligible reviewer approves it.

### Credentials and permissions

- The workflow uses `permissions: contents: read` plus `checks: read` and `actions: read` for
  the preflight checks, and `id-token: write` only on the deploy job for OIDC.
- Cloud API access uses workload identity federation (OIDC); no long-lived service-account JSON
  key is stored in the repository or the environment.
- There is no `secrets: inherit`. Environment secrets are referenced by name only.
- Production credentials are never reachable from pull-request execution: the workflow only
  runs on `workflow_dispatch`, and the protected environment gates the deploy job.
- If the host transport still requires a dedicated SSH key, keep it environment-scoped,
  least-privileged, rotatable, and separate from personal accounts. That key is a long-lived
  secret; do not describe SSH-key use as free of long-lived secrets. Prefer OS Login or another
  short-lived SSH mechanism and evaluate it separately.
- Production credentials must be rotated after any suspected exposure and whenever an operator
  with access leaves.

## 2. Dispatch inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `sha` | yes | Full 40-character lowercase commit SHA already merged into `main`. |
| `artifact` | yes | Immutable image digest: `sha256:<64-hex>` or `<reference>@sha256:<64-hex>`. |
| `backup` | yes | Verified pre-deploy backup identifier. |
| `rollback_plan` | yes | Non-empty rollback summary (application rollback versus database restore). |
| `schema_compatibility` | yes | Non-empty schema compatibility statement for this revision's migrations. |
| `confirm` | no | When provided it must be exactly `deploy-production`. |

Mutable tags such as `latest`, `stable`, or a date tag are rejected before any host command.
The preflight job builds `production-deploy-plan.json` with
`scripts/production-deploy-guard.mjs` and uploads it with the readiness report.

## 3. Exact-SHA readiness

A revision that is on `main` is not automatically deployable. Ancestry is necessary but not
sufficient evidence. The preflight job checks both:

1. **Protected branch ancestry.** `GET /repos/{owner}/{repo}/compare/main...{sha}` must report
   `behind` or `identical`, and `merge_base_commit.sha` must equal the requested SHA.
2. **Exact-SHA checks.** `scripts/check-sha-readiness.mjs` requires at least one successful
   check run for every required check name, on the exact SHA, from a trusted workflow
   identity:

```text
node scripts/check-sha-readiness.mjs \
  --repo <owner/name> \
  --sha <40-hex> \
  --check "CI required" \
  --check "Post-merge CI required" \
  --json
```

- Default required check: `CI required` (the stable terminal check from `blocking-ci.yml`).
- Default trusted workflows: `.github/workflows/blocking-ci.yml` and
  `.github/workflows/postmerge-ci.yml`. A successful run from any other workflow is not
  accepted, even if it has the same check name.
- A check run only counts when its `head_sha` equals the requested SHA, its `status` is
  `completed`, and its `conclusion` is `success`.

| Observed state | Result |
| --- | --- |
| Required check passed for the exact SHA from a trusted workflow | Pass for that check. |
| No check run for the name | Fail: `missing-check`. |
| Run reports a different `head_sha` | Fail: `wrong-sha` (stale or unrelated). |
| Run from an untrusted workflow identity | Fail: `untrusted-workflow`. |
| `skipped`, `neutral`, `cancelled`, `timed_out`, `stale`, `action_required`, `startup_failure`, `failure` | Fail with the matching code. |
| Run still queued or in progress | Fail: `incomplete`. |

The GitHub token is read from `GH_TOKEN` or `GITHUB_TOKEN`; `--api-url` supports an alternate
API endpoint or a local fixture server. `--workflow` overrides the trusted allowlist and should
only change with a reviewed check-contract update.

## 4. Immutable artifacts and provenance

Deployments are identified by an immutable digest, never by a mutable tag:

- The dispatch `artifact` input is validated by `scripts/production-deploy-guard.mjs` before
  any host command; only `sha256:<64-hex>` and `<reference>@sha256:<64-hex>` are accepted.
- The deploy job checks out `main` for the trusted deployment scripts and checks out the
  approved SHA into a separate `source/` directory. `scripts/production-deploy.sh` verifies
  `git -C <source-root> rev-parse HEAD` equals `--sha` and fails closed otherwise, so the
  synced source tree can never be a different revision than the one that was approved.
- `scripts/production-deploy.sh` derives a content-addressed image tag from the approved
  revision and deployment id, builds and imports through the existing operator scripts, then
  resolves the imported image digest from the host image store and fails closed unless it
  equals the approved digest.
- The deployment record stores the approved digest. The build inputs and provenance (revision,
  workflow run, artifact digest) are attached to the deployment record and the preflight plan.
- The requested SHA must contain the operator scripts (`bridges/cloud-server/deploy/`), which
  every revision on `main` does. The wrapper, guard, readiness check, lock, and record tooling
  always come from the trusted `main` checkout, so deploying an older revision does not depend
  on that revision carrying the Phase 1/Phase 3 tooling.

If the trusted build step and the host build can produce different digests for the same
revision, the digest check fails closed and the operator must reconcile the approved artifact
before retrying. See [section 11](#11-required-settings-and-remaining-host-validation).

## 5. Shared deployment lock

Every path that mutates the production host takes the same `host-wide` lock through
`scripts/with-deploy-lock.sh`:

- `scripts/production-deploy.sh` re-executes itself under
  `scripts/with-deploy-lock.sh host-wide --timeout <seconds> -- ...` before touching the host.
- The lock covers source sync, build, deploy, digest verification, rollout/health/smoke
  checks, and the deployment record. The lock is released only after the record is written.
- Lock ownership metadata (`host`, `user`, `pid`, `acquired_at`) is written for diagnostics.
  Never delete a live lock or kill its holder; wait for the owner or coordinate.
- `KORDI_DEPLOY_LOCK_DIR` selects the lock directory. For a laptop deployment and the workflow
  to obey the same lock, both must use the same lock directory on the same machine. The deploy
  job passes `KORDI_PRODUCTION_DEPLOY_LOCK_DIR` from the environment when configured.

GitHub concurrency groups are not a substitute for the host-side lock. The workflow uses
`cancel-in-progress: false`, so an in-flight deployment is never cancelled by a newer dispatch,
and the host-wide lock serializes actual work even when two dispatches run concurrently.

## 6. Backup validation

The pre-deploy backup is a required input, not an optional annotation.

1. Obtain the pre-migration/pre-deploy backup and record its identifier in `backup`.
2. Confirm the backup exists and is restorable. Restore rehearsal on non-production data is a
   Phase 1 prerequisite ([section 12](#12-rollback-rehearsal)).
3. Record the schema compatibility decision in `schema_compatibility`.
4. The wrapper records the backup identifier and the compatibility statement in the deployment
   record and the preflight plan before the lock is released.

A deployment with a missing, empty, or malformed backup identifier is rejected before any host
command. Never put backup credentials or production data into the dispatch inputs or records.

## 7. Rollout, health, and smoke verification

Before and after the operator deploy script applies the revision, the wrapper verifies, in
order:

1. The source tree is checked out at the approved SHA.
2. The approved artifact digest is present in the host image store, so a trusted build/import
   happened before the deployment started.
3. The imported image digest still matches the approved immutable artifact.
4. `kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s`.
5. `/health` through the in-cluster NodePort.
6. `/health` through the public product origin (`https://kordi.ai` by default).

The verification summary is written to the deployment record before the lock is released. A
failure at any step records the failed attempt with the failure summary and exits non-zero;
the rollback plan in the deployment plan is then followed explicitly. Verification is never
skipped silently.

## 8. Deployment records

`scripts/record-deployment.mjs` writes the record. Records contain the environment and stack,
revision, actor, artifact digest, backup identifier, verification summary, rollback outcome,
workflow URL, and timestamp. The workflow uploads records as the
`production-deployment-record` artifact; records are operational evidence and are not
committed to the repository.

Record the deployment even when verification fails. A failed attempt is still deployment
evidence. See the [deployment runbook](deployment-runbook.md#2-deployment-records) for the
record format and field semantics.

## 9. Application rollback versus database restore

Application rollback and database restore are different procedures.

| | Application rollback | Database restore |
| --- | --- | --- |
| Action | Deploy the previous revision and its digest. | Restore the pre-deploy database backup. |
| Data impact | None by itself. | Destroys every write made after the backup. |
| Safe when | The current schema is backward compatible with the previous revision. | Schema or data is corrupted and no forward-fix is viable. |
| Prerequisite | The previous revision and its immutable artifact are still available. | A verified backup exists and restore has been rehearsed. |
| Record | `rollback` outcome. | `rollback` outcome plus the backup identifier. |

Rules:

- A binary rollback is safe only when the schema still supports the older binary. Never assume
  it is safe because the image starts.
- Database restore requires the `host-wide` lock, an explicit operator decision, and an
  acknowledged data-loss window. It is not an automatic failure handler.
- The dispatch `rollback_plan` must state which procedure applies and under which condition.

## 10. Incompatible migrations and forward-fix

When a migration is not backward compatible, an automatic binary rollback is unsafe.

1. Prefer a forward-fix: deploy the corrected revision through the normal gated path. This
   preserves data and is the default strategy.
2. Use expand/contract: add the new shape additively, deploy code that tolerates both shapes,
   migrate data, then remove the old shape in a later release.
3. Restore from backup only when a forward-fix cannot recover the service, and only with
   explicit operator authorization and the acknowledged data-loss window.

The `schema_compatibility` statement must say whether the previous binary remains compatible
and, when it does not, name the forward-fix or restore strategy.

## 11. Required settings and remaining host validation

Repository settings to verify (not changed by this repository):

- Environment `production` with required reviewers, prevent self-review, and `main`-only
  deployment branches.
- Environment variables: `KORDI_PRODUCTION_WIF_PROVIDER`,
  `KORDI_PRODUCTION_DEPLOY_SERVICE_ACCOUNT`, `KORDI_PRODUCTION_GCP_PROJECT`,
  `KORDI_PRODUCTION_GCP_ZONE`, `KORDI_PRODUCTION_SSH_TARGET`, and optionally
  `KORDI_PRODUCTION_DEPLOY_LOCK_DIR`.
- Environment secret: `KORDI_PRODUCTION_SSH_PRIVATE_KEY` only when OS Login or another
  short-lived SSH mechanism is unavailable; assign an owner and a rotation policy.
- Workload identity federation trust restricted to the approved repository, workflow, and
  environment context. Do not grant OIDC issuance to pull-request workflows.

Host validation still required before the workflow is used:

1. **Transport.** Confirm the runner can authenticate to the cloud API with OIDC and reach the
   host with `gcloud compute ssh` (OS Login preferred). If a dedicated SSH key is required,
   confirm the environment-scoped key is accepted and documented with an owner.
2. **Lock sharing.** Confirm the machine that executes the wrapper and the laptop operator path
   use the same lock directory (or set `KORDI_PRODUCTION_DEPLOY_LOCK_DIR` to a shared location).
   The repository cannot verify that a workflow runner and an operator workstation share a
   filesystem; do not claim lock sharing until this is validated.
3. **Artifact presence and digest resolution.** Confirm `sudo k3s ctr images ls` returns the
   approved digest for the content-addressed tag after the build/import step, and confirm the
   trusted build step that produced the approved digest.
4. **Workload identity and rollout names.** Confirm the deployment name, namespace, NodePort
   health endpoint, and public origin match the values used by the wrapper.
5. **Dry run on the host.** Run
   `scripts/production-deploy.sh --dry-run ...` with real identifiers on the operator machine
   and confirm the printed commands match the intended host operations before the first real
   dispatch.
6. **Rollback rehearsal.** Complete the non-production rehearsal in
   [section 12](#12-rollback-rehearsal) and attach the evidence before relying on production
   rollback automation.

## 12. Rollback rehearsal

Rollback and restore must be rehearsed on disposable, non-production data before production
automation depends on them. The rehearsal itself requires host access and is executed by an
operator.

1. Select an isolated development stack and its `stack-<id>` lock. Never use production data.
2. Deploy revision A and record it with `--environment dev` and a smoke verification summary.
3. Deploy revision B with a schema change and record it.
4. Rehearse application rollback to revision A while the schema is still compatible with A.
   Verify health and smoke checks, then record the rollback outcome.
5. Rehearse database restore from the pre-B backup on the isolated stack. Verify data and
   health, then record the restore outcome and backup identifier.
6. Clean up only resources owned by that stack.
7. Attach the records to issue #1592 as the exercise evidence.

If either step fails, fix the procedure and repeat. Production automation must not rely on an
unrehearsed rollback path, and incompatible migrations cannot rely on an unsafe automatic
binary rollback.
