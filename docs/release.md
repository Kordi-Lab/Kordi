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
- the local `kordi` agent runtime sidecar

### Agent runtime

Primary entrypoint:

```bash
pnpm build:agent
```

This build produces the local runtime binary used by the desktop app and any standalone runtime workflows.

### Standalone Bridges network layer

Primary entrypoints:

```bash
pnpm build:bridges
pnpm build:registry
```

These explicit commands build standalone products with release lifecycles that
are separate from Kordi Desktop:

- the local CLI / daemon binary
- the registry service

They are not invoked by the desktop release workflow.

## Sidecar packaging

The desktop app uses:

```bash
pnpm prepare:sidecars
```

This command:

1. builds the agent binary
2. copies `kordi` into `app/desktop/src-tauri/binaries`

`pnpm dev:desktop` and `pnpm build:desktop` both call this workflow.

## Hosted Desktop beta releases

Signed Hosted Desktop beta releases use two different version strings:

- App/package version: `0.0.1-beta.N`
- Git tag and GitHub prerelease: `V0.0.1.betaN`

Ad-hoc releases are explicit, per-release exceptions to the signed production
procedure. The beta.6 acceptance-only procedure below is retained as a
historical reference. A later ad-hoc release must be approved independently,
must stay off the normal beta updater channel, and must not be presented as a
notarized production build. Whether it is mirrored to GitHub is also an
explicit release decision.

Use a clean release branch/worktree from the latest `origin/main`. Do not release from a dirty local development worktree.

For the repeatable macOS build environment, resource preflight, privacy gates,
publication order, rollback rehearsal, and cleanup checklist, use the
[macOS desktop release operator runbook](development/macos-desktop-release-runbook.md).

### Release-state and advertising gate

A merged release-preparation change authorizes building and validation; it does
not prove that a version was released. Track the source merge, hosted deploy,
immutable artifacts, updater pointers, legacy/manual metadata, Git tag, and
GitHub prerelease independently.

Do not advertise a version until its immutable DMG has been uploaded and
verified through every hostname used by shipped clients. In particular,
omitting the legacy `downloadUrl` is not enough when `changelogUrl` points to a
missing DMG. Until publication succeeds, `KORDI_RELEASE_VERSION`,
`KORDI_RELEASE_CHANGELOG_URL`, and install copy must continue to identify the
last verified downloadable release.

If an attempt is abandoned, keep the merged fix, stop the build/publisher, and
inventory all external state. Restore changed pointers and advertising metadata
to the last verified release, do not create a tag or GitHub prerelease, and use
a new version next time if any immutable bytes were uploaded. Follow the full
[abandoned-release procedure](development/macos-desktop-release-runbook.md#abandoning-an-incomplete-release).

### Signed desktop release prerequisites

Every production updater release uses a Tauri minisign key and a notarized
Developer ID build. The private Tauri key, its password, and Apple
signing/notary material must be stored in GCP Secret Manager. Only the Tauri
public key is committed in `app/desktop/src-tauri/tauri.conf.json`.

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

Desktop updater artifacts live in the private MinIO bucket `kordi-releases`. Clients never connect to MinIO directly. New clients use `https://kordi.ai`; the same immutable manifests and downloads remain available through `https://coordinar.io` for already-released clients whose embedded updater endpoint cannot change until they install an update. The Cloud server uses the read-only `kordi-release-reader` identity. Release operators use a separate publisher identity that can create/read release objects but cannot delete objects or administer buckets and policies. Cleanup and rollback conditionally PUT a strict unpublished tombstone instead of deleting a pointer; out-of-band pointer deletion is forbidden.

Provision or reconcile these identities from a trusted operator machine:

```bash
export KORDI_CLOUD_SSH_TARGET=kordi-product-app-01
export KORDI_CLOUD_SSH_ZONE=us-central1-b
export KORDI_CLOUD_GCP_PROJECT=hai-gcp-representation
bash bridges/cloud-server/deploy/k3s/create-release-credentials.sh
```

The publisher accepts already-built artifacts and performs no build. Its release directory must contain exactly:

```text
Kordi_0.0.1-beta.N_aarch64.dmg
Kordi.app.tar.gz
Kordi.app.tar.gz.sig
```

Pass the corresponding `Kordi.app` bundle separately. By default, the publisher uses the production profile and checks the clean commit, all version sources, app/archive/DMG contents, updater signature, Developer ID signature, Gatekeeper assessment, privacy patterns, and the `kordi.ai` product origin. A live publication verifies the exact bytes, checksums, updater manifest, stable DMG, and safe legacy metadata through both `kordi.ai` and `coordinar.io`; failure on either origin prevents promotion or restores the prior channel pointer. A dry run performs every local check and writes `release.json`, `checksums.sha256`, and the channel pointer without contacting storage:

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

### Beta.6 ad-hoc external-test preview

Beta.6 is an acceptance-only, ad-hoc-signed external-test preview. It is not Apple-signed, notarized, tagged, mirrored to a public GitHub release, or promoted to `desktop/channels/beta/latest.json`. Invited testers install beta.5.1 manually once and use Apple's per-app **Open Anyway** flow. Do not disable Gatekeeper or remove quarantine attributes.

Use `--release-profile adhoc-preview --channel acceptance`. The publisher rejects every other ad-hoc channel combination. Beta.6 immutable objects are never replaced or promoted to beta. The next Developer ID-signed and notarized release is beta.7; publish beta.7 to acceptance first so preview clients update into a bundle whose embedded endpoint returns them to normal beta.

The bootstrap and preview remain Tauri updater-signed even though their macOS bundles use the ad-hoc identity. Except for the two persistent tunnel commands in their labeled terminals, run every operator block below in the same protected release shell so the cleanup trap, updater key, exact publication date, and metadata digests remain in scope. Define the source commit and artifact roots before building:

```bash
set -euo pipefail
set +x
unset VITE_KORDI_CLOUD_API_BASE
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
RELEASE_COMMIT="$(git rev-parse HEAD)"
ARTIFACT_ROOT="$HOME/.cache/kordi/releases/0.0.1-beta.6-adhoc-${RELEASE_COMMIT:0:8}"
PREVIEW_BUILD_ROOT="$HOME/.cache/kordi/releases/beta6-adhoc"
BOOTSTRAP_BUILD_ROOT="$HOME/.cache/kordi/releases/beta51-bootstrap"
TAURI_SECRET_DIR=
PUBLISHER_SECRET_DIR=

cleanup_preview_release() {
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  unset KORDI_RELEASE_PUBLISHER_ACCESS_KEY KORDI_RELEASE_PUBLISHER_SECRET_KEY
  unset KORDI_RELEASE_S3_ENDPOINT KORDI_RELEASE_S3_BUCKET KORDI_RELEASE_S3_REGION
  if test -n "${TAURI_SECRET_DIR:-}"; then rm -rf -- "$TAURI_SECRET_DIR"; fi
  if test -n "${PUBLISHER_SECRET_DIR:-}"; then rm -rf -- "$PUBLISHER_SECRET_DIR"; fi
}
trap cleanup_preview_release EXIT
install -d -m 700 "$ARTIFACT_ROOT" "$PREVIEW_BUILD_ROOT" "$BOOTSTRAP_BUILD_ROOT"
```

Load only the two Tauri updater-signing secrets. No Apple credential or Developer ID identity is loaded in this preview flow: do not access a `kordi-apple-*` secret, import a p12, or create a signing keychain for this profile.

```bash
TAURI_SECRET_DIR="$(mktemp -d /tmp/kordi-tauri-preview.XXXXXX)"
chmod 700 "$TAURI_SECRET_DIR"
gcloud secrets versions access latest \
  --secret kordi-tauri-updater-private-key \
  --project hai-gcp-representation \
  --out-file "$TAURI_SECRET_DIR/private-key" --quiet
gcloud secrets versions access latest \
  --secret kordi-tauri-updater-private-key-password \
  --project hai-gcp-representation \
  --out-file "$TAURI_SECRET_DIR/password" --quiet
export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SECRET_DIR/private-key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(<"$TAURI_SECRET_DIR/password")"
test -n "$TAURI_SIGNING_PRIVATE_KEY"
test -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
```

Keep those variables loaded through the local prerequisite check, publisher dry run, network publication, and rollback restoration. Build the two literal acceptance targets:

```bash
CARGO_TARGET_DIR="$HOME/.cache/kordi/releases/beta6-adhoc" \
  pnpm --dir app/desktop tauri:build:cloud:adhoc-preview
CARGO_TARGET_DIR="$HOME/.cache/kordi/releases/beta51-bootstrap" \
  pnpm --dir app/desktop tauri:build:cloud:adhoc-bootstrap
```

Stage those outputs into the exact paths consumed by the publisher and the invited-tester handoff. Removing only the staged app first makes repeated staging immune to stale bundle files:

```bash
install -d -m 700 \
  "$ARTIFACT_ROOT/target-beta6/release/bundle/macos" \
  "$ARTIFACT_ROOT/release-beta6" \
  "$ARTIFACT_ROOT/bootstrap"
rm -rf -- "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app"
ditto \
  "$PREVIEW_BUILD_ROOT/release/bundle/macos/Kordi.app" \
  "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app"
cp \
  "$PREVIEW_BUILD_ROOT/release/bundle/dmg/Kordi_0.0.1-beta.6_aarch64.dmg" \
  "$ARTIFACT_ROOT/release-beta6/Kordi_0.0.1-beta.6_aarch64.dmg"
cp \
  "$PREVIEW_BUILD_ROOT/release/bundle/macos/Kordi.app.tar.gz" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz"
cp \
  "$PREVIEW_BUILD_ROOT/release/bundle/macos/Kordi.app.tar.gz.sig" \
  "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig"
cp \
  "$BOOTSTRAP_BUILD_ROOT/release/bundle/dmg/Kordi_0.0.1-beta.5.1_aarch64.dmg" \
  "$ARTIFACT_ROOT/bootstrap/Kordi_0.0.1-beta.5.1_aarch64.dmg"
test -e "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app"
test -s "$ARTIFACT_ROOT/release-beta6/Kordi_0.0.1-beta.6_aarch64.dmg"
test -s "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz"
test -s "$ARTIFACT_ROOT/release-beta6/Kordi.app.tar.gz.sig"
test -s "$ARTIFACT_ROOT/bootstrap/Kordi_0.0.1-beta.5.1_aarch64.dmg"
```

Run the ad-hoc prerequisite gate locally, then generate and preserve the release metadata without contacting storage. Reuse an existing valid beta.6 `pubDate` when repeating the run; otherwise create it once. The dry run and every later publication must use this same value:

```bash
pnpm --dir app/desktop release:prerequisites -- \
  --release-profile adhoc-preview \
  --expected-commit "$RELEASE_COMMIT" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app"
if test -s "$ARTIFACT_ROOT/release-beta6/release.json"; then
  PUB_DATE="$(jq -er 'select(.version == "0.0.1-beta.6") | .pubDate' \
    "$ARTIFACT_ROOT/release-beta6/release.json")"
else
  PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date "$PUB_DATE" \
  --dry-run
test -s "$ARTIFACT_ROOT/release-beta6/release.json"
test -s "$ARTIFACT_ROOT/release-beta6/channel-acceptance-latest.json"
RELEASE_JSON_SHA256="$(shasum -a 256 \
  "$ARTIFACT_ROOT/release-beta6/release.json" | awk '{print $1}')"
ACCEPTANCE_POINTER_SHA256="$(shasum -a 256 \
  "$ARTIFACT_ROOT/release-beta6/channel-acceptance-latest.json" | awk '{print $1}')"
printf 'release.json sha256: %s\nacceptance pointer sha256: %s\n' \
  "$RELEASE_JSON_SHA256" "$ACCEPTANCE_POINTER_SHA256"
```

For publication, expose MinIO only through a temporary loopback tunnel. On the product VM, forward the in-cluster service to VM loopback; from the operator machine, forward that VM loopback port locally:

```bash
# Product VM terminal
kubectl -n kordi-cloud port-forward service/minio 9900:9000 --address 127.0.0.1

# Operator terminal
gcloud compute ssh --zone "us-central1-a" "kordi-product" \
  --project "hai-gcp-representation" -- -N -L 9900:127.0.0.1:9900
```

Load publisher credentials from protected temporary files without printing them, then publish acceptance first. This extends the existing cleanup trap rather than replacing it. The script uploads immutable objects conditionally, verifies their unauthenticated product-domain GET and HEAD routes, writes the channel pointer last, and rolls the pointer back if post-promotion verification fails:

```bash
PUBLISHER_SECRET_DIR="$(mktemp -d /tmp/kordi-release-publisher.XXXXXX)"
chmod 700 "$PUBLISHER_SECRET_DIR"
gcloud secrets versions access latest \
  --secret kordi-release-publisher-access-key \
  --project hai-gcp-representation \
  --out-file "$PUBLISHER_SECRET_DIR/access" --quiet
gcloud secrets versions access latest \
  --secret kordi-release-publisher-secret-key \
  --project hai-gcp-representation \
  --out-file "$PUBLISHER_SECRET_DIR/secret" --quiet
export KORDI_RELEASE_PUBLISHER_ACCESS_KEY="$(<"$PUBLISHER_SECRET_DIR/access")"
export KORDI_RELEASE_PUBLISHER_SECRET_KEY="$(<"$PUBLISHER_SECRET_DIR/secret")"
export KORDI_RELEASE_S3_ENDPOINT=http://127.0.0.1:9900
export KORDI_RELEASE_S3_BUCKET=kordi-releases
export KORDI_RELEASE_S3_REGION=us-east-1
test -n "$KORDI_RELEASE_PUBLISHER_ACCESS_KEY"
test -n "$KORDI_RELEASE_PUBLISHER_SECRET_KEY"

pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date "$PUB_DATE"

assert_preview_metadata_unchanged() {
  test "$(shasum -a 256 "$ARTIFACT_ROOT/release-beta6/release.json" | awk '{print $1}')" \
    = "$RELEASE_JSON_SHA256"
  test "$(shasum -a 256 \
    "$ARTIFACT_ROOT/release-beta6/channel-acceptance-latest.json" | awk '{print $1}')" \
    = "$ACCEPTANCE_POINTER_SHA256"
}
verify_acceptance_manifest() {
  curl -fsS \
    https://kordi.ai/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1 \
    | jq -e --slurpfile release "$ARTIFACT_ROOT/release-beta6/release.json" '
        $release[0] as $local
        | .version == $local.version
          and .pub_date == $local.pubDate
          and .notes == $local.notes
          and .url == ("https://kordi.ai/updates/releases/" +
            $local.version + "/" + $local.platforms["darwin-aarch64"].fileName)
          and .signature == $local.platforms["darwin-aarch64"].signature
      '
}
assert_preview_metadata_unchanged
verify_acceptance_manifest
```

Keep acceptance live while external testers are enrolled. Before sending invitations, rehearse rollback by clearing the pointer, verifying that beta.5.1 receives HTTP 204, and then restoring the exact locally recorded metadata:

```bash
pnpm release:clear-desktop-acceptance
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  https://kordi.ai/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.5.1)" = 204
PUB_DATE="$(jq -r .pubDate "$ARTIFACT_ROOT/release-beta6/release.json")"
test -n "$PUB_DATE"
test "$PUB_DATE" != null
pnpm release:publish-desktop -- \
  --release-profile adhoc-preview \
  --release-dir "$ARTIFACT_ROOT/release-beta6" \
  --app-bundle "$ARTIFACT_ROOT/target-beta6/release/bundle/macos/Kordi.app" \
  --version 0.0.1-beta.6 \
  --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" \
  --pub-date "$PUB_DATE"
assert_preview_metadata_unchanged
verify_acceptance_manifest

TAURI_SECRET_DIR_TO_REMOVE="$TAURI_SECRET_DIR"
PUBLISHER_SECRET_DIR_TO_REMOVE="$PUBLISHER_SECRET_DIR"
cleanup_preview_release
trap - EXIT
test ! -e "$TAURI_SECRET_DIR_TO_REMOVE"
test ! -e "$PUBLISHER_SECRET_DIR_TO_REMOVE"
test -z "${TAURI_SIGNING_PRIVATE_KEY+x}"
test -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}"
test -z "${KORDI_RELEASE_PUBLISHER_ACCESS_KEY+x}"
test -z "${KORDI_RELEASE_PUBLISHER_SECRET_KEY+x}"
test -z "${KORDI_RELEASE_S3_ENDPOINT+x}"
test -z "${KORDI_RELEASE_S3_BUCKET+x}"
test -z "${KORDI_RELEASE_S3_REGION+x}"
```

Send the beta.5.1 bootstrap DMG directly only to the invited testers. On a normally secured macOS arm64 test machine, exercise browser quarantine, install beta.5.1 manually, approve only that app through **Open Anyway**, confirm the beta.6 update once, and verify Tauri signature validation, installation, automatic relaunch, the reported beta.6 version, and preservation of account, Keychain, session, cache, draft, and preference markers. Stop the preview if the update requires disabling a macOS security control or a second manual approval.

Never promote or replace the immutable beta.6 preview objects. Never create the `V0.0.1.beta6` production tag or public GitHub release, and never move the normal beta pointer or stable manual-download pointer to beta.6. When beta.7 is ready, publish its Developer ID-signed and notarized artifact to acceptance first, verify beta.6 upgrades to beta.7, and confirm the beta.7 bundle embeds the normal beta updater endpoint. Then clear acceptance and promote beta.7 through the signed production procedure below. Never copy the private updater key, its password, publisher credentials, or internal MinIO URLs into release notes or logs.

### Version metadata to bump

For each beta release, update and verify all desktop release metadata:

- root `CHANGELOG.md`
- `app/desktop/package.json`
- `app/desktop/package-lock.json`
- `app/desktop/src-tauri/Cargo.toml`
- `app/desktop/src-tauri/tauri.conf.json`
- `app/desktop/src-tauri/tauri.cloud.conf.json` if it contains release metadata
- `app/desktop/src-tauri/Cargo.lock`
- root `Cargo.lock`
- `app/desktop/tests/releaseVersion.test.mjs`

The changelog update is a release gate, not a post-release follow-up. Before
merging the preparation PR:

1. Compare the candidate branch with the previous release tag and inventory
   every merged user-facing change.
2. Add a dated `## [0.0.1-beta.N]` entry with `Added`, `Changed`, and/or `Fixed`
   sections, concise user-facing bullets, and links to the relevant issues or
   pull requests.
3. Update the `[Unreleased]` and version comparison links at the bottom of
   `CHANGELOG.md`.
4. Re-run the comparison after the release commit is pinned. If another
   user-facing change entered `main`, update the changelog and pin the new
   commit before building.

The release-version test requires a dated entry, at least one classified
user-facing bullet, and a comparison link for the exact app version. GitHub
release notes must use the same changelog entry for their user-facing change
list, then append signing status, installation guidance, hashes, deployment
evidence, and rollback results. Do not maintain a second, divergent feature
list only in GitHub release notes.

Run the release metadata test after the bump:

```bash
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
```

### Hosted backend deploy

For beta.7 and later, the updater implementation PR must be merged before any production deployment, artifact build, channel publication, tag, or prerelease. Fetch `origin/main`, record the merge commit, and use that exact commit for every remaining step:

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
6. Verify rollout images, latest `cloud_schema_versions`, private MinIO readiness, and secret-free logs. The server deploy script also requires in-cluster health, public `https://kordi.ai/health`, safe legacy metadata without `downloadUrl`, and HTTP 204 for the unpublished beta updater route.

The pre-publication deployment must retain the last verified legacy version and
URLs. Check that every advertised URL returns HTTP 200 before continuing; a
safe response cannot name the candidate version while its DMG returns HTTP 404.
After a pod rollout, a healthy in-cluster service with a public HTTP 502 usually
means the VM's managed loopback port-forward is still attached to the replaced
pod. Restart only `kordi-cloud-port-forward.service`, then repeat public health,
auth-capability, updater, and CORS verification.

Production Desktop beta builds should connect to the hosted product API (`https://kordi.ai`). Do not build a public DMG with a raw GCP/sslip URL or local tunnel in `VITE_KORDI_CLOUD_API_BASE`.

### Build signed macOS release artifacts

Create a clean detached worktree at `RELEASE_COMMIT`, load the Tauri and Apple secrets into a temporary keychain/environment, and register cleanup traps before importing them. Build with the product default API base by leaving `VITE_KORDI_CLOUD_API_BASE` unset:

```bash
unset VITE_KORDI_CLOUD_API_BASE
pnpm --dir app/desktop tauri:build:cloud:dmg
```

The build runs the release secret guard, prepares sidecars, signs/notarizes the app, creates both the Tauri updater archive/signature and DMG, and verifies that the DMG contains `Kordi.app` plus an `/Applications` drag target. Do not continue unless the output directory contains `Kordi.app`, `Kordi.app.tar.gz`, `Kordi.app.tar.gz.sig`, and `Kordi_0.0.1-beta.N_aarch64.dmg`, and the production prerequisite gate passes against the exact merge commit.

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
strings "$DMG" | rg -F 'https://kordi.ai'
```

### Signed acceptance, promotion, and release (beta.7 and later)

1. Publish the verified immutable `0.0.1-beta.N` objects to `--channel acceptance` with the default production release profile. The publisher validates the prior channel snapshot, uses ETag compare-and-swap conditions, reads back exact pointer bytes, and re-verifies product-domain endpoints. A failed verification restores only the pointer it wrote and re-verifies the restored public state.
2. On a disposable macOS user following acceptance, seed account/session/cache/preference markers; confirm once; verify the signed download, installation, automatic relaunch, new version, normal-beta endpoint embedded in the installed bundle, and preservation of all markers. For beta.7, this test must include migration from the ad-hoc beta.6 preview before acceptance is cleared.
3. Copy the updater archive, change one byte, and verify the Tauri signature check rejects the copy while the installed app remains runnable. Never upload the tampered copy.
4. On a separate installation of the prior production beta, use the update confirmation to open the product-domain manual DMG. Verify the old app never starts its native installer, then drag the new version to Applications once and confirm login, Keychain, canonical sessions, caches, and preferences remain intact.
5. After all acceptance clients have migrated, mark the acceptance channel unpublished with its strict compare-and-swap tombstone and verify HTTP 204 for a client on the prior acceptance version while retaining immutable objects. Do not clear acceptance while beta.6 preview testers still need beta.7.
6. Publish the same immutable signed release to `--channel beta`. The publisher must pass the complete endpoint matrix on both `https://kordi.ai` and the legacy `https://coordinar.io`: supported older clients receive the same signed manifest, current/newer/unsupported clients receive 204, and anonymous DMG GET/HEAD plus updater archive GET/HEAD match the recorded sizes and SHA-256 values. The manifest returned through either hostname uses the canonical `kordi.ai` artifact URL; direct legacy artifact URLs remain byte-identical for clients that already stored them.
7. Exercise rollback with an explicit expected-current-version guard. The command replaces the beta pointer with an unpublished tombstone only if its ETag and version still match, verifies updater 204, stable-DMG 404, and safe legacy metadata through both origins, and restores/re-verifies the release if those checks fail. Then promote the release again and repeat the endpoint matrix:

   ```bash
   RELEASE_VERSION=0.0.1-beta.N
   pnpm release:rollback-desktop-beta -- \
     --expected-current-version "$RELEASE_VERSION"
   ```

8. Only after promotion passes, create the annotated `V0.0.1.betaN` tag at `RELEASE_COMMIT`, push it, and create the GitHub prerelease mirror. Include the merge commit, artifact hashes/sizes, deployed image tag, backup identifier, schema/health results, endpoint matrix, acceptance evidence, and rollback pointer digest.

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
