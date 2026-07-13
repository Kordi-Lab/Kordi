# Beta.6 Signed MinIO Desktop Updater Design

**Status:** Approved for implementation on 2026-07-13

## Goal

Publish the current `origin/main` as Kordi Desktop `0.0.1-beta.6` and make beta.6 the bootstrap release for secure in-app updates. A user on beta.6 or later confirms once, then Kordi downloads a signed update through `coordinar.io`, installs it, and relaunches automatically.

The already-published beta.5 desktop does not contain the updater integration. Beta.5 users therefore install beta.6 manually once. This limitation is explicit and is not treated as a failed automatic-update path.

## Decisions

- Use Tauri v2 updater and process plugins instead of the custom DMG shell installer.
- Store release artifacts in a private MinIO bucket named `kordi-releases`.
- Expose manifests and downloads only through HTTPS URLs on `coordinar.io`.
- Generate a new Tauri updater key pair for beta.6. Beta.5 has no embedded updater key, so no key compatibility is required.
- Keep the existing sidebar update indicator and confirmation popover.
- Treat confirmation as final authorization: download, verify, install, and relaunch without a second restart prompt.
- Publish immutable version manifests and assets before atomically advancing the beta channel pointer.
- Publish a GitHub prerelease as a historical mirror, but never require GitHub authentication or availability for desktop updates.
- Support macOS arm64 for beta.6. Unsupported target and architecture combinations receive HTTP 204 from the updater endpoint.

## Release storage model

The `kordi-releases` bucket remains private. Anonymous MinIO access is disabled. Objects use immutable versioned keys:

```text
desktop/releases/0.0.1-beta.6/release.json
desktop/releases/0.0.1-beta.6/macos/aarch64/Kordi_0.0.1-beta.6_aarch64.dmg
desktop/releases/0.0.1-beta.6/macos/aarch64/Kordi.app.tar.gz
desktop/releases/0.0.1-beta.6/macos/aarch64/Kordi.app.tar.gz.sig
desktop/releases/0.0.1-beta.6/checksums.sha256
desktop/channels/beta/latest.json
desktop/channels/acceptance/latest.json
```

`release.json` is immutable and contains the release metadata plus an allow-list of downloadable objects:

```yaml
schemaVersion: 1
version: 0.0.1-beta.6
notes: Kordi 0.0.1-beta.6
pubDate: RFC 3339 UTC timestamp
changelogUrl: https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta6
manual:
  objectKey: desktop/releases/0.0.1-beta.6/macos/aarch64/Kordi_0.0.1-beta.6_aarch64.dmg
  fileName: Kordi_0.0.1-beta.6_aarch64.dmg
  contentType: application/x-apple-diskimage
  sha256: 64-character lowercase hexadecimal digest
  sizeBytes: measured positive integer
platforms:
  darwin-aarch64:
    objectKey: desktop/releases/0.0.1-beta.6/macos/aarch64/Kordi.app.tar.gz
    fileName: Kordi.app.tar.gz
    contentType: application/gzip
    signature: Tauri minisign signature text
    sha256: 64-character lowercase hexadecimal digest
    sizeBytes: measured positive integer
```

Schema validation rejects non-positive sizes, malformed versions, unrecognized platforms, unsafe file names, invalid digests or signatures, and object keys outside the release version prefix.

`desktop/channels/beta/latest.json` is the mutable promotion pointer:

```yaml
schemaVersion: 1
channel: beta
releaseManifestKey: desktop/releases/0.0.1-beta.6/release.json
releaseManifestSha256: 64-character lowercase hexadecimal digest
```

The channel pointer is uploaded last. Rollback restores the previous validated pointer; immutable release objects are not deleted during an incident.

The `acceptance` channel uses the same pointer schema and immutable release objects. It is served by a separate acceptance-only updater endpoint and never changes what production beta clients see. The acceptance pointer is removed after the end-to-end installer test.

## Credentials and signing

The updater private key and its password are never committed, uploaded to MinIO, included in logs, or embedded in the app. They are stored in GCP Secret Manager and exposed to the local release process only through the Tauri signing environment variables. Beta.6 embeds only the generated public key.

The Cloud server receives read-only credentials scoped to `kordi-releases`. The release publisher uses separate write credentials scoped to that bucket. Attachment credentials and the `kordi-attachments` bucket remain independent.

The release process must also verify the macOS application signature and Gatekeeper assessment. Missing Apple signing/notarization material blocks publishing rather than producing a degraded public artifact.

## Public Cloud update API

The Cloud server owns a focused `updates` module and a release-store abstraction. Production uses MinIO through the S3-compatible API; tests use an in-memory store.

### Tauri updater manifest

```text
GET /updates/desktop/{target}/{arch}/{current_version}
```

The handler:

1. Loads and validates the beta channel pointer.
2. Loads the referenced immutable release manifest and verifies its recorded SHA-256.
3. Parses both versions semantically.
4. Returns HTTP 204 when the current client is equal to or newer than the channel release.
5. Returns HTTP 204 when the exact `{target}-{arch}` platform is unavailable.
6. Returns a Tauri v2 manifest for an available update:

```json
{
  "version": "0.0.1-beta.6",
  "notes": "Kordi 0.0.1-beta.6",
  "pub_date": "2026-07-13T00:00:00Z",
  "url": "https://coordinar.io/updates/releases/0.0.1-beta.6/Kordi.app.tar.gz",
  "signature": "Tauri minisign signature text"
}
```

Malformed storage metadata returns HTTP 503 and a non-sensitive error body. It never produces an unsigned or partially populated update response.

An internal package may use this separate endpoint during release acceptance:

```text
GET /updates/desktop/acceptance/{target}/{arch}/{current_version}
```

It has identical validation and response behavior but reads `desktop/channels/acceptance/latest.json`. The public beta.6 app never configures or calls this endpoint.

### Immutable artifact downloads

```text
GET  /updates/releases/{version}/{asset}
HEAD /updates/releases/{version}/{asset}
```

The handler loads that version's immutable `release.json`, confirms that the requested file is allow-listed, then streams the private MinIO object without exposing an internal endpoint or credential. It verifies the stored byte count and sets:

- the allow-listed content type;
- `Content-Length`;
- `ETag` derived from SHA-256;
- `X-Checksum-Sha256`;
- `Cache-Control: public, max-age=31536000, immutable`.

Path traversal, encoded separators, unknown versions, unknown files, and unlisted objects return HTTP 404.

### Stable manual beta download

```text
GET  /updates/releases/latest/Kordi.dmg
HEAD /updates/releases/latest/Kordi.dmg
```

This resolves the current beta channel to its allow-listed manual DMG and streams it with `Cache-Control: no-store`. It is the public product URL used for the one-time beta.5 to beta.6 installation and as the updater failure fallback.

### Legacy metadata compatibility

```text
GET /updates/releases/version
```

The existing route remains during beta.6. Once a valid beta channel pointer exists, it derives `version`, `changelogUrl`, `downloadUrl`, and `signature` from that channel manifest. `downloadUrl` points to the stable product-domain manual DMG. Before the beta channel is first promoted, the route retains the existing beta.5 environment-backed metadata response; an absent channel therefore does not disrupt current development builds or CLI notices. Invalid channel metadata never supplies a download URL. This compatibility path is read-only and does not participate in Tauri installation.

## Desktop updater

The desktop initializes `tauri-plugin-updater` and `tauri-plugin-process`. Both Tauri configs:

- enable updater artifact creation;
- embed the beta.6 updater public key;
- use `https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}`;
- contain no GitHub, MinIO, raw GCP, tunnel, or local endpoint.

A TypeScript updater service owns the checked Tauri `Update` object and exposes a small adapter-driven controller for tests. Startup performs one quiet update check. When no update exists or checking fails, no update control appears.

When an update is available, the existing sidebar indicator opens the existing confirmation popover. Confirmation performs this single state transition:

```text
available -> downloading -> installing -> relaunching
```

The service calls `downloadAndInstall`, reports byte progress to the UI, then calls `relaunch` only after the plugin reports successful installation. A failed check remains quiet. A failed download, signature check, or installation shows a retry action and the product-domain manual DMG fallback. The current application remains installed and runnable.

The custom native commands that accept arbitrary download URLs and generate a shell script which deletes `/Applications/Kordi.app` are removed. The desktop does not accept HTTP updater endpoints, arbitrary artifact hosts, or a renderer-supplied installer URL.

## Release publisher

A tested publisher script accepts an already-built release directory plus a channel. It performs no build itself. Its responsibilities are:

1. Require a clean repository at the expected release commit.
2. Verify beta.6 version parity across package, Tauri, Cargo, locks, and release tests.
3. Locate the DMG, Tauri updater archive, updater signature, and application bundle.
4. Verify updater signature metadata, SHA-256 digests, measured byte counts, DMG layout, privacy scan, code signature, Gatekeeper assessment, and product origin.
5. Generate and validate `release.json`, `checksums.sha256`, and the beta channel pointer.
6. Refuse to overwrite an existing immutable object with different bytes.
7. Upload immutable objects and `release.json`.
8. Verify each artifact through its unauthenticated `coordinar.io` GET and HEAD routes.
9. Upload the channel pointer last.
10. Re-read the public Tauri endpoint and stable DMG endpoint to verify the promoted release.

The script supports `--dry-run`, which performs every local validation and generates metadata without uploading or changing the channel.

## Release and deployment sequence

1. Create a release branch from the exact current `origin/main` commit.
2. Implement updater, Cloud routes, MinIO bucket/policies, publisher, tests, documentation, and beta.6 version metadata in a new PR.
3. Run the complete validation matrix and review the entire PR diff.
4. Merge the PR into `main` and record the merge commit.
5. Create a pre-deploy Postgres dump even though the update routes add no database migration.
6. Deploy the Cloud server and MinIO bucket/policies from the merged release commit while the beta pointer is absent or still references beta.5.
7. Verify health, rollout, logs, MinIO readiness, and 204 behavior for an unpublished release.
8. Build signed/notarized beta.6 artifacts from a clean worktree at the merge commit.
9. Upload beta.6 immutable objects and an acceptance-channel pointer.
10. Use an internal updater-enabled `0.0.1-beta.5.1` package to verify signed download, install, data preservation, and automatic relaunch to beta.6.
11. Install the public beta.6 DMG over beta.5 once and verify account, keychain, canonical sessions, caches, and preferences remain intact.
12. Promote `desktop/channels/beta/latest.json` only after both acceptance paths pass.
13. Create annotated tag `V0.0.1.beta6` and the GitHub prerelease mirror with the DMG, checksums, release commit, product URLs, deployed image tag, and verification evidence.

## Failure handling and rollback

- Missing secrets, invalid signatures, checksum differences, version mismatches, privacy findings, code-sign failures, Gatekeeper failures, failed tests, or failed public downloads block promotion.
- A Cloud server failure before promotion leaves beta.5 metadata unchanged.
- A failed channel promotion is rolled back by restoring the previous pointer bytes and verifying the public endpoints again.
- A corrupt or tampered updater artifact is rejected by both SHA-256 release validation and the Tauri embedded signature before installation.
- Download or install errors remain visible in the confirmation surface with retry and manual-product-download actions.
- Logs include version, platform, byte count, digest, and status only. They exclude signing keys, passwords, object-store credentials, user data, and signed internal URLs.

## Test strategy

All behavior changes use red-green test-driven development.

### Desktop tests

- Updater service stays idle outside Tauri.
- An available update produces the sidebar indicator.
- Confirmation calls download/install exactly once and relaunches only after success.
- Progress events update the confirmation state.
- Signature/install failure does not relaunch and exposes retry plus the product fallback.
- Tauri configs declare updater/process plugins, updater artifact creation, the `coordinar.io` endpoint, and the embedded public key.
- Source contracts prove the arbitrary-URL Rust downloader and destructive installer script are absent.

### Cloud server tests

- Valid channel and release manifests produce the exact Tauri response.
- Equal, newer, malformed, and unsupported clients receive the required safe response.
- Semantic prerelease ordering offers beta.6 to beta.5.1 and never offers beta.5 to beta.6.
- Missing, corrupt, or digest-mismatched storage metadata fails closed.
- Asset routes allow only manifest-listed objects and set the required headers.
- Path traversal, encoded separators, unlisted files, and private MinIO details never reach a response.
- The legacy version route and stable manual DMG resolve from the same channel manifest.

### Publisher tests

- Dry-run metadata is deterministic for fixture artifacts.
- Missing signatures, template-only field values, wrong versions, wrong hashes, and unsafe object keys fail before upload.
- Immutable-object conflicts stop publishing.
- The channel pointer is the final write.
- Rollback restores the exact previous pointer.

### Full validation

- `pnpm check:frontend`
- updater and release script test suites
- `cargo test -p kordi-desktop --no-default-features -- --test-threads=1`
- `cargo test -p kordi-cloud-server`
- real-Postgres Cloud server tests with `DATABASE_URL` configured
- workspace Clippy, dependency, hygiene, diff, and script gates
- chat-scale benchmark
- Cloud DMG build, updater artifact generation, privacy scan, code-sign verification, Gatekeeper assessment, and artifact checksum verification

## Production acceptance

Promotion requires recorded evidence that:

- the beta.6 manual DMG downloads anonymously from `coordinar.io`;
- beta.5 installs beta.6 manually without losing login, keychain, canonical sessions, cache, or preferences;
- the internal beta.5.1 acceptance package discovers beta.6 through the product endpoint;
- one confirmation downloads, verifies, installs, and relaunches;
- the relaunched application reports `0.0.1-beta.6`;
- a deliberately tampered artifact is rejected and the existing app remains usable;
- equal and newer client versions receive no downgrade;
- product downloads work without GitHub authentication;
- restoring the prior beta channel pointer restores the prior public metadata.

## Out of scope

- Automatic bootstrap from the already-published beta.5 desktop.
- Windows, Linux, or macOS x86_64 updater artifacts in beta.6.
- A general-purpose public MinIO gateway.
- Deleting historical release objects automatically.
- Replacing the existing attachment bucket or attachment presigned-URL flow.
