# V0.0.1.beta2 macOS DMG Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the Cloud desktop release named `V0.0.1.beta2` and make the release command produce a verified macOS `.dmg` installer that can be dragged into `/Applications`.

**Architecture:** Keep release metadata in the desktop package/Tauri config, add small Node verification scripts beside existing desktop release scripts, and expose one explicit Cloud DMG build command. The DMG verifier mounts the generated image read-only and checks for the app bundle plus an `/Applications` symlink before we call the artifact installable.

**Tech Stack:** Tauri 2, macOS `hdiutil`, Node `node:test`, pnpm scripts, Rust/Cargo metadata.

---

### Task 1: Release version metadata

**Files:**
- Modify: `app/desktop/package.json`
- Modify: `app/desktop/package-lock.json`
- Modify: `app/desktop/src-tauri/tauri.conf.json`
- Modify: `app/desktop/src-tauri/Cargo.toml`
- Modify: `app/desktop/src-tauri/Cargo.lock`
- Test: `app/desktop/tests/releaseVersion.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `app/desktop/tests/releaseVersion.test.mjs` that reads the desktop package, Tauri config, Rust manifest, and Cargo lock. Assert:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const releaseName = 'V0.0.1.beta2';
const appVersion = '0.0.1-beta.2';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('desktop release metadata is set for V0.0.1.beta2', () => {
  const pkg = readJson('../package.json');
  const tauri = readJson('../src-tauri/tauri.conf.json');
  const cargoToml = readText('../src-tauri/Cargo.toml');
  const cargoLock = readText('../src-tauri/Cargo.lock');

  assert.equal(pkg.version, appVersion);
  assert.equal(tauri.version, appVersion);
  assert.match(cargoToml, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.2"/);
  assert.match(cargoLock, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.2"/);
  assert.equal(releaseName, 'V0.0.1.beta2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs`

Expected: FAIL because package/Tauri/Cargo metadata still says `0.0.0` or `0.1.0`.

- [ ] **Step 3: Update release metadata**

Set app version to `0.0.1-beta.2` in `app/desktop/package.json`, `app/desktop/package-lock.json`, `app/desktop/src-tauri/tauri.conf.json`, and `app/desktop/src-tauri/Cargo.toml`. Run `cargo check -p kordi-desktop --no-default-features` or `cargo metadata --format-version 1` to refresh Cargo lock if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir app/desktop exec node --test tests/releaseVersion.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/package.json app/desktop/package-lock.json app/desktop/src-tauri/tauri.conf.json app/desktop/src-tauri/Cargo.toml app/desktop/src-tauri/Cargo.lock app/desktop/tests/releaseVersion.test.mjs
git commit -m "Set beta2 release metadata"
```

### Task 2: Explicit Cloud DMG release command and verifier

**Files:**
- Create: `app/desktop/scripts/assert-macos-dmg-release.mjs`
- Modify: `app/desktop/package.json`
- Test: `app/desktop/tests/macosDmgRelease.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/macosDmgRelease.test.mjs` that imports helpers from `../scripts/assert-macos-dmg-release.mjs`. Test three behaviors:

1. `validateDmgVolumeLayout(tempVolume, { appName: 'Kordi Cloud' })` passes when a temp directory contains `Kordi Cloud.app` and an `Applications` symlink to `/Applications`.
2. It throws when the app bundle is missing.
3. It throws when the Applications link is missing or points elsewhere.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir app/desktop exec node --test tests/macosDmgRelease.test.mjs`

Expected: FAIL because the verifier script does not exist.

- [ ] **Step 3: Implement verifier**

Implement `assert-macos-dmg-release.mjs` with exported helpers:

- `validateDmgVolumeLayout(volumePath, { appName })`
- `findNewestDmg(bundleDir, { appName })`
- `mountDmg(dmgPath)` using `hdiutil attach -plist -nobrowse -readonly`
- `detachDmg(device)` using `hdiutil detach`
- CLI default app name `Kordi Cloud` and bundle dir `app/desktop/src-tauri/target/release/bundle/dmg`

The CLI must fail if no DMG exists, if the mounted volume does not contain `Kordi Cloud.app`, or if the mounted volume does not include an `Applications` symlink pointing to `/Applications`.

- [ ] **Step 4: Add release scripts**

Add to `app/desktop/package.json`:

```json
"release:verify-cloud-dmg": "node scripts/assert-macos-dmg-release.mjs --app-name 'Kordi Cloud'",
"tauri:build:cloud:dmg": "pnpm release:secret-guard && VITE_KORDI_EDITION=cloud KORDI_EDITION=cloud pnpm tauri:prepare-sidecars && VITE_KORDI_EDITION=cloud KORDI_EDITION=cloud tauri build --config src-tauri/tauri.cloud.conf.json --bundles dmg && pnpm release:verify-cloud-dmg"
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
pnpm --dir app/desktop exec node --test tests/macosDmgRelease.test.mjs tests/releaseVersion.test.mjs
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/package.json app/desktop/scripts/assert-macos-dmg-release.mjs app/desktop/tests/macosDmgRelease.test.mjs
git commit -m "Verify Cloud DMG release artifact"
```

### Task 3: Build and inspect the release artifact

**Files:**
- No code changes expected unless the build/verification exposes a real packaging issue.

- [ ] **Step 1: Run release guards**

Run: `pnpm --dir app/desktop release:secret-guard`

Expected: PASS with no local auth/session secrets under `app/desktop`.

- [ ] **Step 2: Build Cloud DMG**

Run: `pnpm --dir app/desktop tauri:build:cloud:dmg`

Expected: exit 0 and a `.dmg` under `app/desktop/src-tauri/target/release/bundle/dmg/`.

- [ ] **Step 3: Verify artifact manually**

Run:

```bash
ls -lh app/desktop/src-tauri/target/release/bundle/dmg/*.dmg
hdiutil imageinfo app/desktop/src-tauri/target/release/bundle/dmg/*.dmg | head -40
```

Expected: DMG exists and `release:verify-cloud-dmg` has already mounted it and confirmed `Kordi Cloud.app` plus `/Applications` link.

- [ ] **Step 4: Commit docs only if needed**

If release instructions need updating, edit `docs/release.md` to mention `pnpm --dir app/desktop tauri:build:cloud:dmg`, then commit.
