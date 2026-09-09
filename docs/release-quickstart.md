# Fast macOS and iOS release checklist

Use this for the next signed macOS release and iOS TestFlight build. It condenses
the [standard release pipeline](development/dual-platform-release-runbook.md);
that runbook owns publication order, backend operations, and rollback policy.
Run the commands from the repository root in a clean, pinned release worktree.

**Normal order:** prepare/merge metadata -> pin source -> backend compatibility
-> macOS build/verify -> kordi.ai publication -> GitHub release -> iOS
archive/export/upload -> TestFlight verification. An explicitly requested
platform-only release follows that platform's gates and records the scope.

## 1. Prepare the candidate before release day

- Merge implementation fixes and their focused tests first. Qualify changed
  permission, call, scrolling, swipe, and installation behavior on real devices.
  Two-finger scrolling in iPhone Mirroring does not prove one-finger touch works.
- Prepare one metadata PR with the changelog, desktop version sources, and iOS
  marketing/build values. Use the complete [version file list](release.md#version-metadata-to-bump).
  Update `app/ios/project.yml`, regenerate with `xcodegen`, and update the
  release-version test's iOS build assertion.
- Choose an unused iOS build number in App Store Connect. An already-uploaded
  build number cannot be used for a corrected binary.
- Check that the desktop tag/release and versioned object keys are unused.
  Metadata preparation and local dry runs must **not** create tags, draft GitHub
  releases, or production objects. Live acceptance publication already reserves
  immutable objects, so begin it only with the final verified artifacts.
- Merge the metadata PR and require its qualification checks. Pin that merge;
  do not silently pick up later commits while building.

Stable desktop versions such as `0.0.1` are supported. Their final tag is
`V0.0.1`. Beta `0.0.1-beta.N` uses `V0.0.1.betaN`; a corrective beta appends the
same extra numeric component. Stable versions still use the publisher's
`acceptance` and `beta` channels; there is no separate `stable` channel argument.

## 2. Set up once and keep the build inputs fixed

Load approved infrastructure/account values from private operator configuration.
Read the applicable local operating rules. Keep credentials, team IDs, device
IDs, private paths, and raw logs out of commits and release notes.

Set these private shell variables before using the examples:

| Variable | Meaning |
| --- | --- |
| `RELEASE_SOURCE_ROOT` | New physical source directory outside the home directory; not a symlink |
| `RELEASE_BUILD_ROOT` | Task-owned build directory, also outside the home directory |
| `RELEASE_COMMIT` | Full SHA of the reviewed, merged metadata candidate |
| `DESKTOP_VERSION`, `DESKTOP_TAG` | Reviewed version and final tag |
| `RELEASE_NOTES_FILE` | Sanitized English release notes from the exact changelog entry |
| `DEVELOPER_DIR` | Explicitly selected Xcode app's `Contents/Developer` directory |
| `KORDI_IOS_TEAM_ID` | Approved production team, loaded privately |
| `PUB_DATE` | One fixed UTC publication timestamp, retained through promotion/rollback |

Use neutral directory names without spaces. Retain compatible task-owned build
caches during retries; clearing them or moving source roots needlessly repeats
compilation. Never reuse or delete another task's build directory.

```bash
set -euo pipefail
set +x
umask 077
: "${RELEASE_SOURCE_ROOT:?Set a neutral source directory}"
: "${RELEASE_BUILD_ROOT:?Set a neutral build directory}"
: "${DEVELOPER_DIR:?Select the release Xcode}"
: "${RELEASE_COMMIT:?Set the reviewed merge commit}"
export DEVELOPER_DIR RELEASE_COMMIT
git fetch origin main --tags
git cat-file -e "$RELEASE_COMMIT^{commit}"
git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main
test ! -e "$RELEASE_SOURCE_ROOT"
git worktree add --detach "$RELEASE_SOURCE_ROOT" "$RELEASE_COMMIT"
cd "$RELEASE_SOURCE_ROOT"
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile

export CARGO_TARGET_DIR="$RELEASE_BUILD_ROOT/macos"
export KORDI_IOS_ROOT="$RELEASE_BUILD_ROOT/ios"
export KORDI_IOS_PACKAGES="$KORDI_IOS_ROOT/SourcePackages"
export KORDI_IOS_DERIVED_DATA="$KORDI_IOS_ROOT/DerivedData"
export KORDI_UNIFFI_SOURCE="$RELEASE_BUILD_ROOT/uniffi-source"
export KORDI_UNIFFI_BUILD="$RELEASE_BUILD_ROOT/uniffi-build"
mkdir -p "$CARGO_TARGET_DIR/tmp" "$KORDI_IOS_ROOT"

pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
pnpm --dir app/desktop release:secret-guard
pnpm --dir app/desktop release:prerequisites -- \
  --source-only --expected-commit "$RELEASE_COMMIT"
(cd app/ios && xcodegen generate)
git diff --exit-code -- app/ios/project.yml app/ios/Kordi.xcodeproj
```

Record the commit, tool versions, platform versions/builds, and current release
pointers in a private release record. If the source must change, qualify/merge
it first and create a new candidate. Never label older artifact bytes with a
new commit.

## 3. Check backend compatibility; deploy only a relevant diff

Compare the candidate with the **deployed** backend/runner/schema, not merely
with the previous desktop version. If unchanged, verify health and reuse it.
If changed, follow [backend deployment](development/dual-platform-release-runbook.md#phase-2-inspect-or-deploy-the-product-backend):
backup, migration rehearsal where required, deployment, and product-domain
verification. Build/deploy/migration work runs on the corresponding product
host with explicit project, zone, and instance values.

Run the two-account voice/video, hang-up, and background/locked-iPhone CallKit
acceptance gate when call/media/APNs/edge behavior changed. Do not substitute
server health for device acceptance. Keep data repair and feature debugging
out of the normal release path.

## 4. Build, verify, and publish macOS

### Check signing before the long build

- Verify Google Cloud authentication can read the known [signing secrets](release.md#signed-desktop-release-prerequisites).
  Reuse approved configuration instead of rediscovering projects or accounts.
- Verify an installed Developer ID Application identity. If names are duplicated,
  select the approved certificate's exact hash privately.
- Verify updater signing against the repository public key with a tiny test
  file, and test notarization access with `notarytool history`.
- Check free disk/memory and stale DMG mounts. If DiskImages reports a simulator
  service conflict, identify it; do not interrupt another task's simulator.

Load signing material into a private, cleanup-trapped shell as described in the
[macOS runbook](development/macos-desktop-release-runbook.md#build-from-a-physical-neutral-path).
Keep the same Xcode, source root, target directory, and flags throughout retries.

```bash
: "${DESKTOP_VERSION:?Set the reviewed desktop version}"
: "${PUB_DATE:?Set and retain one UTC publication timestamp}"
export CARGO_BUILD_JOBS=1
export RUSTFLAGS="--remap-path-prefix=$HOME=/build --remap-path-prefix=/private/tmp=/build/tmp --remap-path-prefix=/var/folders=/build/tmp"
export CFLAGS="-ffile-prefix-map=$HOME=/build -fdebug-prefix-map=$HOME=/build"
export CXXFLAGS="$CFLAGS"
export TMPDIR="$CARGO_TARGET_DIR/tmp/"
unset VITE_KORDI_CLOUD_API_BASE VITE_KORDI_DEV_PROFILE
# APPLE_SIGNING_IDENTITY and updater/notarization credentials are already loaded.
pnpm --dir app/desktop tauri:build:cloud:dmg

export MAC_APP="$CARGO_TARGET_DIR/release/bundle/macos/Kordi.app"
export RELEASE_STAGE="$RELEASE_BUILD_ROOT/verified-release"
mkdir "$RELEASE_STAGE"
cp "$CARGO_TARGET_DIR/release/bundle/macos/Kordi.app.tar.gz" "$RELEASE_STAGE/"
cp "$CARGO_TARGET_DIR/release/bundle/macos/Kordi.app.tar.gz.sig" "$RELEASE_STAGE/"
cp "$CARGO_TARGET_DIR/release/bundle/dmg/Kordi_${DESKTOP_VERSION}_aarch64.dmg" "$RELEASE_STAGE/"

pnpm --dir app/desktop release:prerequisites -- \
  --expected-commit "$RELEASE_COMMIT" --app-bundle "$MAC_APP"
pnpm release:publish-desktop -- \
  --release-dir "$RELEASE_STAGE" --app-bundle "$MAC_APP" \
  --version "$DESKTOP_VERSION" --channel acceptance \
  --expected-commit "$RELEASE_COMMIT" --pub-date "$PUB_DATE" --dry-run
```

The production gates inspect the actual app, updater archive, and DMG. Require
Developer ID signing, app notarization/stapling, Gatekeeper, DMG layout,
version/origin parity, privacy, updater signature and one-byte tamper rejection.
The signed app must contain the calendar entitlement **and** its full-access
purpose string; an Info.plist description alone is insufficient. Retain hashes
and the dry-run metadata. Do not claim the outer DMG is stapled merely because
the enclosed app is stapled.

### Publication is a separate operation

Use the approved private publisher route and verify a full-size existing object
through it before changing storage. Follow the [publication and rollback sequence](development/dual-platform-release-runbook.md#publish-and-verify):

1. Publish the verified set to `acceptance` by removing `--dry-run` from the
   command above. Verify exact public bytes and updater behavior through kordi.ai.
2. Clear acceptance through `pnpm release:clear-desktop-acceptance` only after
   verifying that the current acceptance pointer is this candidate.
3. Publish the same set with `--channel beta`; retain the original `PUB_DATE`.
4. Verify the public endpoint matrix, run
   `pnpm release:rollback-desktop-beta -- --expected-current-version "$DESKTOP_VERSION"`,
   verify fallback, then restore the same release and repeat verification.
5. Only now create/push the annotated tag at `RELEASE_COMMIT` and create the
   GitHub release with the exact DMG, checksums, and changelog notes. Run
   `pnpm check:english` before the tag push. Use a normal GitHub release for a
   stable version and a GitHub prerelease for a beta version.
6. Download the GitHub and kordi.ai assets and compare their size/SHA-256 with
   the verified local DMG. Confirm updater and stable download behavior.

After the public verification/rollback gates above and a fresh tag-absence
check, the final tag/GitHub commands are:

```bash
: "${DESKTOP_TAG:?Set the reviewed final tag}"
: "${RELEASE_NOTES_FILE:?Prepare sanitized English notes from the changelog}"
pnpm check:english
git tag -a "$DESKTOP_TAG" "$RELEASE_COMMIT" -m "$DESKTOP_TAG"
git push origin "refs/tags/$DESKTOP_TAG"
release_options=()
case "$DESKTOP_VERSION" in *-beta.*) release_options+=(--prerelease) ;; esac
gh release create "$DESKTOP_TAG" --verify-tag --title "$DESKTOP_VERSION" \
  --notes-file "$RELEASE_NOTES_FILE" "${release_options[@]}" \
  "$RELEASE_STAGE/Kordi_${DESKTOP_VERSION}_aarch64.dmg" \
  "$RELEASE_STAGE/checksums.sha256"
```

**macOS is published only when both kordi.ai and GitHub are verified.** A local
DMG, a pushed commit, or a running local app is not publication.

## 5. Archive, export, and upload iOS

### Check the Apple account before archiving

Confirm the intended build number is still unused, the signed-in Xcode account
belongs to the approved product team, and App Store Connect is accessible.
The account holder handles any updated Apple agreement. Google Cloud login,
App Store Connect browser login, and Xcode account authentication are separate.

Confirm App Group `group.ai.kordi.share` and shared Keychain access for both
`ai.kordi.ios` and `ai.kordi.ios.share`, production APNs, and the `Kordi Team`
internal TestFlight group. Use scheme **Kordi**, configuration **Release**.
Never use `Kordi Beta`, `CODE_SIGNING_ALLOWED=NO`, or an empty
`CODE_SIGN_ENTITLEMENTS` override for an archive/export/upload.

### Prepare the pinned device dependency once

```bash
xcodebuild -resolvePackageDependencies \
  -project app/ios/Kordi.xcodeproj -scheme Kordi \
  -clonedSourcePackagesDirPath "$KORDI_IOS_PACKAGES" \
  -derivedDataPath "$KORDI_IOS_DERIVED_DATA" \
  -onlyUsePackageVersionsFromResolvedFile
python3 scripts/prepare-ios-uniffi.py \
  --source "$KORDI_UNIFFI_SOURCE" --build "$KORDI_UNIFFI_BUILD" \
  --packages "$KORDI_IOS_PACKAGES"
```

The helper source-builds the pinned UniFFI device framework, checks Swift/C
interface compatibility and privacy, and writes provenance. It requires Rust
and `protoc`. Its local package override is device-only. Scan other downloaded
device frameworks too. Keep the prepared package directory unchanged for the
archive; do not re-resolve or reset the checkout after preparation. Do not
patch dependency binary strings or substitute bytes under an upstream checksum.

### Archive with symbol path remapping

```bash
: "${KORDI_IOS_TEAM_ID:?Load the approved production team privately}"
export KORDI_IOS_TEAM_ID
export IOS_ARCHIVE="$KORDI_IOS_ROOT/Kordi.xcarchive"
xcodebuild -project app/ios/Kordi.xcodeproj \
  -scheme Kordi -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$IOS_ARCHIVE" -derivedDataPath "$KORDI_IOS_DERIVED_DATA" \
  -clonedSourcePackagesDirPath "$KORDI_IOS_PACKAGES" \
  -disableAutomaticPackageResolution -skipPackageUpdates \
  -allowProvisioningUpdates -hideShellScriptEnvironment \
  DEVELOPMENT_TEAM="$KORDI_IOS_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  SWIFT_SERIALIZE_DEBUGGING_OPTIONS=NO \
  'OTHER_SWIFT_FLAGS=$(inherited) -debug-prefix-map /var/folders=/build/tmp -file-prefix-map /var/folders=/build/tmp -debug-prefix-map /private/tmp=/build/tmp -file-prefix-map /private/tmp=/build/tmp' \
  'OTHER_CFLAGS=$(inherited) -fdebug-prefix-map=/var/folders=/build/tmp -ffile-prefix-map=/var/folders=/build/tmp' \
  archive
```

Create private export/upload options without placing team values in source:

```bash
python3 - <<'PY'
import os, plistlib
from pathlib import Path
root = Path(os.environ['KORDI_IOS_ROOT'])
options = dict(method='app-store-connect', destination='export',
               signingStyle='automatic', teamID=os.environ['KORDI_IOS_TEAM_ID'],
               manageAppVersionAndBuildNumber=False, uploadSymbols=True,
               testFlightInternalTestingOnly=False)
for name, destination in [('ExportOptions.plist', 'export'), ('UploadOptions.plist', 'upload')]:
    options['destination'] = destination
    path = root / name
    path.write_bytes(plistlib.dumps(options))
    path.chmod(0o600)
PY
xcodebuild -exportArchive -archivePath "$IOS_ARCHIVE" \
  -exportPath "$KORDI_IOS_ROOT/Export" \
  -exportOptionsPlist "$KORDI_IOS_ROOT/ExportOptions.plist" \
  -allowProvisioningUpdates
```

Extract the IPA and apply the [export verification checklist](ios-development.md#archive-and-export)
to both the app and extension: signatures, version/build, production origin,
team, APNs, App Group, shared Keychain, App Store profiles, disabled debugging,
and encryption declaration. Scan the **whole IPA, including `Symbols/`** for
private paths/data. Record its size and SHA-256.

Public compiled field names such as `primaryEmail` or `sessionToken` are not
stored credentials by themselves. Investigate such matches against source and
binary sections; record the classification. Never ignore an entire binary or
weaken the private-path/account-value checks to make a scan pass.

With an existing dedicated App Store Connect API key, use the
[validate/upload commands](ios-development.md#validate-upload-and-verify-testflight).
Otherwise use the signed-in Xcode account with the same verified archive:

```bash
xcodebuild -exportArchive -archivePath "$IOS_ARCHIVE" \
  -exportPath "$KORDI_IOS_ROOT/Upload" \
  -exportOptionsPlist "$KORDI_IOS_ROOT/UploadOptions.plist" \
  -allowProvisioningUpdates
```

The second command distributes the archive through Xcode; it may export/sign
again. Keep the local IPA hash as reference evidence and record the actual
upload receipt separately. Do not claim two separately signed exports are
byte-identical without comparison. Never reuse a notarization key as an App
Store Connect key or retry a completed/processing upload blindly.

### Verify TestFlight, then finish

In App Store Connect, confirm the exact version/build appears, processing
finishes successfully, and **Kordi Team -> Builds** shows it as **Testing**.
A general build page may say **Ready to Submit** for external review while the
internal group already says **Testing**. Check the group itself. Resolve any
required compliance action with the account holder.

A command reporting 100% or upload success is not the completion gate. Internal
TestFlight availability is also separate from public App Store submission.
Record the source commit, local artifact hashes, backend decision, macOS URLs,
upload result, and TestFlight group state. Remove task-owned tunnels, temporary
credentials, raw logs, obsolete worktrees, and regenerable build output once
unused; preserve approved release artifacts and other tasks' resources.

## Troubleshooting without restarting the whole release

| Symptom | Fast next step |
| --- | --- |
| Notarization upload interrupted | Inspect the private failure reason and retry the same candidate with compatible caches; do not replace signing identities or claim notarization succeeded. |
| Calendar request fails and Kordi is absent from Settings | Inspect the installed app's signed calendar entitlement and usage description. Rebuild/reinstall the corrected app; source changes alone do not update the installed copy. |
| UniFFI contains build-machine paths | Run the pinned source-build helper before archiving; keep its package override and provenance. |
| IPA payload is clean but symbols contain temporary paths | Use the archive compiler remapping above and re-export; do not strip required symbols to hide the failure. |
| App Group profile mismatch | Refresh the approved production profiles/capabilities. An offline Beta entitlement override must never reach release builds. |
| Tests wait for the phone | Unlock the physical iPhone and keep it awake. Mirroring connection alone does not unlock it for Xcode. |
| Scrolling works in Mirroring but not by touch | Test one-finger vertical scrolling, both row swipe directions, and neutral closure on the physical phone. |
| Local Beta says Cloud unavailable | Verify the Beta backend/test mode. Keep UI-only offline tests offline; never repoint Beta to production. |
| User still sees an old bug after a build | Verify the installed bundle and source/build evidence, then relaunch that exact app. Compilation alone is not installation. |
| Need to change source after upload/publication | Qualify and merge the fix, choose unused identifiers, and build a new candidate. Do not overwrite immutable artifacts. |
