import { verifyRuntimeBundleEvidence } from './bundle-evidence.mjs';
import { verifyRelinkEvidence } from './relink-evidence.mjs';
import { prepareSourceKit } from './source-delivery.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, distributionFiles, verifyDistribution } from '../licenses.mjs';

// This checks evidence completeness and byte identity, not a legal conclusion.
export function verifyReleaseLicenseEvidence(appBundle, evidenceFile, repoRoot, delivery) {
  verifyDistribution(join(appBundle, 'Contents/Resources/licenses'), distributionFiles(repoRoot));
  if (!evidenceFile || !existsSync(evidenceFile)) throw new Error('Release license evidence is required: record native dependencies and include the LGPL source/relink kit before publication. See docs/license-compliance.md.');
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  const catalogHash = sha256(readFileSync(join(repoRoot, 'legal/catalog.json')));
  if (evidence.schemaVersion !== 1 || evidence.catalogSha256 !== catalogHash || evidence.reviewStatus !== 'complete') throw new Error('Release license evidence is incomplete or refers to an older catalog.');
  const requiredReviews = ['bun-javascriptcore', 'bun-tinycc', 'omp-native-addon', 'optional-libvips'];
  for (const name of requiredReviews) {
    if (!evidence.reviews?.[name]?.trim()) throw new Error(`Missing native license review: ${name}`);
  }
  if (!Object.keys(evidence.artifacts ?? {}).some((name) => /^Contents\/MacOS\/kordi-omp$/.test(name))
      || !Object.keys(evidence.artifacts ?? {}).some((name) => /^Contents\/MacOS\/pi_natives\.darwin-(arm64|x64)\.node$/.test(name))) throw new Error('Bind license evidence to the compiled OMP worker and native addon.');
  const sourcePins = JSON.parse(readFileSync(join(repoRoot, 'legal/runtime-sources.json'), 'utf8'));
  let sourceKit;
  if (delivery) {
    verifyRelinkEvidence(repoRoot);
    verifyRuntimeBundleEvidence(repoRoot, join(appBundle, 'Contents/MacOS/pi_natives.darwin-arm64.node'));
    if (!delivery.directory) throw new Error('Set KORDI_LICENSE_SOURCE_KIT to the prepared, version-bound source download kit.');
    sourceKit = delivery.verifiedKit ?? prepareSourceKit(delivery.directory, { version: delivery.version, releaseCommit: delivery.releaseCommit, catalogSha256: catalogHash });
    if (evidence.sourceManifestSha256 !== sourceKit.sha256) throw new Error('Release evidence does not match the source download manifest.');
    for (const name of ['bun', 'javascriptcore', 'tinycc']) {
      if (sourceKit.manifest.materials.find((item) => item.name === name)?.sha256 !== sourcePins.sources[name].sha256) throw new Error(`Source kit does not match pinned ${name}.`);
    }
  } else {
    const requiredSources = ['bun', 'javascriptcore', 'tinycc', 'application', 'relink-instructions'];
    for (const name of requiredSources) {
      const entry = evidence.sources?.[name];
      if (!entry?.path?.startsWith('Contents/Resources/licenses/sources/')) throw new Error(`Include ${name} source/relink material inside the distributed app.`);
      if (sourcePins.sources[name] && entry.sha256 !== sourcePins.sources[name].sha256) throw new Error(`Source evidence does not match the pinned ${name} archive.`);
      verifyFile(appBundle, entry.path, entry.sha256);
    }
  }
  for (const [name, digest] of Object.entries(evidence.artifacts)) verifyFile(appBundle, name, digest);
  return sourceKit;
}

function verifyFile(root, name, expected) {
  if (typeof name !== 'string' || name.split('/').some((part) => !part || part === '.' || part === '..') || name.includes('\\') || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Unsafe path or invalid hash in license evidence.');
  const path = resolve(root, name);
  if (!path.startsWith(`${resolve(root)}/`)) throw new Error('License evidence must refer to files inside the app.');
  if (!realpathSync(path).startsWith(`${realpathSync(root)}/`)) throw new Error('License evidence cannot escape through a symlink.');
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
  } finally { closeSync(descriptor); }
  if (!statSync(path).size || hash.digest('hex') !== expected) throw new Error(`License evidence does not match the delivered file: ${name}`);
}
