import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function assertVersionParity(repoRoot, version, updaterPublicKey) {
  const desktopRoot = join(repoRoot, 'app', 'desktop');
  const [pkg, packageLock, tauri, cloudTauri, cargoToml, cargoLock, workspaceLock, releaseTest] = await Promise.all([
    readFile(join(desktopRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'tauri.cloud.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(desktopRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(join(desktopRoot, 'src-tauri', 'Cargo.lock'), 'utf8'),
    readFile(join(repoRoot, 'Cargo.lock'), 'utf8'),
    readFile(join(desktopRoot, 'tests', 'releaseVersion.test.mjs'), 'utf8'),
  ]);
  const escaped = escapeRegex(version);
  const releaseName = `V${version.replace(/-beta\./, '.beta')}`;
  const cargoPattern = new RegExp(`name = "kordi-desktop"\\nversion = "${escaped}"`);
  const checks = [
    [pkg.version === version, 'desktop package'],
    [packageLock.version === version && packageLock.packages?.['']?.version === version, 'desktop package lock'],
    [tauri.version === version, 'Tauri configuration'],
    [tauri.plugins?.updater?.pubkey === updaterPublicKey, 'Tauri updater public key'],
    [JSON.stringify(tauri.plugins?.updater?.endpoints) === JSON.stringify([
      'https://kordi.ai/updates/desktop/{{target}}/{{arch}}/{{current_version}}',
    ]), 'Tauri updater endpoint'],
    [cloudTauri.version === undefined || cloudTauri.version === version, 'Cloud Tauri configuration'],
    [cargoPattern.test(cargoToml), 'desktop Cargo manifest'],
    [cargoPattern.test(cargoLock), 'desktop Cargo lock'],
    [cargoPattern.test(workspaceLock), 'workspace Cargo lock'],
    [releaseTest.includes(`const releaseName = '${releaseName}'`) && releaseTest.includes(`const appVersion = '${version}'`), 'release contract test'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Error(`${failed[1]} does not match release version ${version}`);
}
