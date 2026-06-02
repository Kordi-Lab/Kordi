#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(scriptDir);
const workspaceRoot = resolve(desktopRoot, '..', '..');

export function defaultDmgBundleDir({ cargoTargetDir = process.env.CARGO_TARGET_DIR ?? '' } = {}) {
  if (cargoTargetDir) {
    const cargoTargetBundleDir = join(cargoTargetDir, 'release', 'bundle', 'dmg');
    if (existsSync(cargoTargetBundleDir)) return cargoTargetBundleDir;
  }
  return join(workspaceRoot, 'target', 'release', 'bundle', 'dmg');
}

export function validateDmgVolumeLayout(volumePath, { appName }) {
  if (!appName || typeof appName !== 'string') {
    throw new Error('appName is required.');
  }

  const appBundlePath = join(volumePath, `${appName}.app`);
  if (!existsSync(appBundlePath) || !lstatSync(appBundlePath).isDirectory()) {
    throw new Error(`Missing ${appName}.app in mounted DMG volume: ${volumePath}`);
  }

  const applicationsPath = join(volumePath, 'Applications');
  if (!existsSync(applicationsPath) || !lstatSync(applicationsPath).isSymbolicLink()) {
    throw new Error(`Missing Applications symlink in mounted DMG volume: ${volumePath}`);
  }

  const target = readlinkSync(applicationsPath);
  if (target !== '/Applications') {
    throw new Error(`Applications symlink must point to /Applications, got ${target}`);
  }
}

export function findNewestDmg(bundleDir = defaultDmgBundleDir(), { appName } = {}) {
  const resolvedDir = resolve(bundleDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`DMG bundle directory does not exist: ${resolvedDir}`);
  }

  const normalizedAppName = appName?.toLowerCase().replaceAll(' ', '-');
  const candidates = readdirSync(resolvedDir)
    .filter((name) => name.endsWith('.dmg'))
    .filter((name) => {
      if (!normalizedAppName) return true;
      const normalized = name.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
      return normalized.includes(normalizedAppName);
    })
    .map((name) => {
      const path = join(resolvedDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No .dmg artifact found in ${resolvedDir}`);
  }

  return candidates[0].path;
}

export function parseHdiutilAttachPlist(xml) {
  const parsed = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: xml,
    encoding: 'utf8',
  });
  if (parsed.status !== 0) {
    throw new Error(`Unable to parse hdiutil plist output: ${parsed.stderr || parsed.stdout}`.trim());
  }
  const payload = JSON.parse(parsed.stdout);
  const entities = Array.isArray(payload['system-entities']) ? payload['system-entities'] : [];
  const mounted = entities.find((entity) => entity['mount-point'] && entity['dev-entry']);
  if (!mounted) {
    throw new Error('hdiutil did not report a mounted volume.');
  }
  return {
    device: mounted['dev-entry'],
    mountPoint: mounted['mount-point'],
  };
}

export function mountDmg(dmgPath) {
  const mounted = spawnSync('hdiutil', ['attach', dmgPath, '-plist', '-nobrowse', '-readonly'], {
    encoding: 'utf8',
  });
  if (mounted.status !== 0) {
    throw new Error(`Unable to mount DMG ${dmgPath}: ${mounted.stderr || mounted.stdout}`.trim());
  }
  return parseHdiutilAttachPlist(mounted.stdout);
}

export function detachDmg(device) {
  const detached = spawnSync('hdiutil', ['detach', device], { encoding: 'utf8' });
  if (detached.status !== 0) {
    throw new Error(`Unable to detach DMG device ${device}: ${detached.stderr || detached.stdout}`.trim());
  }
}

function readArgValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseCliArgs(args) {
  return {
    appName: readArgValue(args, '--app-name', 'Kordi'),
    bundleDir: readArgValue(args, '--bundle-dir', defaultDmgBundleDir()),
    dmgPath: readArgValue(args, '--dmg', ''),
  };
}

export function verifyDmgArtifact({ dmgPath, bundleDir, appName }) {
  const artifact = dmgPath ? resolve(dmgPath) : findNewestDmg(bundleDir, { appName });
  const mounted = mountDmg(artifact);
  try {
    validateDmgVolumeLayout(mounted.mountPoint, { appName });
  } finally {
    detachDmg(mounted.device);
  }
  return artifact;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const artifact = verifyDmgArtifact(options);
  console.log(`[kordi] Verified macOS DMG installer: ${artifact}`);
  console.log(`[kordi] DMG contains ${options.appName}.app and an /Applications drag target.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[kordi] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
