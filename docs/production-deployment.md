# Protected production promotion

Production promotes the exact backend images already verified in shared development.
It never rebuilds source on the product server and never deploys a mutable image tag.

## Operator workflow

1. Open a successful **Backend delivery** run and copy its run ID.
2. Prepare a fresh host-owned backup receipt with successful restore evidence for that
   exact backup. The data stays on approved protected storage; never upload it to Actions.
3. Run **Deploy production** from `main`, supplying the build run ID, backup receipt ID,
   and either `backward-compatible` or `forward-only` schema compatibility.
4. A repository administrator other than the triggering user reviews the promotion.
5. The workflow rechecks readiness after approval and delegates the mutation to the
   production machine. Use the resulting revision/digest/outcome record to confirm success.

The `production` environment must restrict deployment branches to `main`, require one of
its administrator reviewers, and prevent self-review. CI/deployment code is protected by
CODEOWNERS review from the same administrators. The production deployment concurrency group
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
3. Capture both previous images as immutable digests and preserve their local references.
4. Import both approved OCI images and verify their digests in the host image store.
5. Change only the server and runner deployment images, using digest-pinned references.
6. Wait for both rollouts and validate the canonical `https://kordi.ai/health` endpoint.
7. Write a durable host record and a safe workflow result before releasing the lock.

This path does not rebuild source, reconcile unrelated storage/media manifests, or run
from a laptop lock. Manual operators must use the same host lock directory. Provision it
with a shared operator group, setgid ownership, and group-writable lock files so CI and
operator identities actually contend for the same lock.

If rollout or health fails after images were applied and the schema was declared
`backward-compatible`, the helper restores and verifies both previous images. For
`forward-only`, it records that a forward fix is required. Database restoration is always
a separate approved operation; application rollback never claims to restore a database.

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
The backup provider and restore rehearsal must be provisioned before the first promotion.

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
