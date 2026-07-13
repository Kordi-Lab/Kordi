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

- App/package version: `0.0.1-beta.N` (for example `0.0.1-beta.5`)
- Git tag and GitHub prerelease: `V0.0.1.betaN` (for example `V0.0.1.beta5`)

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

Before updating the hosted backend, inspect the current production state through the product VM without printing secrets:

```bash
gcloud compute ssh --zone "us-central1-a" "kordi-product" --project "hai-gcp-representation"
```

For backend or runner changes, preserve production data and deploy in place:

1. Create a pre-deploy Postgres dump on the VM.
2. Sync/build from the release branch with `bridges/cloud-server/deploy/sync-and-build.sh`.
3. Deploy server with `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`.
4. Deploy runner with `bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh`.
5. Verify rollout images, in-cluster `/health`, public `/health`, and latest `cloud_schema_versions`.

Production Desktop beta builds should connect to the hosted product API (`https://coordinar.io`). Do not build a public DMG with a raw GCP/sslip URL or local tunnel in `VITE_KORDI_CLOUD_API_BASE`.

### Build the macOS DMG

Build the Cloud DMG with the product default API base by leaving `VITE_KORDI_CLOUD_API_BASE` unset:

```bash
unset VITE_KORDI_CLOUD_API_BASE
pnpm --dir app/desktop tauri:build:cloud:dmg
```

The build runs the release secret guard, prepares sidecars, builds the Tauri DMG, and verifies that the DMG contains `Kordi.app` plus an `/Applications` drag target.

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
rg -n --hidden --no-messages -f "$PAT" "$MOUNT/Kordi.app" || true
find "$MOUNT/Kordi.app" -type f -maxdepth 8 -print0 \
  | xargs -0 strings 2>/dev/null \
  | rg -f "$PAT" || true
hdiutil detach "$MOUNT"
```

If the scan finds sensitive data or local machine paths, do not upload the asset. If an asset was already uploaded, delete it immediately, rebuild/repack, rescan, and only then upload a replacement. Record the final SHA-256 in the GitHub prerelease notes.

Confirm the DMG still contains the product API origin:

```bash
strings "$DMG" | rg 'https://coordinar\.io|coordinar\.io'
```

### Publish

1. Push the release branch.
2. Create an annotated tag using the `V0.0.1.betaN` convention.
3. Create a GitHub prerelease with the scanned DMG.
4. Include release commit, DMG SHA-256, backend deployment image tags, health checks, and schema verification in release notes.
5. Merge the release branch back to `main` so release metadata and guard changes remain in main history.

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
