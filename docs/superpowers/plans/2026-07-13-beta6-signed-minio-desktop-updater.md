# Kordi 0.0.1-beta.6 Signed MinIO Desktop Updater Implementation Plan

> **Execution mode:** Run this plan inline, in order, from the isolated `agent/beta6-signed-updater` worktree. Stop promotion—not implementation—when a required production credential or Apple trust check is unavailable.

**Goal:** Release the current `origin/main` as Kordi Desktop `0.0.1-beta.6`, replace the unsafe custom DMG installer with Tauri's signed updater, serve private MinIO release objects through `https://coordinar.io`, and verify the complete install-and-relaunch flow before promoting the beta channel.

**Architecture:** The desktop uses `tauri-plugin-updater` and `tauri-plugin-process` against one product-domain endpoint. The Cloud server validates a small mutable channel pointer plus an immutable release manifest before returning updater metadata or proxying an allow-listed object from a private `kordi-releases` bucket. A tested Node publisher validates signed artifacts, uploads immutable objects first, verifies product-domain reads, and writes the mutable channel pointer last.

**Technology:** Tauri v2, React/TypeScript, Rust/Axum, MinIO S3 API, Node test runner, AWS SDK for JavaScript v3, Kubernetes/k3s, GCP Secret Manager, GitHub CLI.

**Approved design:** `docs/superpowers/specs/2026-07-13-beta6-signed-minio-desktop-updater-design.md`

---

## Task 1: Record release prerequisites and create the updater signing identity

**Files:**

- Create: `app/desktop/scripts/check-release-prerequisites.mjs`
- Create: `app/desktop/tests/releasePrerequisites.test.mjs`
- Modify: `app/desktop/package.json`
- Modify: `.gitignore`
- Modify: `docs/release.md`

### Step 1: Write failing prerequisite tests

Add tests that run the checker with injected command/env adapters and assert that it:

- accepts the exact clean Git commit supplied with `--expected-commit`;
- rejects a dirty tree, missing Tauri signing variables, missing Apple signing identity, failed `codesign`, and failed Gatekeeper assessment;
- redacts secret values and identity details from output;
- permits `--source-only` for CI source verification without pretending artifacts are publishable.

Run:

```bash
pnpm --dir app/desktop exec node --test tests/releasePrerequisites.test.mjs
```

Expected: FAIL because the checker does not exist.

### Step 2: Implement the fail-closed checker

Implement a dependency-injected checker and CLI. Production mode must require:

- a clean worktree at `--expected-commit`;
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
- at least one valid macOS Developer ID Application signing identity;
- an app bundle that passes `codesign --verify --deep --strict --verbose=2`;
- an app bundle that passes `spctl --assess --type execute --verbose=2`.

Never print key material, credential values, signed MinIO URLs, or the full signing identity.

Generate the Tauri updater key pair once with the Tauri CLI. Store the private key and password in GCP Secret Manager; commit only the public key text through Tauri configuration. Add private-key filename patterns to `.gitignore` before generating local material.

Use these production secret names consistently:

- `kordi-tauri-updater-private-key`
- `kordi-tauri-updater-private-key-password`
- `kordi-apple-developer-id-p12`
- `kordi-apple-developer-id-p12-password`
- `kordi-apple-notary-issuer-id`
- `kordi-apple-notary-key-id`
- `kordi-apple-notary-private-key`

Document the exact Secret Manager import/export commands without including values.

### Step 3: Make tests pass and commit

Run the focused tests and source-only check, then commit:

```bash
pnpm --dir app/desktop exec node --test tests/releasePrerequisites.test.mjs
pnpm --dir app/desktop release:prerequisites -- --source-only --expected-commit "$(git rev-parse HEAD)"
git add .gitignore app/desktop/package.json app/desktop/scripts/check-release-prerequisites.mjs app/desktop/tests/releasePrerequisites.test.mjs docs/release.md
git commit -m "build: add fail-closed desktop release prerequisites"
```

## Task 2: Configure Tauri's signed updater and process plugins

**Files:**

- Create: `app/desktop/tests/tauriUpdaterConfig.test.mjs`
- Modify: `app/desktop/package.json`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify: `app/desktop/src-tauri/src/lib.rs`
- Modify: `app/desktop/src-tauri/capabilities/default.json`
- Modify: `app/desktop/src-tauri/tauri.conf.json`
- Modify: `app/desktop/src-tauri/tauri.cloud.conf.json`
- Modify: `app/desktop/src-tauri/Cargo.lock`
- Modify: `app/desktop/package-lock.json`
- Modify: `pnpm-lock.yaml`

### Step 1: Write the failing configuration contract

The test must parse—not regex-only inspect—both Tauri config layers and assert:

- `bundle.createUpdaterArtifacts` is true;
- `plugins.updater.endpoints` contains only `https://coordinar.io/updates/desktop/{{target}}/{{arch}}/{{current_version}}`;
- `plugins.updater.pubkey` is a non-template minisign public key;
- the default capability includes `updater:default` and `process:allow-restart`;
- JS and Rust updater/process plugin dependencies use Tauri v2;
- `lib.rs` initializes both plugins;
- no updater endpoint contains HTTP, GitHub, MinIO, localhost, a raw IP, or GCP hostnames.

Run:

```bash
pnpm --dir app/desktop exec node --test tests/tauriUpdaterConfig.test.mjs
```

Expected: FAIL on the missing plugin configuration and dependencies.

### Step 2: Add official Tauri integrations

Install:

```bash
pnpm --dir app/desktop add @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2
```

Add matching Rust crates, initialize them in `run()`, grant only the required capabilities, embed the generated public key, and configure the product-domain endpoint. Preserve the cloud bundle identifier override.

### Step 3: Verify and commit

Run:

```bash
pnpm --dir app/desktop exec node --test tests/tauriUpdaterConfig.test.mjs
cargo check -p kordi-desktop --no-default-features
git add app/desktop pnpm-lock.yaml
git commit -m "feat(desktop): configure signed Tauri updater"
```

## Task 3: Build a testable desktop updater controller

**Files:**

- Create: `app/desktop/src/features/updates/desktopUpdater.ts`
- Create: `app/desktop/tests/desktopUpdater.test.ts`
- Modify: `app/desktop/src/lib/desktop.ts`

### Step 1: Write failing controller tests

Use a fake adapter that implements `check`, `downloadAndInstall`, and `relaunch`. Cover:

- web/non-Tauri mode returns unavailable without importing plugins;
- an available update is retained as the exact checked update object;
- confirming calls `downloadAndInstall` exactly once;
- progress maps `Started`, `Progress`, and `Finished` events to downloading/installing states and byte totals;
- relaunch happens only after successful installation;
- signature/download/install failure never relaunches and exposes retry plus `https://coordinar.io/updates/releases/latest/Kordi.dmg`;
- concurrent confirms coalesce into one install;
- retry uses the already checked update unless a new check is explicitly requested;
- disposing closes the held updater object when the plugin supplies `close()`.

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts
```

Expected: FAIL because the controller does not exist.

### Step 2: Implement adapter and controller

Define a narrow adapter boundary and a state machine with these public states:

```text
idle | available | downloading | installing | relaunching | failed
```

The real adapter dynamically imports `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`, calls `check()`, stores the returned `Update`, calls `update.downloadAndInstall(listener)`, and then calls `relaunch()`. It must not accept a URL, signature, path, or installer command from React.

Keep the existing exported `checkDesktopForUpdates` and `installDesktopUpdate` names temporarily as typed controller façades so sidebar wiring can change without a broad app refactor.

### Step 3: Verify and commit

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts
pnpm --dir app/desktop typecheck
git add app/desktop/src/features/updates/desktopUpdater.ts app/desktop/src/lib/desktop.ts app/desktop/tests/desktopUpdater.test.ts
git commit -m "feat(desktop): add signed updater controller"
```

## Task 4: Wire sidebar confirmation, progress, retry, and remove the unsafe installer

**Files:**

- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Modify: `app/desktop/tests/desktopUpdateButton.test.tsx`
- Create: `app/desktop/tests/desktopUpdaterSourceContract.test.mjs`
- Modify: `app/desktop/src-tauri/src/lib.rs`

### Step 1: Change tests to the intended UI/security contracts

Update the component test to assert:

- startup check is quiet unless an update exists;
- confirmation transitions through downloading, installing, and relaunching;
- progress copy includes received bytes when totals are known;
- failures show Retry and a manual product download action;
- download/install controls do not depend on `downloadUrl`.

Add a source contract that rejects:

- `desktop_check_for_updates` and `desktop_install_update` Tauri commands;
- renderer-supplied `downloadUrl` installer arguments;
- `rm -rf "/Applications/$APP_NAME"`;
- the generated `install-kordi-update.sh` flow;
- updater acceptance of HTTP URLs.

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdateButton.test.tsx
pnpm --dir app/desktop exec node --test tests/desktopUpdaterSourceContract.test.mjs
```

Expected: FAIL against the legacy URL-driven implementation.

### Step 2: Wire controller state and delete custom native updater code

Preserve the existing update indicator and confirmation popover. Replace its props with URL-free check/confirm/retry callbacks and progress state. The first confirmation is final authorization for download, verified install, and relaunch.

Remove the custom update parsing, blocking download, temporary DMG, shell script, commands, command registration, and obsolete imports/constants from `lib.rs`. Do not remove unrelated presence HTTP code.

### Step 3: Verify and commit

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopUpdateButton.test.tsx
pnpm --dir app/desktop exec node --test tests/desktopUpdaterSourceContract.test.mjs
pnpm --dir app/desktop typecheck
cargo test -p kordi-desktop --no-default-features -- --test-threads=1
git add app/desktop/src app/desktop/src-tauri/src/lib.rs app/desktop/tests
git commit -m "fix(desktop): replace unsafe DMG installer with signed updates"
```

## Task 5: Define and validate release catalog metadata

**Files:**

- Create: `bridges/cloud-server/src/updates/mod.rs`
- Create: `bridges/cloud-server/src/updates/model.rs`
- Create: `bridges/cloud-server/src/updates/model_tests.rs`
- Modify: `bridges/cloud-server/src/lib.rs`
- Modify: `bridges/cloud-server/Cargo.toml`
- Modify: `Cargo.lock`

### Step 1: Write failing model tests

Cover exact schema validation for `ReleaseManifest`, `ChannelPointer`, `ReleaseAsset`, and platform keys. Tests must reject:

- invalid or non-semantic versions;
- non-RFC3339 publication dates;
- zero sizes;
- non-lowercase or non-64-character SHA-256 digests;
- empty/template signatures;
- unknown platforms;
- unsafe filenames, encoded separators, and path traversal;
- object keys outside `desktop/releases/{version}/`;
- a channel pointer whose manifest key is not versioned under `desktop/releases/`.

Also test semantic prerelease ordering: beta.6 is offered to beta.5.1, while beta.5 is never offered to beta.6.

Run:

```bash
cargo test -p kordi-cloud-server updates::model_tests -- --nocapture
```

Expected: FAIL because the module and types do not exist.

### Step 2: Implement strict types and pure response selection

Use `semver` for comparisons and `chrono` for publication-date parsing. Keep serialized field names identical to the approved JSON schema. Add a pure `select_update` function that returns update, no-update, unsupported, or validation error without touching network state.

### Step 3: Verify and commit

```bash
cargo test -p kordi-cloud-server updates::model_tests -- --nocapture
cargo fmt --all -- --check
git add bridges/cloud-server/src/updates bridges/cloud-server/src/lib.rs bridges/cloud-server/Cargo.toml Cargo.lock
git commit -m "feat(cloud): validate desktop release metadata"
```

## Task 6: Add a private release-store abstraction

**Files:**

- Create: `bridges/cloud-server/src/updates/store.rs`
- Create: `bridges/cloud-server/src/updates/store_tests.rs`
- Modify: `bridges/cloud-server/src/updates/mod.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Modify: `bridges/cloud-server/Cargo.toml`
- Modify: `Cargo.lock`

### Step 1: Write failing store tests

Provide an in-memory backend and cover:

- loading `desktop/channels/{channel}/latest.json`;
- loading the immutable manifest and verifying the pointer digest before parsing;
- missing pointer as a distinct not-published result;
- corrupt JSON, digest mismatch, oversized metadata, and backend failures as fail-closed errors;
- exact allow-list lookup by version and filename;
- object length mismatch before a public stream is returned;
- no error or debug representation exposes endpoint credentials or signed internal URLs.

Run:

```bash
cargo test -p kordi-cloud-server updates::store_tests -- --nocapture
```

Expected: FAIL because the store abstraction does not exist.

### Step 2: Implement memory-test and MinIO production backends

Add a small async backend interface with `get_metadata`, `head_object`, and `stream_object`. The production implementation reads only:

- `KORDI_RELEASE_S3_ENDPOINT`
- `KORDI_RELEASE_S3_BUCKET`
- `KORDI_RELEASE_S3_REGION`
- `KORDI_RELEASE_S3_ACCESS_KEY`
- `KORDI_RELEASE_S3_SECRET_KEY`

Use `rusty-s3` only to produce short-lived internal signed requests and `reqwest` to execute them. Metadata reads are capped at 1 MiB. Artifact GET remains streaming. Verify expected `Content-Length` before returning the stream. Keep the release store independent from attachment `S3Config`.

Add `release_store: Option<Arc<dyn ReleaseStoreBackend>>` to `ServerState`, with explicit production wiring and test injection.

### Step 3: Verify and commit

```bash
cargo test -p kordi-cloud-server updates::store_tests -- --nocapture
cargo test -p kordi-cloud-server
git add bridges/cloud-server/src/updates bridges/cloud-server/src/server.rs bridges/cloud-server/Cargo.toml Cargo.lock
git commit -m "feat(cloud): add private MinIO release store"
```

## Task 7: Serve updater metadata and allow-listed artifacts through coordinar.io

**Files:**

- Create: `bridges/cloud-server/src/updates/routes.rs`
- Create: `bridges/cloud-server/src/updates/routes_tests.rs`
- Modify: `bridges/cloud-server/src/updates/mod.rs`
- Modify: `bridges/cloud-server/src/server.rs`

### Step 1: Write failing route tests

Build an Axum router with the in-memory store. Cover:

- exact Tauri JSON for a valid beta update;
- 204 for equal/newer clients and unsupported target/architecture;
- 404 for malformed client versions and unlisted assets;
- 503 for malformed/digest-mismatched catalog metadata;
- acceptance endpoint reads only the acceptance pointer;
- immutable GET and HEAD set `Content-Type`, `Content-Length`, digest `ETag`, `X-Checksum-Sha256`, and immutable cache control;
- stable DMG GET and HEAD resolve the beta pointer and use `Cache-Control: no-store`;
- traversal, encoded slash/backslash, unknown version, unknown file, and a manifest object-key mismatch return 404;
- response bodies and headers never contain MinIO endpoint or credentials;
- legacy metadata derives the version and product-domain manual URL from the valid beta catalog, never emits `downloadUrl` or `signature`, and follows the shipped beta.5 decision branch that opens the URL instead of invoking its unsafe native installer.

Run:

```bash
cargo test -p kordi-cloud-server updates::routes_tests -- --nocapture
```

Expected: FAIL because the routes do not exist.

### Step 2: Implement routes and preserve compatibility

Mount:

```text
GET  /updates/desktop/{target}/{arch}/{current_version}
GET  /updates/desktop/acceptance/{target}/{arch}/{current_version}
GET  /updates/releases/{version}/{asset}
HEAD /updates/releases/{version}/{asset}
GET  /updates/releases/latest/Kordi.dmg
HEAD /updates/releases/latest/Kordi.dmg
GET  /updates/releases/version
```

Generate every public URL from `KORDI_CLOUD_PUBLIC_BASE_URL`, defaulting to `https://coordinar.io`. Never redirect to MinIO. Use a sanitized public error ID while logging only channel/version/platform/status/digest/size.

### Step 3: Verify and commit

```bash
cargo test -p kordi-cloud-server updates::routes_tests -- --nocapture
cargo test -p kordi-cloud-server
cargo fmt --all -- --check
git add bridges/cloud-server/src/updates bridges/cloud-server/src/server.rs
git commit -m "feat(cloud): serve signed desktop updates"
```

## Task 8: Provision the private release bucket and least-privilege identities

**Files:**

- Create: `bridges/cloud-server/deploy/k3s/policies/kordi-releases-reader.json`
- Create: `bridges/cloud-server/deploy/k3s/policies/kordi-releases-publisher.json`
- Create: `bridges/cloud-server/deploy/k3s/create-release-credentials.sh`
- Create: `scripts/release-minio-deploy.test.mjs`
- Modify: `bridges/cloud-server/deploy/k3s/manifests/minio.yaml`
- Modify: `bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml`
- Modify: `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
- Modify: `bridges/cloud-server/deploy/k3s/README.md`

### Step 1: Write failing deployment contract tests

Parse the Kubernetes YAML and policy JSON. Assert:

- `kordi-releases` is created privately and anonymous access stays disabled;
- the reader policy permits only bucket location/list and object read for `kordi-releases`;
- the publisher policy permits read/list/write but not delete or bucket-policy administration;
- the Cloud deployment reads a dedicated `kordi-release-reader` Secret and does not reuse attachment credentials;
- all five release-store environment variables are present;
- no committed YAML contains live keys or passwords;
- deployment validates the secret and bucket before rollout.

Run:

```bash
node --test scripts/release-minio-deploy.test.mjs
```

Expected: FAIL because the bucket, policies, and secret wiring do not exist.

### Step 2: Implement idempotent MinIO provisioning

Extend the MinIO bootstrap job to create only the private bucket and policies. Keep user credential creation in the operator script so generated values never enter manifests or logs. The script must:

- generate separate random reader and publisher credentials when absent;
- create/update MinIO users and attach the exact policies;
- create/update Kubernetes Secret `kordi-release-reader` with reader values;
- create/update GCP Secret Manager entries `kordi-release-publisher-access-key` and `kordi-release-publisher-secret-key` with publisher values;
- avoid echoing generated values;
- verify anonymous reads fail and scoped operations match policy.

### Step 3: Verify and commit

```bash
node --test scripts/release-minio-deploy.test.mjs
bash -n bridges/cloud-server/deploy/k3s/create-release-credentials.sh
bash -n bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
git add bridges/cloud-server/deploy/k3s scripts/release-minio-deploy.test.mjs
git commit -m "infra: provision private desktop release storage"
```

## Task 9: Implement the tested release publisher

**Files:**

- Create: `scripts/lib/desktop-release.mjs`
- Create: `scripts/publish-desktop-release.mjs`
- Create: `scripts/publish-desktop-release.test.mjs`
- Create: `scripts/fixtures/desktop-release/`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/release.md`

### Step 1: Write failing publisher tests

Use tiny fixture bytes and an injected object-store/public-HTTP adapter. Cover:

- deterministic manifest, pointer, and checksum output for a fixed `--pub-date`;
- exact beta.6 object keys and public URLs;
- invalid version, missing DMG/archive/signature/app bundle, template signature, unsafe filename/key, wrong app version, wrong hashes, dirty/wrong commit, failed DMG layout/privacy/codesign/Gatekeeper checks all fail before upload;
- immutable equal bytes are idempotent, different bytes are a hard conflict;
- immutable artifacts and manifest upload before any pointer write;
- GET and HEAD product-domain verification occurs before pointer promotion;
- pointer is the final write;
- a failed post-promotion verification restores the exact previous pointer bytes;
- dry-run performs local checks and writes generated metadata without network mutation;
- logs never contain credentials, private keys, internal URLs, or signature password.

Run:

```bash
node --test scripts/publish-desktop-release.test.mjs
```

Expected: FAIL because publisher modules do not exist.

### Step 2: Implement production adapters and CLI

Add `@aws-sdk/client-s3` as a root development dependency. The production adapter uses path-style S3 access with endpoint and credentials from:

- `KORDI_RELEASE_S3_ENDPOINT`
- `KORDI_RELEASE_S3_BUCKET=kordi-releases`
- `KORDI_RELEASE_S3_REGION`
- `KORDI_RELEASE_PUBLISHER_ACCESS_KEY`
- `KORDI_RELEASE_PUBLISHER_SECRET_KEY`

The CLI accepts `--release-dir`, `--app-bundle`, `--version`, `--channel`, `--expected-commit`, optional `--pub-date`, and `--dry-run`. It must perform no build. It writes generated metadata under the supplied release directory, uses conditional immutable writes, verifies product URLs, and updates the pointer last.

### Step 3: Verify and commit

```bash
node --test scripts/publish-desktop-release.test.mjs
pnpm test:scripts
git add package.json pnpm-lock.yaml scripts docs/release.md
git commit -m "feat(release): publish signed desktop artifacts to MinIO"
```

## Task 10: Set all desktop release metadata to beta.6

**Files:**

- Modify: `app/desktop/tests/releaseVersion.test.mjs`
- Modify: `app/desktop/package.json`
- Modify: `app/desktop/package-lock.json`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify: `app/desktop/src-tauri/Cargo.lock`
- Modify: `app/desktop/src-tauri/tauri.conf.json`
- Modify: `Cargo.lock`
- Modify: `bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml`
- Modify: `docs/release.md`

### Step 1: Make the release contract fail for beta.6

Change the test's expected release name and app version to:

```text
V0.0.1.beta6
0.0.1-beta.6
```

Run:

```bash
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
```

Expected: FAIL until every metadata source is synchronized.

### Step 2: Synchronize metadata and locks

Update all version sources, regenerate both npm locks and Rust locks through package managers, and set the legacy pre-promotion environment fallback to beta.5 until the beta pointer is valid. Do not hand-edit generated dependency sections beyond the package version fields they own.

### Step 3: Verify and commit

```bash
pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs
pnpm install --lockfile-only
cargo check -p kordi-desktop --no-default-features
git add app/desktop Cargo.lock pnpm-lock.yaml bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml docs/release.md
git commit -m "chore(release): set desktop version to beta.6"
```

## Task 11: Run local validation and review the complete branch

**Files:** Review all changed files; modify only to fix discovered failures.

### Step 1: Focused suites

```bash
pnpm --dir app/desktop exec node --test tests/releasePrerequisites.test.mjs tests/tauriUpdaterConfig.test.mjs tests/desktopUpdaterSourceContract.test.mjs tests/releaseVersion.test.mjs
pnpm --dir app/desktop exec tsx --test tests/desktopUpdater.test.ts tests/desktopUpdateButton.test.tsx
node --test scripts/publish-desktop-release.test.mjs scripts/release-minio-deploy.test.mjs
cargo test -p kordi-cloud-server updates -- --nocapture
```

### Step 2: Full validation matrix

```bash
pnpm check:frontend
cargo test -p kordi-desktop --no-default-features -- --test-threads=1
cargo test -p kordi-cloud-server
pnpm check:rust:fmt
pnpm check:rust:clippy
pnpm check:rust:deps
pnpm test:scripts
pnpm check:hygiene
pnpm --dir app/desktop bench:chat-scale
```

Run the Cloud server's real-Postgres test selection with the repository's configured `DATABASE_URL`. If no local Postgres is available, use the production VM's test database only through the documented isolated test path; never run destructive tests against production data.

### Step 3: Diff and secret review

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
pnpm --dir app/desktop release:secret-guard
```

Read the complete diff. Fix every failure with a regression test, rerun the affected focused suite, then rerun the full gate. Commit only verified repairs.

## Task 12: Open, review, and merge the implementation PR

### Step 1: Publish the branch and open a draft PR

Push `agent/beta6-signed-updater` and open a draft PR against `main`. The body must link the approved design, enumerate security boundaries, list exact test evidence, and explicitly state that beta.5→beta.6 is a one-time manual install.

### Step 2: Review CI and the complete PR

Wait for every required check. Inspect check logs for any failure, implement fixes test-first, and push. Review unresolved comments and the whole diff. Request ready-for-review only when all local and remote gates pass.

### Step 3: Merge one implementation PR

Merge using the repository's accepted merge method. Record the merge commit SHA and verify `origin/main` contains it. Do not tag or publish a release yet.

## Task 13: Deploy release storage and Cloud routes from merged main

### Step 1: Create production backup and record rollback state

SSH to:

```bash
gcloud compute ssh --zone "us-central1-a" "kordi-product" --project "hai-gcp-representation"
```

Create a timestamped Postgres dump using the existing production backup procedure, record the current Cloud deployment image/digest, export the existing beta pointer if present, and confirm `/health` plus legacy beta.5 metadata before mutation.

### Step 2: Provision storage and deploy

From the merge commit:

- apply the MinIO bucket/policies;
- create scoped reader/publisher identities;
- apply the Cloud deployment secret/env changes;
- build and deploy the Cloud server image tagged by merge SHA;
- wait for rollout and MinIO readiness.

### Step 3: Pre-publication production verification

Verify:

```text
/health -> 200
/updates/desktop/darwin/aarch64/0.0.1-beta.6 -> 204 while beta.6 is unpublished
/updates/releases/version -> existing beta.5 fallback metadata
anonymous MinIO kordi-releases GET -> denied
Cloud server reader identity -> read only
publisher identity -> read/write but no delete/policy administration
```

Inspect deployment events and logs for credential leakage and update-route errors.

## Task 14: Build signed and notarized beta.6 artifacts from the merge commit

### Step 1: Create a clean release worktree and load secrets safely

Create a clean detached worktree at the recorded merge SHA. Load Tauri and Apple materials from GCP Secret Manager into a temporary keychain/environment with shell history disabled. Register cleanup traps before importing material.

### Step 2: Build both updater and DMG artifacts

Run the source gates, sidecar preparation, and Tauri cloud build with updater artifact creation enabled. The output must include:

- `Kordi.app`;
- `Kordi_0.0.1-beta.6_aarch64.dmg`;
- `Kordi.app.tar.gz`;
- `Kordi.app.tar.gz.sig`.

Notarize and staple the application/DMG according to `docs/release.md`.

### Step 3: Verify before any upload

Run the prerequisite checker, DMG verifier, privacy scan, codesign verification, Gatekeeper assessment, signature presence checks, version parity checks, and publisher dry-run. Record SHA-256 digests and sizes. Destroy the temporary keychain and private-key files after verification.

Any missing Apple or updater credential, invalid signature, notarization failure, or Gatekeeper failure blocks publication.

## Task 15: Run acceptance-channel update and manual upgrade tests

### Step 1: Upload immutable beta.6 objects and acceptance pointer

Run the publisher for `--channel acceptance`. Verify public immutable GET/HEAD URLs and the acceptance updater endpoint. The production beta pointer remains unchanged.

### Step 2: Verify signed automatic update and relaunch

Build an internal `0.0.1-beta.5.1` package whose only endpoint override is the acceptance endpoint and whose embedded public key is identical to beta.6. On a disposable macOS user/profile:

- seed account/session/cache/preference markers;
- launch beta.5.1;
- confirm the update once;
- observe download progress, installation, and automatic relaunch;
- verify running version beta.6;
- verify markers and keychain/account state remain intact;
- verify no second confirmation and no destructive shell installer;
- exercise signature rejection with a deliberately mismatched fixture before the real acceptance run.

### Step 3: Verify the one-time beta.5 manual path

Install the public beta.6 DMG over an installed beta.5 copy. Verify account, keychain, canonical sessions, caches, and preferences remain intact and beta.6 starts normally. Remove the acceptance pointer after both tests, retaining immutable objects.

## Task 16: Promote beta.6 and verify production behavior

### Step 1: Promote pointer last

Run the publisher against `--channel beta`. It must re-verify immutable objects, write the beta pointer last, and verify the public updater and stable DMG endpoints.

### Step 2: Production acceptance matrix

Verify:

```text
beta.5 client metadata -> beta.6 legacy metadata plus manual coordinar.io DMG
beta.5.1 updater request -> signed beta.6 Tauri manifest
beta.6 updater request -> 204
beta.7 updater request -> 204 (no downgrade)
unsupported platform -> 204
unknown/unlisted artifact -> 404
immutable artifact GET/HEAD -> correct length, digest, content type, ETag, cache policy
stable DMG GET/HEAD -> beta.6 DMG with no-store
MinIO endpoint/credentials -> absent from all public responses
```

Monitor Cloud server logs, error rate, download byte counts, and desktop updater behavior. If promotion verification fails, restore the exact previous pointer bytes and re-run the matrix.

## Task 17: Tag and publish the GitHub prerelease mirror

### Step 1: Create the release only after promotion passes

Create annotated tag `V0.0.1.beta6` at the merge commit and push it. Create a GitHub prerelease with:

- signed/notarized DMG;
- `checksums.sha256`;
- release commit SHA;
- deployed Cloud image tag/digest;
- `https://coordinar.io/updates/releases/latest/Kordi.dmg`;
- updater endpoint behavior;
- the beta.5 one-time manual install note;
- summarized codesign, Gatekeeper, updater signature, and acceptance evidence.

The GitHub asset is a mirror only; product clients continue to use `coordinar.io`.

### Step 2: Final audit

Confirm GitHub PR merged, tag/release point to the merge commit, production deployment uses that commit, beta pointer references the immutable beta.6 manifest digest, and the working/release worktrees contain no secret material. Close or update the related updater/release issue with the PR and release links.

### Step 3: Preserve operator evidence

Add a concise, secret-free release record to the PR/release notes containing command outcomes, artifact hashes/sizes, endpoint status matrix, deployment image, backup identifier, and rollback pointer digest. Do not commit generated binaries or credentials to Git.
