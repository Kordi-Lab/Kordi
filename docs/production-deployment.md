# Protected production promotion

Production promotes the exact backend images already verified in shared development.
It never rebuilds source on the product server and never deploys a mutable image tag.

## Operator workflow

A successful Backend delivery run automatically queues a production promotion after its
matching development result is verified. An administrator, including the triggering user,
can approve it in the production environment. Automatic promotions use `backup=auto` and
conservative `forward-only` recovery; they never assume that reverting images is compatible
with a changed schema. A superseded build that did not update development queues no promotion.

Before approving a promotion that adds schema version 112, complete step 1 of the
[agent trust rollout](#agent-trust-rollout) and run its verification command. Until the
database records that version, promotion stops before any image changes, with the stage
`agent trust rollout setting verification`, while the server deployment does not set
`KORDI_AGENT_CONTEXT_LEGACY_DESKTOP` to `allow_without_opt_outs` or `deny`.

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
4. Until the database records schema version 112, verify that the server deployment sets
   `KORDI_AGENT_CONTEXT_LEGACY_DESKTOP` (see [agent trust rollout](#agent-trust-rollout)).
5. Capture both previous images as immutable digests and preserve their local references.
6. Import both approved OCI images and verify their digests in the host image store.
7. Change only the server and runner deployment images, using digest-pinned references.
8. Wait for both rollouts and validate the canonical `https://kordi.ai/health` endpoint.
9. Write a durable host record and a safe workflow result before releasing the lock.

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

## Agent trust rollout

The release that adds schema version 112 moves every group that already exists to
mention-only agent context (`history_scope='mentions'`). Mac apps from before that
release are legacy desktop executors (context contract 1): they build agent context
from their local cache. With `KORDI_AGENT_CONTEXT_LEGACY_DESKTOP` at its server
default, `deny`, a legacy Mac stops answering other members' requests to its owner's
agent in every one of those groups. Those requests fall back to Kordi Cloud, which
runs them only when the owner's provider credentials are available to Cloud;
otherwise the requester gets a failed reply. Before the upgrade, the owner's Mac
answered them. The owner's own requests keep running on a legacy Mac until someone in
the conversation turns on "Don't let AI use my messages"; then the owner is asked to
update. See [group agent context](development/group-agent-context.md#desktop-executor-contract).

For the rollout window, use `allow_without_opt_outs`:

1. Before the promotion, set it on the production machine. Promotion changes only
   images, so the manifest value in
   `bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml` does not
   reach a running cluster by itself. The server reads it once at startup. Setting
   it restarts the running server pods; a server from before version 112 does not
   read it:

   ```bash
   sudo k3s kubectl -n kordi-cloud set env deployment/kordi-cloud-server KORDI_AGENT_CONTEXT_LEGACY_DESKTOP=allow_without_opt_outs
   ```

   Verify it before approving the promotion. This prints `allow_without_opt_outs`:

   ```bash
   sudo k3s kubectl -n kordi-cloud get deployment/kordi-cloud-server -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].env[?(@.name=="KORDI_AGENT_CONTEXT_LEGACY_DESKTOP")].value}{"\n"}'
   ```

2. Publish the release note that Mac owners must update Kordi for other members'
   requests in groups to keep running on their Mac.

While it is set, legacy Macs answer other members in mention-only groups with their
local history, as before the upgrade, so mention-only context is enforced only for
Kordi Cloud runs and updated Macs. Opt-outs are always enforced: a legacy Mac never
answers where an opt-out applies to the run. Until the switch back, do not describe
mention-only context as enforced by Kordi's servers for every Mac.

Promotion checks step 1, because it does not apply the manifest. While the
`cloud_schema_versions` table has no row for version 112, a promotion stops before any
image changes, with the stage `agent trust rollout setting verification`, unless the
`server` container of `deployment/kordi-cloud-server` sets
`KORDI_AGENT_CONTEXT_LEGACY_DESKTOP` once, to the literal value `allow_without_opt_outs`
or `deny`. The host failure log names the command from step 1. Run it, verify it, and
promote again. An explicit `deny` passes the check: it is a deliberate choice to stop
legacy Macs from answering other members right away. Once version 112 is recorded, the
check no longer applies.

Switch back to `deny` once legacy Macs have stopped reporting readiness. This query
reads no content:

```sql
SELECT count(DISTINCT device_id) FROM cloud_agent_desktop_capabilities
WHERE context_contract < 2 AND updated_at > now() - interval '7 days';
```

When it returns 0, or the owners still on legacy Macs were told to update, set
`KORDI_AGENT_CONTEXT_LEGACY_DESKTOP=deny` the same way and change the manifest value
to match. The repository test for the manifest accepts either documented value, so
the switch back needs no test change.

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
