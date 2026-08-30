# Standard macOS and iOS release runbook

Use this runbook for a normal signed Kordi Desktop beta and iOS TestFlight
release from the same source commit. It is the short operator path across the
detailed [release guide](../release.md),
[macOS operator runbook](macos-desktop-release-runbook.md), and
[iOS development guide](../ios-development.md). Those documents remain
authoritative for platform-specific recovery and historical procedures.

The target is a fail-closed release with no release-day source repair. Complete
the joint preflight for both platforms before deploying, compiling, uploading,
or tagging either platform.

## Operator checklist

Use this sequence for a standard release; the later sections define each gate:

1. Merge desktop and iOS version/changelog preparation.
2. In one clean worktree, regenerate Xcode and pass desktop source gates plus
   the complete iOS suite.
3. Verify GitHub/App Store version availability, Apple team, App Group,
   TestFlight group, signing, product, and resource prerequisites.
4. Pin one `RELEASE_COMMIT` only after steps 1-3 pass.
5. Back up and deploy the server and runner from that commit; pass health,
   APNs, media, and two-account call acceptance.
6. Build, sign, notarize, scan, and dry-run the macOS artifacts once.
7. Publish macOS acceptance, verify it, promote beta, rehearse rollback, restore,
   and reverify.
8. Archive and export iOS with the signed-in production Xcode account; verify
   the IPA locally.
9. Validate/upload the IPA with the App Store Connect API key and require
   `VALID` plus `Kordi Team` visibility.
10. Recheck the shared commit, push the desktop tag, create the GitHub
    prerelease, verify cross-origin digests, record evidence, and clean up.

Do not begin step 5 if either platform has an unresolved preflight failure. A
healthy run should spend its time on one backend build, one production build per
platform, Apple processing, and explicit acceptance—not source repair or team
discovery.

## Standard-path boundaries

- Use a clean worktree from the latest `origin/main`.
- Pin one merged commit for the backend, desktop app, iOS app, updater metadata,
  tag, and release evidence.
- Keep infrastructure identifiers, Apple team identifiers, accounts,
  credentials, private paths, and raw logs out of commits and shared output.
- The normal desktop path is Developer ID signed and notarized. Do not enter the
  historical beta.6 ad-hoc/bootstrap procedure unless a release owner approves
  that exact exception before any build.
- The production `Kordi` iOS scheme is the only TestFlight scheme. Never archive
  `Kordi Beta` or change either scheme's checked-in origin.
- Do not call a version released merely because its source merged or immutable
  bytes were uploaded. Use the state table below.

## Inputs and release decision

Record these safe values before work starts:

```text
Desktop version: 0.0.1-beta.N
Desktop tag: V0.0.1.betaN
iOS marketing version: X.Y.Z
iOS build number: N
Previous desktop tag: V0.0.1.betaM
Candidate commit: not pinned until joint preflight passes
Desktop channel plan: acceptance -> beta
iOS audience: Kordi Team internal TestFlight
```

Separately confirm, without copying values into the repository:

- the authorized product target;
- the production Apple team used by the product APNs configuration;
- the signed-in Xcode account for that team;
- the App Store Connect API key used for validation and upload;
- the operator-owned ports, worktrees, simulator, DerivedData, and artifact
  directories.

## Phase 1: joint preflight before expensive work

### 1. Prepare and reconcile source

Start with a release-preparation PR. Reconcile the candidate against the
previous desktop tag, update the dated changelog, and align every desktop and
iOS version source. Regenerate the Xcode project whenever `project.yml`
changes.

After the preparation PR is merged, create a clean preflight worktree at
`origin/main` but do not call it `RELEASE_COMMIT` yet:

```bash
git fetch origin main --tags
CANDIDATE_COMMIT="$(git rev-parse origin/main)"
git worktree add --detach /protected/kordi-release-preflight "$CANDIDATE_COMMIT"
cd /protected/kordi-release-preflight
test -z "$(git status --short)"
```

Run source gates:

```bash
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
pnpm --dir app/desktop release:secret-guard
pnpm --dir app/desktop release:prerequisites -- \
  --source-only \
  --expected-commit "$CANDIDATE_COMMIT"

cd app/ios
xcodegen generate
git diff --exit-code -- project.yml Kordi.xcodeproj/project.pbxproj
cd ../..
```

Explicitly verify the iOS values because the desktop release-version test does
not yet enforce them:

```bash
rg 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' app/ios/project.yml
DEVELOPER_DIR="<XCODE_DEVELOPER_DIR>" xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -showBuildSettings \
  | rg 'MARKETING_VERSION|CURRENT_PROJECT_VERSION|PRODUCT_BUNDLE_IDENTIFIER|KORDI_CLOUD_BASE_URL|KORDI_DISTRIBUTION_CHANNEL|APNS_ENVIRONMENT'
```

The Release settings must identify the intended version/build,
`ai.kordi.ios`, `https://kordi.ai`, the production distribution channel, and
production APNs.

### 2. Run the complete iOS suite

Use a task-owned simulator and DerivedData directory. Never reuse or erase
another task's simulator.

```bash
DEVELOPER_DIR="<XCODE_DEVELOPER_DIR>" xcodebuild -quiet \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -destination 'id=<TASK_SIMULATOR_ID>' \
  -derivedDataPath /protected/kordi-ios-derived-data \
  -resultBundlePath /protected/kordi-ios-tests.xcresult \
  -collect-test-diagnostics never \
  test
```

If a test fails, stop before any deployment or desktop build. Fix and merge the
cause, restart the joint preflight, and rerun the focused failure with
`-collect-test-diagnostics on-failure` only when diagnostics are needed. Do not
spend the default ten-minute simulator-diagnostics timeout on a known assertion
failure.

### 3. Verify external prerequisites

Fail before compiling if any item is missing:

- GitHub tag and release name are unused.
- The iOS build number is unused in App Store Connect.
- The production Apple team comes from the approved product configuration, not
  from whichever local provisioning profile happens to match the bundle ID.
- App Group `group.ai.kordi.share` exists and is assigned to both
  `ai.kordi.ios` and `ai.kordi.ios.share`.
- The signed-in Xcode account matches the production Apple team and can create
  or refresh profiles and distribution certificates.
- The App Store Connect API key can validate, upload, and read build/TestFlight
  state. Do not assume it has cloud-signing permission.
- The internal `Kordi Team` TestFlight group exists and is configured for all
  builds.
- A valid Developer ID Application identity is available on the approved
  release Mac.
- The Tauri updater and Apple notarization credentials are available through
  protected files or environment variables.
- Product backup, health, APNs, media, call acceptance, disk, memory, proxy,
  and task-owned port checks are ready.

After every source and external gate passes:

```bash
RELEASE_COMMIT="$CANDIDATE_COMMIT"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test -z "$(git status --short)"
```

Do not silently advance `RELEASE_COMMIT` later. A required source change starts
the joint preflight again before either platform publishes.

## Phase 2: deploy and verify the shared product backend

Follow the product path in the detailed release guide:

1. Back up Postgres and record its safe identifier, size, and digest.
2. Record the current server/runner images and beta pointer bytes/ETag.
3. Sync the exact release source to the authorized product host.
4. Build and deploy server and runner images tagged from `RELEASE_COMMIT`.
5. Preserve the last verified release metadata while candidate artifacts do
   not yet exist.
6. Verify rollout images, schema, zero restarts, secret-free logs, host
   NodePort, public health, auth/CORS, updater fallback, APNs, and media.
7. Complete the two-account voice/video acceptance test.

`KORDI_EXPECT_DESKTOP_RELEASE_UNPUBLISHED` describes the current beta pointer,
not the candidate version. Set it to `true` only when the beta pointer is
already unpublished. When the prior verified beta is still live, set it to
`false` so deployment preserves and verifies that existing release.

The current deployment helpers compile the server once during
`sync-and-build.sh` and again inside the OCI build. Do not add another local or
remote prebuild. Keep the documented pair until the deploy tooling gains a
tested sync-only mode.

## Phase 3: build and publish macOS

Create the physical neutral-path worktree described in the macOS runbook and
use one task-owned artifact root. A standard local release may use a valid
Developer ID Application identity already installed in the approved operator
keychain. Import the protected `.p12` into a temporary keychain only when the
identity is not already installed or the build runs in ephemeral CI.

Load the updater and notarization credentials into a cleanup-trapped protected
shell, leave `VITE_KORDI_CLOUD_API_BASE` unset, and build:

```bash
export RUSTFLAGS="--remap-path-prefix=$HOME=/build"
export CARGO_BUILD_JOBS=1
unset VITE_KORDI_CLOUD_API_BASE
pnpm --dir app/desktop tauri:build:cloud:dmg
```

Require all of the following before storage access:

- `Kordi.app`, updater archive/signature, and DMG exist;
- production prerequisite gate passes for `RELEASE_COMMIT`;
- Developer ID signature, notarization, stapling, Gatekeeper, DMG layout, macOS
  minimum, product origin, checksums, and privacy scan pass;
- a one-byte-modified updater archive is rejected;
- publisher dry run fixes one `pubDate` and records metadata digests.

Publish the production bytes to `acceptance`, verify the complete product-domain
matrix, and run installed migration acceptance when required by the release
policy. Do not build the historical beta5.1/beta.6 ad-hoc bootstrap for a
standard release. If no approved signed acceptance seed exists, stop and make
that release decision before the production build.

After acceptance:

1. Tombstone acceptance with compare-and-swap.
2. Promote the same immutable bytes to `beta`.
3. Verify older clients receive the candidate and current/newer clients receive
   HTTP 204.
4. Verify stable DMG bytes and legacy/manual metadata.
5. Run the guarded beta rollback and restore the exact pointer and `pubDate`.
6. Repeat public verification.

An already-open desktop app checks when its updater component mounts. After a
new beta promotion, restart the prior app or use a deliberate Check for Updates
entrypoint before concluding that the update indicator is missing.

## Phase 4: archive, export, and upload iOS

Use the production Apple team loaded privately from approved product
configuration:

```bash
export KORDI_IOS_TEAM_ID="<PRIVATE_PRODUCTION_TEAM_ID>"
export DEVELOPER_DIR="<XCODE_DEVELOPER_DIR>"
```

Do not infer `KORDI_IOS_TEAM_ID` from local provisioning profiles. Archive with
the signed-in production Xcode account and automatic profile updates:

```bash
xcodebuild -quiet \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /protected/Kordi.xcarchive \
  -derivedDataPath /protected/kordi-ios-archive-derived-data \
  -allowProvisioningUpdates \
  -hideShellScriptEnvironment \
  DEVELOPMENT_TEAM="$KORDI_IOS_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  archive
```

Export with the signed-in Xcode account. Use `method=app-store-connect`,
`destination=export`, automatic signing, the production team, and
`manageAppVersionAndBuildNumber=false` so Apple cannot replace the reviewed
build number.

Verify the exported IPA before upload:

- app and share extension version/build match;
- bundle IDs are `ai.kordi.ios` and `ai.kordi.ios.share`;
- production APNs is embedded;
- both targets and profiles contain `group.ai.kordi.share`;
- both targets use the production team and `get-task-allow` is false;
- `ITSAppUsesNonExemptEncryption` is false;
- product origin is `https://kordi.ai`;
- codesign passes; record the IPA byte size and SHA-256.

Use the App Store Connect API key only after local export verification:

```bash
xcrun altool --validate-app /protected/Kordi.ipa \
  --api-key "<APP_STORE_KEY_ID>" \
  --api-issuer "<APP_STORE_ISSUER_ID>" \
  --p8-file-path /protected/AuthKey.p8 \
  --output-format json

xcrun altool --upload-package /protected/Kordi.ipa \
  --api-key "<APP_STORE_KEY_ID>" \
  --api-issuer "<APP_STORE_ISSUER_ID>" \
  --p8-file-path /protected/AuthKey.p8 \
  --wait \
  --output-format json
```

Require App Store validation and upload success, processing state `VALID`, the
reviewed marketing/build values, and visibility to the internal `Kordi Team`
group. Upload success alone is not the final TestFlight state.

## Phase 5: tag, mirror, record, and clean up

After macOS beta restoration and iOS TestFlight validity:

1. Recheck `RELEASE_COMMIT`, version metadata, and changelog scope.
2. Stage intended files and run `pnpm check:english` before every commit or
   push.
3. Create and push the annotated desktop tag at `RELEASE_COMMIT`.
4. Create the GitHub prerelease with the same changelog bullets, DMG, checksum
   file, signing status, source commit, images, backup, schema, health,
   acceptance, and rollback evidence.
5. Verify GitHub and product DMG sizes and digests match locally.
6. Record the final safe state:

   ```text
   source merged: yes/no
   backend deployed: image tags
   immutable macOS objects verified: yes/no
   acceptance pointer: version/unpublished
   beta pointer: version/unpublished
   stable/manual metadata: version
   tag and GitHub prerelease: yes/no
   iOS build: version/build/processing state
   TestFlight internal group visible: yes/no
   ```

7. Remove only task-owned previews, tunnels, remote port-forwards, simulators,
   DerivedData, build caches, temporary keychains, secret directories, scripts,
   mounts, and worktrees. Preserve final artifacts, checksums, archives, IPA,
   backups, and redacted evidence.

## Failure and recovery rules

| Failure | Required response |
| --- | --- |
| Either platform test fails before pinning | Fix, merge, and restart joint preflight. |
| Source changes after pinning | Stop both platforms and pin the new merged commit. |
| Immutable bytes conflict or fail privacy | Abandon the version; never replace bytes. |
| Acceptance verification fails | Restore the exact prior pointer and verify it. |
| Beta promotion verification fails | Let the publisher restore its pointer, then verify public fallback. |
| iOS team/profile/capability mismatch | Stop before export; repair Apple configuration and regenerate profiles. |
| API key lacks cloud-signing permission | Export with the signed-in production Xcode account; keep the API key for validation/upload. |
| Secret-loading or redaction helper fails | Stop, inventory external state, remove protected files, and do not assume cleanup ran. |

## Secret and log handling

The secret-owning shell must own its cleanup trap. Do not pipe that shell
directly through an untested `sed` or other output consumer: a failed consumer
can interrupt the command and leave protected files behind.

Use this order:

1. Create a mode-700 secret directory and mode-600 raw log.
2. Register cleanup before loading credentials.
3. Run the release command and capture its exit status.
4. Remove credentials and temporary keychains in the same shell.
5. Redact the completed local log.
6. Emit only the safe summary, then delete the raw log.

Never paste credentials, Apple identifiers, infrastructure identifiers,
account names, private paths, or unredacted logs into shared artifacts.
