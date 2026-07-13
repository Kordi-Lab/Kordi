# Release and packaging

This document describes how the Kordi monorepo is expected to package and release its different layers.

## Product surfaces

### Desktop app

Primary entrypoint:

```bash
pnpm build:desktop
```

The desktop app is the end-user product surface. It packages:

- the React app
- the Tauri shell
- local sidecar binaries for `agent` and `bridges`

### Agent runtime

Primary entrypoint:

```bash
pnpm build:agent
```

This build produces the local runtime binary used by the desktop app and any standalone runtime workflows.

### Bridges network layer

Primary entrypoints:

```bash
pnpm build:bridges
pnpm build:registry
```

The Bridges layer ships in two forms:

- the local CLI / daemon binary
- the registry service

## Sidecar packaging

The desktop app uses:

```bash
pnpm prepare:sidecars
```

This command:

1. builds the agent binary
2. builds the Bridges binary
3. copies both into `app/desktop/src-tauri/binaries`

`pnpm dev:desktop` and `pnpm build:desktop` both call this workflow.

## Hosted Desktop beta releases

Hosted Desktop beta releases use two different version strings:

- App/package version: `0.0.1-beta.N` (for example `0.0.1-beta.6`)
- Git tag and GitHub prerelease: `V0.0.1.betaN` (for example `V0.0.1.beta6`)

The current updater bootstrap release is `0.0.1-beta.6` / `V0.0.1.beta6`. Keep the Cloud deployment's legacy metadata fallback on beta.5 until the validated beta channel pointer has been promoted; the signed channel catalog becomes authoritative after promotion.

Use a clean release branch/worktree from the latest `origin/main`. Do not release from a dirty local development worktree.

### Signed desktop release prerequisites

The beta.6 updater uses a Tauri minisign key and a notarized Developer ID build. The private Tauri key, its password, and Apple signing/notary material must be stored in GCP Secret Manager. Only the Tauri public key is committed in `app/desktop/src-tauri/tauri.conf.json`.

The production secret names are:

- `kordi-tauri-updater-private-key`
- `kordi-tauri-updater-private-key-password`
- `kordi-apple-developer-id-p12`
- `kordi-apple-developer-id-p12-password`
- `kordi-apple-notary-issuer-id`
- `kordi-apple-notary-key-id`
- `kordi-apple-notary-private-key`

Create a secret from a protected temporary file without putting its value on the command line:

```bash
gcloud secrets create SECRET_NAME --project "hai-gcp-representation" --replication-policy automatic
gcloud secrets versions add SECRET_NAME --project "hai-gcp-representation" --data-file /protected/path/to/value
```

Retrieve release material only inside a temporary release environment with shell history disabled. Remove temporary files and the temporary keychain after the signed build. Never print secret values:

```bash
gcloud secrets versions access latest --secret SECRET_NAME --project "hai-gcp-representation" --out-file /protected/temporary/path
```

The source-only prerequisite gate is suitable for CI and does not claim that an artifact is publishable:

```bash
pnpm --dir app/desktop release:prerequisites -- --source-only --expected-commit "$(git rev-parse HEAD)"
```

Before publishing built artifacts, omit `--source-only` and pass the exact `Kordi.app` bundle. The gate requires the Tauri signing environment, a valid Developer ID Application identity, successful `codesign --verify`, and successful Gatekeeper assessment.

### Private updater storage and publisher

Desktop updater artifacts live in the private MinIO bucket `kordi-releases`. Clients never connect to MinIO directly: manifests and downloads are served only through `https://coordinar.io`. The Cloud server uses the read-only `kordi-release-reader` identity. Release operators use a separate publisher identity that can create/read release objects but cannot delete objects or administer buckets and policies. Cleanup and rollback conditionally PUT a strict unpublished tombstone instead of deleting a pointer; out-of-band pointer deletion is forbidden.

Provision or reconcile these identities from a trusted operator machine:

```bash
export KORDI_CLOUD_SSH_TARGET=kordi-product
export KORDI_CLOUD_SSH_ZONE=us-central1-a
export KORDI_CLOUD_GCP_PROJECT=hai-gcp-representation
bash bridges/cloud-server/deploy/k3s/create-release-credentials.sh
```

The publisher accepts already-built artifacts and performs no build. Its release directory must contain exactly:

```text
Kordi_0.0.1-beta.N_aarch64.dmg
Kordi.app.tar.gz
Kordi.app.tar.gz.sig
```

Pass the corresponding `Kordi.app` bundle separately. The publisher checks the clean commit, all version sources, app/archive/DMG contents, updater signature, Developer ID signature, Gatekeeper assessment, privacy patterns, and the `coordinar.io` product origin. A dry run performs every local check and writes `release.json`, `checksums.sha256`, and the channel pointer without contacting storage:

```bash
RELEASE_COMMIT="$(git rev-parse HEAD)"
pnpm release:publish-desktop -- \
  --release-dir /protected/kordi-beta.N \
  --app-bundle /protected/kordi-beta.N/Kordi.app \
  --version 0.0.1-beta.N \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date 2026-07-13T00:00:00Z \
  --dry-run
```

For publication, expose MinIO only through a temporary loopback tunnel. On the product VM, forward the in-cluster service to VM loopback; from the operator machine, forward that VM loopback port locally:

```bash
# Product VM terminal
kubectl -n kordi-cloud port-forward service/minio 9900:9000 --address 127.0.0.1

# Operator terminal
gcloud compute ssh --zone "us-central1-a" "kordi-product" \
  --project "hai-gcp-representation" -- -N -L 9900:127.0.0.1:9900
```

Load publisher credentials from protected temporary files without printing them, then publish acceptance first. The script uploads immutable objects conditionally, verifies their unauthenticated product-domain GET and HEAD routes, writes the channel pointer last, and rolls the pointer back if post-promotion verification fails:

```bash
SECRET_DIR="$(mktemp -d /tmp/kordi-release-publisher.XXXXXX)"
chmod 700 "$SECRET_DIR"
trap 'rm -rf "$SECRET_DIR"' EXIT
gcloud secrets versions access latest \
  --secret kordi-release-publisher-access-key \
  --project hai-gcp-representation \
  --out-file "$SECRET_DIR/access" --quiet
gcloud secrets versions access latest \
  --secret kordi-release-publisher-secret-key \
  --project hai-gcp-representation \
  --out-file "$SECRET_DIR/secret" --quiet
export KORDI_RELEASE_PUBLISHER_ACCESS_KEY="$(<"$SECRET_DIR/access")"
export KORDI_RELEASE_PUBLISHER_SECRET_KEY="$(<"$SECRET_DIR/secret")"
export KORDI_RELEASE_S3_ENDPOINT=http://127.0.0.1:9900
export KORDI_RELEASE_S3_BUCKET=kordi-releases
export KORDI_RELEASE_S3_REGION=us-east-1

pnpm release:publish-desktop -- \
  --release-dir /protected/kordi-beta.N \
  --app-bundle /protected/kordi-beta.N/Kordi.app \
  --version 0.0.1-beta.N \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date 2026-07-13T00:00:00Z
```

Promote `--channel beta` only after acceptance installation, automatic relaunch, state preservation, and the one-time manual upgrade path have passed. Never copy the private updater key, its password, publisher credentials, or internal MinIO URLs into release notes or logs.

### Version metadata to bump

For each beta release, update and verify all desktop release metadata:

- `app/desktop/package.json`
- `app/desktop/package-lock.json`
- `app/desktop/src-tauri/Cargo.toml`
- `app/desktop/src-tauri/tauri.conf.json`
- `app/desktop/src-tauri/tauri.cloud.conf.json` if it contains release metadata
- `app/desktop/src-tauri/Cargo.lock`
- root `Cargo.lock`
- `app/desktop/tests/releaseVersion.test.mjs`

Run the release metadata test after the bump:

```bash
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
```

### Hosted backend deploy

The updater implementation PR must be merged before any production deployment, artifact build, channel publication, tag, or prerelease. Fetch `origin/main`, record the merge commit, and use that exact commit for every remaining step:

```bash
git fetch origin main
RELEASE_COMMIT="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main
```

Before updating the hosted backend, inspect the current production state through the product VM without printing secrets:

```bash
gcloud compute ssh --zone "us-central1-a" "kordi-product" --project "hai-gcp-representation"
```

Preserve production data and deploy in place from a clean worktree at `RELEASE_COMMIT`:

1. Create a pre-deploy Postgres dump on the VM.
2. Record the dump path, current Cloud image, and current beta pointer bytes/ETag if present.
3. Sync/build the exact merge commit with `bridges/cloud-server/deploy/sync-and-build.sh`.
4. Provision the release identities, then deploy the server with an image tag derived from the merge SHA:

   ```bash
   export KORDI_CLOUD_IMAGE_TAG="release-${RELEASE_COMMIT:0:12}"
   export KORDI_EXPECT_DESKTOP_RELEASE_UNPUBLISHED=true
   bash bridges/cloud-server/deploy/k3s/create-release-credentials.sh
   bash bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
   ```

5. Deploy runner with `bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh`.
6. Verify rollout images, latest `cloud_schema_versions`, private MinIO readiness, and secret-free logs. The server deploy script also requires in-cluster health, public `https://coordinar.io/health`, safe legacy metadata without `downloadUrl`, and HTTP 204 for the unpublished beta updater route.

Production Desktop beta builds should connect to the hosted product API (`https://coordinar.io`). Do not build a public DMG with a raw GCP/sslip URL or local tunnel in `VITE_KORDI_CLOUD_API_BASE`.

### Build signed macOS release artifacts

Create a clean detached worktree at `RELEASE_COMMIT`, load the Tauri and Apple secrets into a temporary keychain/environment, and register cleanup traps before importing them. Build with the product default API base by leaving `VITE_KORDI_CLOUD_API_BASE` unset:

```bash
unset VITE_KORDI_CLOUD_API_BASE
pnpm --dir app/desktop tauri:build:cloud:dmg
```

The build runs the release secret guard, prepares sidecars, signs/notarizes the app, creates both the Tauri updater archive/signature and DMG, and verifies that the DMG contains `Kordi.app` plus an `/Applications` drag target. Do not continue unless the output directory contains `Kordi.app`, `Kordi.app.tar.gz`, `Kordi.app.tar.gz.sig`, and `Kordi_0.0.1-beta.6_aarch64.dmg`, and the production prerequisite gate passes against the exact merge commit.

### Required artifact privacy scan

Before uploading a DMG to GitHub Releases, mount and scan the actual `.dmg` artifact. The scan must show no local temp paths, no build-machine user paths, no test hostnames/IPs, and no local account/session data.

Use a pattern file so shell quoting cannot corrupt the check:

```bash
DMG=/path/to/Kordi_0.0.1-beta.N_aarch64.dmg
PAT=/tmp/kordi-release-sensitive-patterns.txt
cat > "$PAT" <<'EOF'
pi-clipboard
/var/folders
/Users/
/private/tmp
accountId["']?\s*[:=]\s*["'][^"']+
displayName["']?\s*[:=]\s*["']111
primaryEmail
sessionToken
korde-product
35\.188\.85\.31
sslip\.io
EOF

MOUNT=$(mktemp -d /tmp/kordi-release-scan.XXXXXX)
hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -readonly
rg -n --text --hidden --no-ignore --no-messages -f "$PAT" "$MOUNT" || true
find "$MOUNT" -type f -maxdepth 8 -print0 \
  | xargs -0 strings 2>/dev/null \
  | rg -f "$PAT" || true
hdiutil detach "$MOUNT"
```

If the scan finds sensitive data or local machine paths, do not upload or promote the asset. Immutable objects are never replaced or deleted; if a bad artifact somehow reached versioned storage, abandon that version, rebuild under a new version, and keep every channel pointer away from it. Record the final promoted SHA-256 in the GitHub prerelease notes.

Confirm the DMG still contains the product API origin:

```bash
strings "$DMG" | rg 'https://coordinar\.io|coordinar\.io'
```

### Acceptance, promotion, and release

1. Publish the verified immutable beta.6 objects to `--channel acceptance`. The publisher validates the prior channel snapshot, uses ETag compare-and-swap conditions, reads back exact pointer bytes, and re-verifies product-domain endpoints. A failed verification restores only the pointer it wrote and re-verifies the restored public state.
2. Build an internal `0.0.1-beta.5.1` acceptance package from the merge commit. Its embedded updater key must equal beta.6 and its only endpoint override must be `https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}`. On a disposable macOS user, seed account/session/cache/preference markers; confirm once; verify signed download, installation, automatic relaunch, beta.6 version, and preservation of all markers.
3. Copy the updater archive, change one byte, and verify the Tauri signature check rejects the copy while the installed app remains runnable. Never upload the tampered copy.
4. On a separate beta.5 installation, use the update confirmation to open the product-domain manual DMG. Verify beta.5 never starts its native installer, then drag beta.6 to Applications once and confirm login, keychain, canonical sessions, caches, and preferences remain intact.
5. Mark the acceptance channel unpublished with its strict compare-and-swap tombstone, then verify it while retaining immutable objects:

   ```bash
   pnpm release:clear-desktop-acceptance
   test "$(curl -sS -o /dev/null -w '%{http_code}' \
     https://coordinar.io/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1)" = 204
   ```

6. Publish the same immutable release to `--channel beta`. Verify beta.5 legacy metadata contains beta.6 plus the manual `coordinar.io` URL and no `downloadUrl`; beta.5.1 receives the signed beta.6 manifest; beta.6, beta.7, and unsupported clients receive 204; anonymous DMG GET/HEAD and updater archive GET/HEAD match recorded sizes and SHA-256 values.
7. For this first signed release, exercise rollback to the beta.5 environment fallback with an explicit expected-current-version guard. The command replaces the beta.6 pointer with an unpublished tombstone only if its ETag and version still match, verifies updater 204, stable-DMG 404, and safe legacy metadata, and restores/re-verifies beta.6 if those checks fail. Then promote beta.6 again and repeat the endpoint matrix:

   ```bash
   pnpm release:rollback-desktop-beta -- \
     --expected-current-version 0.0.1-beta.6
   ```

8. Only after promotion passes, create annotated tag `V0.0.1.beta6` at `RELEASE_COMMIT`, push it, and create the GitHub prerelease mirror. Include the merge commit, artifact hashes/sizes, deployed image tag, backup identifier, schema/health results, endpoint matrix, acceptance evidence, and rollback pointer digest.

## Validation before release

Recommended baseline:

```bash
pnpm check
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
pnpm --dir app/desktop release:secret-guard
pnpm --dir app/desktop tauri:build:cloud:dmg
pnpm build:registry
```

Add focused tests for recently changed release surfaces, and always scan the final DMG before upload.

## Ownership

- Desktop packaging changes belong in `app/desktop`
- Runtime binary changes belong in `agent`
- Network and registry release changes belong in `bridges`
- Shared packaging contracts should move into `shared` only when more than one layer depends on them
