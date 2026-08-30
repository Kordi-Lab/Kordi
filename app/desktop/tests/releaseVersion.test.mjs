import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const releaseName = 'V0.0.1.beta18';
const appVersion = '0.0.1-beta.18';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('desktop release metadata is set for V0.0.1.beta18', () => {
  const pkg = readJson('../package.json');
  const packageLock = readJson('../package-lock.json');
  const tauri = readJson('../src-tauri/tauri.conf.json');
  const cloudTauri = readJson('../src-tauri/tauri.cloud.conf.json');
  const cargoToml = readText('../src-tauri/Cargo.toml');
  const cargoLock = readText('../src-tauri/Cargo.lock');
  const workspaceCargoLock = readText('../../../Cargo.lock');
  const iosProject = readText('../../ios/project.yml');
  const changelog = readText('../../../CHANGELOG.md');
  const escapedVersion = escapeRegExp(appVersion);
  const escapedReleaseName = escapeRegExp(releaseName);
  const releaseEntryMatch = changelog.match(new RegExp(
    `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`,
    'm',
  ));

  assert.equal(releaseName, 'V0.0.1.beta18');
  assert.equal(pkg.version, appVersion);
  assert.equal(packageLock.version, appVersion);
  assert.equal(packageLock.packages[''].version, appVersion);
  assert.equal(tauri.version, appVersion);
  assert.equal(tauri.productName, 'Kordi');
  assert.equal(tauri.bundle.macOS.minimumSystemVersion, '12.0');
  assert.equal(cloudTauri.productName, 'Kordi');
  assert.match(cargoToml, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.18"/);
  assert.match(cargoLock, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.18"/);
  assert.match(workspaceCargoLock, /name = "kordi-desktop"\nversion = "0\.0\.1-beta\.18"/);
  assert.match(iosProject, /deploymentTarget:\n    iOS: "17\.0"/);
  assert.match(iosProject, /IPHONEOS_DEPLOYMENT_TARGET: 17\.0/);
  assert.ok(releaseEntryMatch, `CHANGELOG.md must contain a dated ${appVersion} entry`);
  assert.match(
    releaseEntryMatch[1],
    /^### (?:Added|Changed|Fixed)$/m,
    `CHANGELOG.md ${appVersion} must classify user-facing changes`,
  );
  assert.match(
    releaseEntryMatch[1],
    /^- /m,
    `CHANGELOG.md ${appVersion} must contain at least one user-facing change`,
  );
  assert.match(
    changelog,
    new RegExp(`^\\[${escapedVersion}\\]: .*${escapedReleaseName}$`, 'm'),
    `CHANGELOG.md must link ${appVersion} to ${releaseName}`,
  );
});
