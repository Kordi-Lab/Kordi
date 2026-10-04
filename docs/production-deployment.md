# Protected production promotion

Production promotes the exact backend images already verified in shared development.
It never rebuilds source on the product server and never deploys a mutable image tag.

## Operator workflow

A successful Backend delivery run automatically queues a production promotion after its
matching development result is verified. An administrator, including the triggering user,
can approve it in the production environment. Automatic promotions use `backup=auto` and
conservative `forward-only` recovery; they never assume that reverting images is compatible
with a changed schema. A superseded build that did not update development queues no promotion.

To explicitly authorize compatible image rollback, or promote another verified bundle:

1. Open a successful **Backend delivery** run and copy its run ID.
2. Use `auto` for the backup input to create and restore a fresh PostgreSQL backup on
   the product host, or provide an existing verified receipt ID. Backup data never leaves
   the product machine and is never uploaded to Actions.
3. Run **Deploy production** from `main`, supplying the build run ID, backup receipt ID,
   and either `backward-compatible` or `forward-only` schema compatibility.
4. One repository administrator approves the promotion; this may be the triggering user.
5. The workflow rechecks readiness after approval and delegates the mutation to the
   production machine. Use the resulting revision/digest/outcome record to confirm success.

The `production` environment must restrict deployment branches to `main`, require one of
its administrator reviewers, and allow self-review. CI/deployment changes require one
administrator decision. An administrator may authorize their own PR merge through the
review-only exception; required CI still applies. The production deployment concurrency group
is shared by every revision. Neither branch previews nor fork-origin CI evidence may use
production privileges.

## Evidence and artifacts

The preflight accepts only a completed successful `backend-delivery.yml` run in this
repository on `main`. It selects immutable artifact IDs from the current run attempt.
Missing, expired, duplicated, or previous-attempt artifacts are rejected.

The development result must report success for the same revision, build run, and both image
digests. Archive checksums, image config IDs, OCI manifest digests, platform, and revision
labels are verified before transport and again on the host. Both `CI required` and
`Post-merge CI required` must have successful latest evidence for the exact revision from
trusted main push workflows. Branch ancestry alone is insufficient.

Build bundles expire after 30 days. Rebuild and reverify development before promoting an
expired bundle. Rerunning a build does not let old development evidence authorize new images.

## Host transaction

Every mutation runs on the corresponding production machine:

1. Acquire the shared host-wide `flock` in the configured host lock directory.
2. Verify the bundle and backup receipt before changing running services.
3. Verify that the agent sandbox NetworkPolicy exists and isolates sandbox pods.
4. Capture both previous images as immutable digests and preserve their local references.
5. Import both approved OCI images and verify their digests in the host image store.
6. Change only the server and runner deployment images, using digest-pinned references.
7. Wait for both rollouts and validate the canonical `https://kordi.ai/health` endpoint.
8. Write a durable host record and a safe workflow result before releasing the lock.

This path does not rebuild source, reconcile unrelated storage/media manifests, or run
from a laptop lock. Manual operators must use the same host lock directory. Provision it
with a shared operator group, setgid ownership, and group-writable lock files so CI and
operator identities actually contend for the same lock.

## Agent sandbox network boundary

Agent sandbox pods run model-directed commands. The runner labels them
`app.kubernetes.io/component: agent-sandbox`, and
`bridges/cloud-server/deploy/k3s/manifests/agent-sandbox-network-policy.yaml` admits no
inbound traffic to them and limits their outbound traffic to cluster DNS and public
addresses. Promotion does not apply manifests, so it checks this policy instead: if
`networkpolicy/kordi-cloud-agent-sandbox` is missing, selects other pods, admits inbound
traffic, or lets egress reach private, carrier-grade NAT, link-local, or loopback ranges,
the promotion stops before any image changes with the stage
`sandbox network policy verification`.

Apply the policy once per cluster, and again whenever the manifest changes, from a
checkout of the promoted revision on the production machine:

```bash
sudo k3s kubectl apply -f bridges/cloud-server/deploy/k3s/manifests/agent-sandbox-network-policy.yaml
sudo k3s kubectl -n kordi-cloud get networkpolicy kordi-cloud-agent-sandbox
```

Then run `bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh` on the same machine
and require `[smoke] ok`. Its egress check proves from an unlabeled control pod that the
Cloud server, database, and node addresses are reachable, then proves that a sandbox pod
still resolves DNS and reaches a public address but cannot reach any of them or the
metadata endpoint.

## Runner credentials during a rollout

Runner leases issued before run-scoped credentials existed have no stored credential
hash. The server accepts the shared runner token alone for such a lease only while it is
current, so runs in flight during the first rollout finish. A run that an old runner
leases from the new server during the rollout overlap cannot report progress and is
retried after its 120-second lease expires; to avoid that window, scale the runner to
zero before promotion and back to one afterwards.

If rollout or health fails after images were applied and the schema was declared
`backward-compatible`, the helper restores and verifies both previous images. For
`forward-only`, it records that a forward fix is required. Database restoration is always
a separate approved operation; application rollback never claims to restore a database.

## Content removal rollout

The release that adds schema version 116 removes copies of deleted, hidden, and edited
messages only for changes made after it is installed. Deploying it rewrites and deletes
nothing. Copies of content changed earlier stay in replay rows, stored digests, and object
storage until an operator runs the history backfill on the product machine. Until then,
earlier versions of messages edited before the upgrade keep replaying to members and to
former members until replay journal retention removes them (up to 90 days). After the
promotion succeeds:

1. Confirm that the promotion's backup receipt is verified.
2. Run `kordi-cloud-server backfill-content-removal` without arguments. It is a dry run
   that reports counts and writes nothing. Record the counts.
3. Get explicit approval for those counts, then run
   `kordi-cloud-server backfill-content-removal --apply`. Its changes remove copies and
   cannot be reverted from the database.
4. Follow the removal job backlog query in [data deletion](data-deletion.md#worker) until
   the `backfill` job has `completed_at` set.

Set `KORDI_ATTACHMENT_BUCKET_UNVERSIONED=1` only after the checks in
[data deletion](data-deletion.md#reported-version-and-attestation).

## Backup receipt

The protected backup directory contains `<backup-id>.json` and its referenced data file.
The directory and files must not be writable by unrelated users; symlinks are rejected.
A receipt has this shape (all values below are synthetic):

```json
{
  "version": 1,
  "environment": "production",
  "file": "snapshot.dump",
  "size": 12345,
  "sha256": "sha256:<64-hex-checksum>",
  "createdAt": "2026-09-19T10:00:00Z",
  "restoreVerification": {
    "success": true,
    "backupSha256": "sha256:<same-64-hex-checksum>",
    "completedAt": "2026-09-19T10:05:00Z"
  }
}
```

The backup job writes this receipt only after successfully restoring the exact backup to
an approved isolated restore target. Do not create evidence from a filename or an archive
listing alone. The deployment helper verifies nonzero size, the actual file checksum,
production environment, creation within the last 24 hours, and a successful restore after
creation for that checksum. A missing or stale backup blocks promotion before image imports.
With `backup=auto`, the host helper verifies that the running backend uses the expected
PostgreSQL database, checks available disk space, creates a logical dump, and restores it
into a temporary namespace on the same node. The restore pod has no service-account token,
no network access, and no TCP listener. It is deleted after verification. Existing backup
timers remain in place; this additional pre-promotion check covers PostgreSQL, not object
storage or a complete infrastructure restore. Verified dumps remain in protected host
storage for operator-managed retention; low disk space blocks a new promotion.

## Environment secrets

| Secret | Purpose |
| --- | --- |
| `KORDI_PRODUCTION_WIF_PROVIDER` | GitHub OIDC trust restricted to the production environment and approved workflow |
| `KORDI_PRODUCTION_DEPLOY_SERVICE_ACCOUNT` | Production-only deploy identity |
| `KORDI_BACKEND_PROJECT`, `KORDI_BACKEND_ZONE`, `KORDI_BACKEND_TARGET` | Explicit production destination |
| `KORDI_BACKEND_STATE` | Protected host deployment state and records directory |
| `KORDI_BACKEND_LOCK_DIR` | Shared host lock directory used by CI and manual operators |
| `KORDI_BACKEND_BACKUP_ROOT` | Protected backup receipt and data directory |
| `KORDI_BACKEND_SSH_USER`, `KORDI_BACKEND_SSH_KEY` | Optional dedicated SSH identity when OS Login is unavailable; environment-scoped and rotatable |

Do not put infrastructure values in repository variables, docs, artifacts, or public logs.
The production host requires Python 3, kubectl access to the existing backend deployments,
and permission to import images through k3s containerd. The deployment identity must be
unable to obtain development credentials; development identities must not reach production.
Raw remote command output is not uploaded. Deployment artifacts contain only public
revision/digest identifiers, backup verification hashes, stages, and outcomes.
