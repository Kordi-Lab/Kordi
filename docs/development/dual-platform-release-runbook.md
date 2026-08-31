# Standard macOS and iOS product release pipeline

This is the authoritative operator sequence for a normal signed Kordi Desktop
beta and iOS TestFlight release from one merged source commit. Use the detailed
[release guide](../release.md),
[macOS operator runbook](macos-desktop-release-runbook.md),
[iOS development guide](../ios-development.md), and
[call hosting guide](../call-hosting.md) for platform-specific commands and
recovery procedures.

The standard order is:

```text
release-preparation PR
  -> pin merged source
  -> inspect or deploy the product backend
  -> build and publish macOS to kordi.ai
  -> tag and mirror macOS on GitHub
  -> archive, verify, and upload iOS
  -> confirm TestFlight processing and internal visibility
  -> clean up and record final state
```

Do not silently reorder these phases. Do not call a release complete because a
version bump merged, a build finished, an object uploaded, or App Store upload
returned success. Each state has its own verification gate.

## Ownership and status

- **Owner:** the release operator authorized for the product environment and
  Apple accounts
- **Source of truth:** this ordered pipeline
- **Supporting references:** the detailed guides linked above
- **Validation basis:** the beta.18 macOS and iOS release on 2026-08-31
- **Security posture:** fail closed; never bypass signing, privacy, immutable
  object, conditional-pointer, or product-isolation checks

If a supporting document conflicts with the order in this pipeline, stop and
reconcile the documentation before releasing. Historical beta.5.1/beta.6
bootstrap and ad-hoc procedures are not part of the standard path.

## Release-day scope: qualification is already merged

Release operation is not feature development. The candidate must arrive on
`main` with its implementation, tests, review, changelog, and version metadata
already merged.

Simulator tests belong to feature development and pull-request qualification.
The standard release operation does **not** create, boot, reuse, erase, or
delete an iOS simulator. Record the successful CI and focused test evidence
from the merged changes instead. If required iOS test evidence is missing or a
release-day source defect appears:

1. stop the release;
2. fix and test the source in an isolated task;
3. merge the fix;
4. prepare a new candidate commit and, when immutable bytes already exist, a
   new version/build number;
5. restart this pipeline from Phase 1.

Do not turn the release worktree into a development worktree. Do not use a
simulator as an archive prerequisite or as a workaround for Xcode signing.

## Required, conditional, and excluded work

Do not add checks or alternate routes because they feel safer. Run only the
gate owned by the current phase.

### Always required

- merged version/changelog/source gates;
- backend compatibility inspection;
- macOS signing, notarization, layout, privacy, updater-signature, dry-run,
  publication, rollback, and digest gates;
- iOS archive/export signature, capability, privacy, upload, processing, and
  internal-group gates;
- task-owned cleanup and final state report.

### Conditional

- backend backup/deploy only when the candidate contains an undeployed backend,
  runner, schema, configuration, media, or APNs change;
- two-account call acceptance only when call/media/APNs/edge behavior changed;
- installed macOS migration acceptance only when release policy or changed
  persistence/update behavior requires it;
- temporary keychain import only when an approved identity is not already
  available.

### Not part of the standard release operation

- creating or running an iOS simulator;
- rerunning the full repository test suite after merged CI already qualified
  the candidate;
- building the standalone registry or unrelated products;
- building historical bootstrap/ad-hoc artifacts;
- deploying unchanged backend or runner components;
- authenticating to App Store Connect before the iOS phase;
- building a second macOS candidate or trying alternate packaging formats;
- multi-region performance benchmarking.

## Invariants

- One immutable merged commit identifies the backend compatibility decision,
  desktop app, runtime sidecar, iOS app, version metadata, tag, and release
  evidence.
- The previous verified desktop release remains advertised until the candidate
  DMG exists and every product URL returns its exact bytes.
- Product deployment is diff-driven. Verify and reuse a compatible deployed
  backend; do not redeploy unchanged server or runner code.
- macOS publication completes on `kordi.ai` and GitHub before iOS archive and
  upload begin.
- The macOS app is Developer ID signed, notarized, stapled, Gatekeeper-valid,
  updater-signed, privacy-clean, and packaged in a verified DMG.
- The iOS app uses the production `Kordi` scheme, approved product team,
  production origin and APNs, correct App Group, and a privacy-clean IPA.
- Immutable release objects are never overwritten or deleted. Channel changes
  use conditional writes and unpublished tombstones.
- Infrastructure identifiers, Apple identifiers, accounts, credentials,
  private paths, and raw logs never enter commits, issues, release notes,
  screenshots, or shared output.

## Release state model

Record each state independently:

| State | Proof required |
| --- | --- |
| Source prepared | Release PR merged; changelog and every version source agree |
| Candidate pinned | Clean detached worktree at the recorded merged commit |
| Backend ready | Last backend-changing commit deployed, schema current, health/readiness pass |
| macOS built | App, updater archive/signature, and DMG exist from one build root |
| macOS verified | Signing, notarization, stapling, Gatekeeper, layout, privacy, origin, and tamper gates pass |
| Acceptance published | Immutable bytes and acceptance pointer pass product-domain verification |
| Beta promoted | Older clients receive the candidate; current/newer clients receive HTTP 204 |
| Rollback rehearsed | Expected-version tombstone, fallback, and exact restoration pass |
| GitHub mirrored | Tag points to the candidate and GitHub DMG/checksum match kordi.ai |
| iOS archived | Production archive created with reviewed version/build and team |
| iOS exported | IPA signature, capabilities, origin, privacy, size, and digest pass |
| iOS uploaded | App Store upload command succeeds |
| TestFlight ready | Processing is complete/valid and the build is visible to `Kordi Team` |
| Release complete | All task-owned processes, mounts, secrets, tunnels, and worktrees are removed |

## Release inputs

Record safe values before the release-preparation PR:

```text
Desktop version: 0.0.1-beta.N
Desktop tag: V0.0.1.betaN
Previous desktop tag: V0.0.1.betaM
iOS marketing version: X.Y.Z
iOS build number: N
Required Xcode app: /Applications/Xcode[-beta].app
Desktop channel sequence: acceptance -> unpublished -> beta -> rollback -> beta
iOS audience: Kordi Team internal TestFlight
Candidate commit: unset until the release PR merges
```

Keep these private and outside the repository:

- authorized product target values;
- production Apple team and signed-in Xcode account;
- separate notarization and App Store Connect API credentials;
- task-owned source, build, archive, export, and artifact paths;
- task-owned local and remote tunnel ports.

The Apple notarization key is not automatically an App Store Connect key. Test
provider/build-status access before release day. A key that can notarize macOS
may be forbidden from listing or monitoring iOS builds.

## Phase 0: prepare and merge the release PR

1. Fetch the latest `origin/main` and compare it with the previous desktop tag.
2. Inventory every merged user-facing change. Exclude test-only, documentation-
   only, and internal cleanup changes unless they alter release behavior.
3. Add the dated root `CHANGELOG.md` entry. Its classified bullets are also the
   canonical updater and GitHub release-note list.
4. Update every desktop version source listed in [Release and
   packaging](../release.md#version-metadata-to-bump).
5. Update the iOS marketing/build values in `app/ios/project.yml` and regenerate
   the committed Xcode project.
6. Verify the production `Kordi` Release settings identify the reviewed
   version/build, product bundle IDs, `https://kordi.ai`, production channel,
   and production APNs.
7. Run implementation tests and simulator/device acceptance in the feature PRs
   that changed those surfaces. Attach safe pass/fail evidence to the release
   PR; do not defer it to release operation.
8. Confirm the desktop tag and GitHub release name are unused. Check the iOS
   build number at the start of the iOS phase.
9. Merge the release PR through the repository's normal protection.

The preparation PR changes source metadata only. It does not deploy, compile,
publish, tag, or upload an artifact.

## Phase 1: pin and preflight the merged candidate

Fetch the merge and create a clean detached preflight worktree:

```bash
git fetch origin main --tags
CANDIDATE_COMMIT="$(git rev-parse origin/main)"
git worktree add --detach /protected/kordi-release-preflight "$CANDIDATE_COMMIT"
cd /protected/kordi-release-preflight
test "$(git rev-parse HEAD)" = "$CANDIDATE_COMMIT"
test -z "$(git status --short)"
```

Run source gates without building artifacts:

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

Select the required Xcode explicitly. Do not change the machine-wide Xcode
selection and do not substitute another Xcode after artifacts exist:

```bash
export DEVELOPER_DIR="<XCODE_APP>/Contents/Developer"
xcodebuild -version
xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -showBuildSettings \
  | rg 'MARKETING_VERSION|CURRENT_PROJECT_VERSION|PRODUCT_BUNDLE_IDENTIFIER|KORDI_CLOUD_BASE_URL|KORDI_DISTRIBUTION_CHANNEL|APNS_ENVIRONMENT'
```

The build-settings output must identify the intended version/build,
`ai.kordi.ios`, `https://kordi.ai`, production distribution, and production
APNs.

Before pinning, confirm:

- required CI and focused tests on the merged commit passed;
- required Xcode exists and reports the reviewed build settings;
- desktop tag and GitHub release name remain unused;
- disk, memory, DMG mounts, and task-owned paths/ports are known;
- task-owned release paths and ports do not already exist or belong to another
  task.

Do not authenticate to the product backend, signing stores, or App Store in
this source-only phase. Phase 2 owns product access, Phase 3 owns macOS signing,
and Phase 5 owns Apple distribution/App Store access.

Then pin the release:

```bash
RELEASE_COMMIT="$CANDIDATE_COMMIT"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test -z "$(git status --short)"
```

Do not advance `RELEASE_COMMIT` later. Any source change starts a new candidate.

## Phase 2: inspect or deploy the product backend

The first product action is read-only inspection:

1. verify public `/health`;
2. record deployed server and runner image tags;
3. verify desired/ready replicas and restart counts;
4. verify the latest database schema version;
5. count severe recent log lines without copying raw logs;
6. verify host-loopback NodePort health, auth capability, current updater
   fallback, media, and APNs readiness;
7. identify the last backend-changing commit in `RELEASE_COMMIT`.

Compare the deployed server/runner commits with `RELEASE_COMMIT`:

```bash
git diff --name-status <DEPLOYED_SERVER_COMMIT>.."$RELEASE_COMMIT" -- \
  bridges/cloud-server
git diff --name-status <DEPLOYED_RUNNER_COMMIT>.."$RELEASE_COMMIT" -- \
  bridges/cloud-agent-runner
```

### No backend or runner diff

If the deployed images contain the last relevant backend/runner changes and the
schema is current, do not redeploy. Record the compatibility evidence and
continue to macOS.

### Backend or runner diff exists

Follow [Hosted backend deploy](../release.md#hosted-backend-deploy):

1. create and verify the pre-deploy backup;
2. preserve current image tags and beta pointer bytes/ETag;
3. sync the exact `RELEASE_COMMIT` to the authorized product host;
4. deploy only the changed server/runner components with commit-derived image
   tags;
5. keep legacy/updater metadata on the previous verified release;
6. verify rollout images, schema, zero restarts, redacted logs, in-cluster and
   host health, public health/auth/CORS/updater, media, and APNs;
7. run the required two-account call acceptance only when call client/service,
   media, APNs, edge, credentials, or relevant backend behavior changed.

Do not deploy merely because a release is happening. Do not build client
artifacts while a required product rollout is unresolved.

## Phase 3: build macOS exactly once

Create a real neutral-path worktree and a release-specific target directory.
Do not inherit a shared Cargo target from another task:

```bash
RELEASE_SOURCE_ROOT=/Applications/KordiReleaseSource-betaN
RELEASE_BUILD_ROOT=/Applications/KordiReleaseBuild-betaN
test ! -e "$RELEASE_SOURCE_ROOT"
test ! -e "$RELEASE_BUILD_ROOT"
git worktree add --detach "$RELEASE_SOURCE_ROOT" "$RELEASE_COMMIT"
cd "$RELEASE_SOURCE_ROOT"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test -z "$(git status --short)"

export CARGO_TARGET_DIR="$RELEASE_BUILD_ROOT"
export CARGO_BUILD_JOBS=1
export RUSTFLAGS="--remap-path-prefix=<OPERATOR_HOME>=/build"
export DEVELOPER_DIR="<XCODE_APP>/Contents/Developer"
export APPLE_SIGNING_IDENTITY="<APPROVED_DEVELOPER_IDENTITY>"
unset VITE_KORDI_CLOUD_API_BASE
```

Before compilation:

- install dependencies with the frozen lockfile when `node_modules` is absent;
- select the Developer ID identity explicitly for Tauri;
- confirm updater and notarization secrets are accessible;
- record Rust, Xcode, linker, OS, disk, memory, and proxy versions;
- verify no release DMG or task-owned port is already mounted/listening;
- inspect CoreSimulator state without creating a simulator.

CoreSimulator is not needed for the macOS build, but a stale
CoreSimulatorService can veto DiskImages operations. If `simctl` reports a
device stuck in `Shutting Down`, or DiskImages returns `Resource busy`/error
156, stop before packaging. Identify the dissenting process from system logs.
Restart the shared service only with explicit approval because it can interrupt
other simulator tasks. Never delete another task's simulator.

Load updater/notarization credentials and any temporary keychain inside one
cleanup-trapped shell, then run the repository wrapper:

```bash
pnpm --dir app/desktop tauri:build:cloud:dmg
```

Do not hand-roll a DMG, use `makehybrid`, patch a signed app, or substitute an
unsigned bundle after failure. A retry may reuse the release-specific Cargo
cache only after the root cause is understood. The final release set must
contain:

```text
Kordi.app
Kordi.app.tar.gz
Kordi.app.tar.gz.sig
Kordi_0.0.1-beta.N_aarch64.dmg
```

Require before storage access:

- production prerequisite gate for `RELEASE_COMMIT`;
- Developer ID signature, Apple acceptance, stapling, and Gatekeeper;
- DMG layout with `Kordi.app` and `/Applications` drag target;
- macOS 12 minimum and correct product/update origins;
- exact version parity across app, archive, DMG, and repository metadata;
- full privacy scan of app, archive, mounted DMG, and native binaries;
- updater signature verification and one-byte tamper rejection;
- fixed byte sizes and SHA-256 values;
- publisher dry run with one fixed `pubDate`, `release.json`, checksums, and
  channel-pointer digest.

If privacy scanning finds `/Users/`, `/private/tmp`, `/var/folders`, an account,
test data, internal host, or credential material, stop. Fix the source/build
input and create new artifacts. Do not patch a release binary after signing.

## Phase 4: publish macOS, tag, and mirror GitHub

### Prove the publication path first

Before loading publisher credentials:

- confirm the task-owned local port is free;
- inspect any remote listener before stopping it;
- replace only a known stale release tunnel;
- keep MinIO private and reachable only through loopback SSH;
- run a full-size authenticated read of an existing DMG through the exact
  planned tunnel and verify its SHA-256.

Do not use a tunnel that only passes health/small-object checks. A
`kubectl port-forward` can remain alive while resetting large streams. Prefer a
task-owned SSH local forward to the current MinIO pod endpoint when the host can
reach that endpoint. Resolve the endpoint privately for this release, do not
log it, and close the tunnel immediately after publication.

Generic command shape:

```bash
set +x
MINIO_POD_IP="$(
  gcloud compute ssh "<PRODUCT_INSTANCE>" \
    --zone "<PRODUCT_ZONE>" \
    --project "<PRODUCT_PROJECT>" \
    --command "kubectl -n kordi-cloud get endpointslice \
      -l kubernetes.io/service-name=minio \
      -o jsonpath='{.items[0].endpoints[0].addresses[0]}'"
)"
test -n "$MINIO_POD_IP"
gcloud compute ssh "<PRODUCT_INSTANCE>" \
  --zone "<PRODUCT_ZONE>" \
  --project "<PRODUCT_PROJECT>" \
  -- -C -N -L "<LOCAL_PORT>:$MINIO_POD_IP:9000"
```

Keep the resolved pod address and command output private. Re-resolve it for
each release; it is not durable configuration.

If a full object read returns `socket hang up`, `ECONNRESET`, or repeated
port-forward timeouts, stop before changing a pointer and replace the tunnel.

### Publish and verify

Use the fixed dry-run metadata and the repository publisher:

1. publish immutable objects and the `acceptance` pointer;
2. verify versioned DMG/archive GET and HEAD, sizes, SHA-256, updater manifest,
   and current-version HTTP 204 through `https://kordi.ai`;
3. run installed migration acceptance when required by the release policy;
4. tombstone `acceptance` with compare-and-swap and verify HTTP 204;
5. promote the same immutable objects to `beta`;
6. verify older supported clients receive the candidate and current/newer/
   unsupported clients receive HTTP 204;
7. verify stable DMG, legacy metadata, product health, exact sizes, and digests;
8. run the expected-version rollback command;
9. verify fallback while beta is unpublished;
10. restore the exact release with the original `pubDate` and repeat the full
    public matrix.

Never manually write a pointer, skip private/public read-back, or regenerate
`pubDate` during restoration.

Updater CDN/range performance work is tracked separately from release
correctness. Do not add multi-region benchmarking to the standard release run.
After CDN/range delivery ships, its own deployment checklist must verify
standards-compliant `206`/`416` behavior before the release pipeline depends on
it.

### Tag and GitHub

After restored beta verification:

1. recheck `RELEASE_COMMIT`, version/changelog scope, and tag absence;
2. stage the intended release files and run `pnpm check:english` before the tag
   push;
3. create and push the annotated desktop tag at `RELEASE_COMMIT`;
4. create the GitHub prerelease with the exact changelog bullets, DMG,
   checksums, signing evidence, source commit, backend/schema state, product
   verification, and rollback evidence;
5. require GitHub, kordi.ai, and local DMG size/SHA-256 equality.

At this point macOS is released. Close every publication tunnel and delete its
temporary credentials before starting iOS.

## Phase 5: archive, verify, and upload iOS

The standard iOS release operation uses no simulator. Use the same
`RELEASE_COMMIT` and required Xcode selected in Phase 1.

Before archive creation:

- confirm the build number is still unused;
- load the production team from approved product configuration, not a profile;
- confirm the signed-in Xcode account belongs to that team;
- confirm App Group, production APNs, bundle IDs, product origin, agreements,
  and TestFlight group configuration;
- resolve Swift packages into a task-owned DerivedData directory;
- scan downloaded binary frameworks for private build paths before archive.

Third-party binary frameworks are release inputs. If they contain private
filesystem paths or other forbidden data, update/rebuild that dependency with
path remapping in source, test it, merge it, and use a new candidate. Do not
perform release-day binary string replacement as the standard path.

Archive the production scheme:

```bash
export DEVELOPER_DIR="<XCODE_APP>/Contents/Developer"
export KORDI_IOS_TEAM_ID="<PRIVATE_PRODUCTION_TEAM_ID>"

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

Export locally first with:

```text
method: app-store-connect
destination: export
signingStyle: automatic
teamID: the approved product team
manageAppVersionAndBuildNumber: false
uploadSymbols: true
testFlightInternalTestingOnly: false
```

Extract and verify the IPA before upload:

- app and share extension marketing version/build;
- production bundle IDs and `https://kordi.ai` origin;
- production APNs;
- `group.ai.kordi.share` in both signed entitlements and profiles;
- approved team on both targets/profiles;
- `get-task-allow` absent or false;
- `ITSAppUsesNonExemptEncryption` false;
- app, extension, and nested framework signatures;
- no `/Users/`, `/private/tmp`, `/var/folders`, test hosts, credentials, account
  data, or private identifiers in the extracted IPA/native binaries;
- IPA byte size and SHA-256.

Use a dedicated App Store Connect API key for validation, upload, and build
status when available:

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

If the API key cannot cloud-sign, export with the signed-in Xcode account. If
it cannot query providers/build status, do not substitute the notarization key.
Upload with Xcode's signed-in account and assign a named operator to confirm
processing and group visibility in App Store Connect.

## Phase 6: confirm TestFlight

Upload success means Apple received the build; it does not mean TestFlight is
ready.

Require:

- version/build equal the reviewed values;
- processing completes without warnings that invalidate distribution;
- build state is valid/complete;
- the build is visible to the internal `Kordi Team` group;
- required compliance prompts are resolved without changing reviewed metadata.

Do not upload the same build number again while it is processing. If Apple
rejects the binary, fix the source or release input, increment the build number,
merge the change, and create a new candidate.

## Phase 7: final state and cleanup

Record only safe evidence:

```text
source merged: yes/no + commit
backend action: reused/deployed + safe image tags
database schema: version
macOS app signed/notarized/stapled/Gatekeeper: pass/fail
immutable macOS objects: verified/unverified
acceptance pointer: unpublished/version
beta pointer: unpublished/version
stable/manual metadata: version
rollback and restoration: pass/fail + pointer digest
tag and GitHub prerelease: yes/no
GitHub/product/local DMG digest equality: pass/fail
iOS archive/export/upload: pass/fail
iOS version/build/processing state: values
TestFlight internal group visible: yes/no
```

Cleanup must remove only task-owned state:

- secrets, access-token environment variables, raw logs, and temporary
  keychains;
- local SSH and remote release port-forwards;
- DMG mounts, temporary verification extractions, failed artifact attempts, and
  private export logs;
- task-owned Xcode instance, DerivedData, temporary scripts, and worktrees.

Preserve final DMG/checksums, signed app/updater archive, Xcode archive, IPA,
backups, safe evidence, and compatible non-secret build caches as required by
release policy. Confirm the original development worktree is unchanged.

## Failure and recovery matrix

| Failure | Required response |
| --- | --- |
| Release metadata or changelog mismatch | Fix in a PR, merge, and restart Phase 1 |
| Missing merged test evidence | Stop; qualify the source before release operation |
| Backend diff exists but product is older | Back up, deploy exact candidate components, and verify before build |
| Backend is already compatible | Record evidence and skip deployment |
| Shared Cargo target is inherited | Stop before artifact output; use a release-specific target directory |
| Developer ID identity was not selected | Stop; select it explicitly before rebuilding/bundling |
| DiskImages `Resource busy` or error 156 | Inspect stale CoreSimulator/DiskImages state; restart shared service only with approval |
| DMG layout or signature fails | Do not invent a fallback package; fix the standard build path |
| Any artifact privacy scan fails | Do not publish; fix source/dependency and create new artifacts |
| Publisher tunnel passes health but resets large reads | Replace it before pointer mutation; prove a full-object hash read |
| Acceptance verification fails | Let the publisher restore its pointer; verify previous public state |
| Beta promotion fails before pointer write | Keep previous beta live; fix transport and retry idempotently |
| Beta promotion fails after pointer write | Let publisher rollback; verify fallback before retry |
| Rollback rehearsal succeeds | Restore exact pointer bytes and original `pubDate`, then reverify |
| Tag/GitHub digest differs | Stop advertising the mirror; do not replace immutable product bytes |
| iOS capability/team/profile mismatch | Stop before upload; repair source/configuration and increment build when required |
| Third-party iOS binary contains private paths | Rebuild/update dependency in source; never ship the contaminated IPA |
| App Store upload succeeds but processing is pending | Wait; do not re-upload the same build number |
| App Store credential cannot query status | Use a dedicated status credential or assign explicit UI verification ownership |
| Secret loading, redaction, or cleanup fails | Stop, inventory external state, remove protected material, and do not assume cleanup ran |

## Release lessons encoded from beta.18

- Read the current release pipeline before acting; do not combine historical
  runbooks into a new sequence.
- Run release-day prerequisite checks as one front-loaded gate. Discovering
  identity, target-directory, DiskImages, tunnel, or privacy problems after a
  long build is avoidable.
- No iOS simulator is required for the standard artifact release operation.
- Select `CARGO_TARGET_DIR`, Developer ID identity, Xcode, and product origin
  explicitly before the first build.
- A signed/notarized app is not a releasable DMG. Layout, nested signatures,
  privacy, updater archive/signature, and publisher dry run must all pass.
- `kubectl port-forward` health does not prove sustained large-object reads.
  Prove the full release-object path before pointer changes.
- Scan third-party iOS frameworks before archive and scan the final extracted
  IPA before upload.
- macOS publication and GitHub mirroring finish before iOS release operation.
- Preserve the safe previous release until the candidate passes every public
  endpoint and rollback/restoration check.
- Keep commentary and final reports precise about merged source, built bytes,
  published pointers, GitHub state, iOS upload, and TestFlight processing.

## Secret and log handling

The shell that loads credentials owns the cleanup trap. Use this order:

1. create a mode-700 secret directory and mode-600 raw log;
2. register cleanup before loading any credential;
3. run the release command and preserve its exit status;
4. remove credentials, access tokens, and temporary keychains in the same
   shell;
5. redact the completed log;
6. emit only a safe summary;
7. delete raw and redacted temporary logs.

Never stream a credential-owning shell through an untested output filter. Never
print secret values, private identities, private endpoints, account names, or
raw logs.
