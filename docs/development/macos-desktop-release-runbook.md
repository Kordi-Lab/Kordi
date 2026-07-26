# macOS desktop release operator runbook

This runbook supplements [the release guide](../release.md). It captures the
repeatable build and publication sequence established while releasing
`0.0.1-beta.9`. The release guide remains authoritative for signing profiles,
credentials, publisher arguments, channel policy, and backend deployment.

## Release invariant

One immutable, merged `origin/main` commit must identify all of the following:

- the version metadata
- the deployed Cloud server and runner images
- the agent and Bridges sidecars
- `Kordi.app`, its updater archive, and its DMG
- the product updater metadata
- the Git tag and GitHub prerelease

Record the commit before any deploy, build, upload, or tag. Do not release from
a dirty development checkout, combine artifacts from different commits, or
replace an immutable object after publication.

## Preflight before compiling

1. Fetch `origin/main`, select the merged release commit, and create a clean
   detached worktree for it.
2. Confirm every version source and the release-version test agree.
3. Select the release profile before building:
   - production requires Developer ID signing and notarization;
   - ad-hoc requires explicit approval and can publish only to `acceptance`.
4. Verify GCP authentication, signing material, disk space, memory pressure,
   mounted DMGs, running Kordi instances, and ports `9900` and `9901`.
5. Record the Rust, Xcode, and linker versions so a later rebuild can reproduce
   the toolchain.
6. Inspect the macOS system proxy with `scutil --proxy`. Never bake a proxy
   host or port into a release.

Useful read-only checks:

```bash
git fetch origin main
RELEASE_COMMIT="$(git rev-parse origin/main)"
git show --no-patch --oneline "$RELEASE_COMMIT"
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
rustc -Vv
xcodebuild -version
df -h /
vm_stat
hdiutil info
pgrep -fl 'Kordi|kordi-desktop|cargo|rustc' || true
lsof -nP -iTCP:9900 -iTCP:9901 || true
scutil --proxy
```

If interactive `gcloud` authentication has expired but Application Default
Credentials are valid, use a short-lived access token without printing it:

```bash
set +x
export CLOUDSDK_AUTH_ACCESS_TOKEN="$(
  gcloud auth application-default print-access-token
)"
```

Unset `CLOUDSDK_AUTH_ACCESS_TOKEN` during cleanup.

## Build from a physical neutral path

Rust can embed source paths through debug metadata and compile-time values such
as `CARGO_MANIFEST_DIR`. `--remap-path-prefix` removes home-directory paths
from ordinary compiler output, but Cargo canonicalizes symlinks before setting
some compile-time values. A symlink to a checkout under `/Users` is therefore
not sufficient.

Create a real worktree at an operator-controlled physical path outside the
home directory. Use a version-specific path if another release worktree may
exist:

```bash
RELEASE_COMMIT="$(git rev-parse origin/main)"
RELEASE_SOURCE_ROOT=/Applications/KordiReleaseSource-betaN
test ! -e "$RELEASE_SOURCE_ROOT"
git worktree add --detach "$RELEASE_SOURCE_ROOT" "$RELEASE_COMMIT"
cd "$RELEASE_SOURCE_ROOT"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test -z "$(git status --short)"
```

Use path remapping for the desktop binary and both native sidecars:

```bash
export RUSTFLAGS="--remap-path-prefix=$HOME=/build"
export CARGO_BUILD_JOBS=1
unset VITE_KORDI_CLOUD_API_BASE
```

`CARGO_BUILD_JOBS=1` is the safe default on the release Mac. Building the
agent, Bridges, and Tauri dependency graph concurrently caused severe memory
pressure and multiple multi-gigabyte Kordi processes during beta.9.

Persistent `CARGO_TARGET_DIR` caches under
`$HOME/.cache/kordi/releases/` may be reused when the toolchain, target,
`RUSTFLAGS`, and relevant lockfiles are compatible. Name new caches by
component, release, remapping mode, and short commit. Rebuild only a sidecar
whose source or dependency graph changed, but always scan the staged binary.
Do not commit local cache paths to the repository.

## macOS linker compatibility

The beta.9 toolchain produced malformed build-time Rust proc-macro dylibs when
they were linked with a macOS 12 minimum on the current linker. The shipped app
still targets macOS 12; lowering the application deployment target is not an
acceptable workaround.

If that failure recurs:

1. Confirm it affects a build-time proc-macro dylib under Cargo's `deps`
   directory, not `Kordi.app` or a shipped sidecar.
2. Inspect the failing dylib with `otool -l` or `vtool -show-build`.
3. Use a temporary target-linker wrapper scoped only to those proc-macro
   dylibs, with macOS 11 as their linker minimum.
4. Keep the application deployment target unchanged.
5. Verify the final app executable and sidecars still report the intended
   macOS 12 minimum.

Do not apply this workaround proactively or globally. Record the exact linker
command and toolchain with the release artifacts if it is needed.

## Fast release order

Use this order so expensive work and external state changes happen only after
their prerequisites are known:

1. Merge the release-preparation PR and pin `RELEASE_COMMIT`.
2. Back up the production database.
3. Deploy server and runner images built from `RELEASE_COMMIT`; verify rollout,
   schema, secret-free logs, and public health.
4. Build or reuse path-remapped sidecars, then build the desktop bundle from
   the physical neutral worktree.
5. Run the source gate, bundle/signing gate, DMG layout gate, checksum gate,
   and final artifact privacy scan.
6. Run `release:publish-desktop --dry-run` before opening MinIO tunnels.
7. Inspect and replace only known stale remote port-forwards, then open the
   loopback-only MinIO and SSH tunnels.
8. Publish immutable objects and the `acceptance` pointer.
9. Verify the public manifest, updater archive, direct DMG, and current-version
   HTTP `204` behavior against the locally recorded metadata.
10. Rehearse rollback, restore the exact pointer bytes and `pubDate`, and repeat
    public verification.
11. Create the annotated Git tag and GitHub prerelease from the same commit and
    DMG only after product verification succeeds.
12. Verify the GitHub asset digest and size, close tunnels, remove secrets,
    detach DMGs, and remove the neutral worktree.

## Publication and rollback checks

Before any network publication, preserve:

- `release.json`
- the generated channel pointer
- `pubDate`
- SHA-256 and byte size of the DMG and updater archive
- SHA-256 of `release.json` and the channel pointer
- the prior channel bytes and ETag, when present

After publishing `acceptance`, verify:

- the prior supported client receives the expected manifest;
- a client already on the released version receives HTTP `204`;
- manifest values exactly equal the local `release.json`;
- product-domain DMG and archive GET/HEAD sizes match local artifacts;
- downloaded product artifacts reproduce the local SHA-256 values;
- `https://kordi.ai/health` is healthy.

Then clear `acceptance`, verify HTTP `204` for the previous client, and restore
the exact same metadata. In zsh, `status` is read-only; use a variable such as
`http_code`:

```bash
http_code="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    "$ACCEPTANCE_UPDATER_URL"
)"
test "$http_code" = 204
```

Never generate a new `pubDate` during restoration. A rollback rehearsal is not
complete until the restored public manifest and downloads are reverified.

## Privacy and release integrity

Do not publish if the app bundle, updater archive, mounted DMG, or native
binaries contain:

- `/Users/`, `/private/tmp`, or `/var/folders`
- build-machine account names
- test hostnames, raw product IP addresses, or temporary tunnel origins
- local account, session, cache, or preference data
- credentials or signing material

Use the full scan in [the release guide](../release.md#required-artifact-privacy-scan).
The GitHub DMG and product DMG must have the same SHA-256, byte size, version,
and source commit. If a bad artifact reaches versioned storage, abandon that
version; never repair or replace it in place.

## Cleanup

Before declaring the release complete:

- unset updater, publisher, Apple, and temporary GCP environment variables;
- delete mode-`700` temporary secret directories and temporary keychains;
- close local SSH and remote MinIO port-forwards;
- detach stale DMG mounts;
- stop release-only Kordi processes;
- remove the neutral worktree with `git worktree remove`;
- preserve only non-secret release artifacts and validated build caches;
- confirm the original development worktree is unchanged.

## Beta.9 reference result

The following values provide a known-good comparison point:

- version: `0.0.1-beta.9`
- tag: `V0.0.1.beta9`
- source commit: `1e9446a38996fab2c6380228be600385caec6828`
- publication date: `2026-07-23T01:29:58Z`
- DMG size: `25,860,332` bytes
- DMG SHA-256:
  `05e06961b4f23734f00e7db484b824c66467d3fe5ca2c9c97595650dcef0650f`
- updater archive SHA-256:
  `bc819b673ff61c9d755b1dc5228f494441760d93fd98b403c2de6b328e8eeaf4`
- product `release.json` SHA-256:
  `3b89914be6e1c319ee4b1d8da2cf3cfe5c93b208519c0f3b7ea0e2136d252715`
- acceptance pointer SHA-256:
  `f108464c3460bebd3757d077a12b8b5efb718f1b39eeb97e110cf19f5566eee8`
- [GitHub release](https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta9)
- [product DMG](https://kordi.ai/updates/releases/0.0.1-beta.9/Kordi_0.0.1-beta.9_aarch64.dmg)

Beta.9 was explicitly approved as ad-hoc signed and non-notarized. It was
published to the acceptance updater channel and mirrored as a GitHub
prerelease; it was not promoted to the normal signed beta updater channel.
