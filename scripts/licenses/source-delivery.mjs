import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, readdirSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../licenses.mjs';

export const SOURCE_PART_BYTES = 64 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const requiredMaterials = ['bun', 'javascriptcore', 'tinycc', 'application', 'relink-instructions', 'bun-build-inputs', 'bun-rust-dependencies', 'application-dependencies', 'build-patches'];
const safeName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes('..');
function inside(directory, name) {
  if (!safeName(name)) throw new Error('Unsafe source-kit file name.');
  const file = realpathSync(join(directory, name));
  if (!file.startsWith(`${realpathSync(directory)}/`)) throw new Error('Source-kit file escapes its directory.');
  return file;
}
export function packageSourceKit(input, output, identity) {
  if (!versionPattern.test(identity.version) || !/^[a-f0-9]{40}$/.test(identity.releaseCommit) || !digestPattern.test(identity.catalogSha256)) throw new Error('Source kits require a release version, commit and catalog digest.');
  const source = JSON.parse(readFileSync(join(input, 'source-manifest.json'), 'utf8'));
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory() || readdirSync(output).length)) throw new Error('Use a new or empty source-kit output directory.');
  if (source.releaseCommit !== identity.releaseCommit || source.catalogSha256 !== identity.catalogSha256) throw new Error('Prepared source identity does not match this release checkout.');
  mkdirSync(output, { recursive: true });
  const files = [], materials = [];
  for (const [name, entry] of Object.entries(source.sources)) {
    if (!safeName(name) || !digestPattern.test(entry.sha256)) throw new Error('Invalid source material.');
    const file = inside(input, entry.path), descriptor = openSync(file, 'r'), digest = createHash('sha256'), names = [];
    try {
      const buffer = Buffer.alloc(SOURCE_PART_BYTES); let part = 0, length;
      while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        const bytes = buffer.subarray(0, length); digest.update(bytes);
        const fileName = `${name}.part${String(part++).padStart(4, '0')}`;
        writeFileSync(join(output, fileName), bytes); names.push(fileName);
        files.push({ fileName, sha256: sha256(bytes), sizeBytes: length });
      }
    } finally { closeSync(descriptor); }
    if (!names.length || digest.digest('hex') !== entry.sha256) throw new Error(`Source material changed: ${name}`);
    materials.push({ name, archiveName: entry.path, sha256: entry.sha256, files: names });
  }
  const manifest = { schemaVersion: 1, ...identity, pubDate: identity.pubDate ?? new Date().toISOString(), materials, files };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return prepareSourceKit(output, identity);
}
export function prepareSourceKit(directory, expected) {
  const bytes = readFileSync(join(directory, 'manifest.json'));
  if (bytes.length > 1024 * 1024) throw new Error('Source manifest exceeds the metadata limit.');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !versionPattern.test(manifest.version) || !Number.isFinite(Date.parse(manifest.pubDate))) throw new Error('Invalid source-kit identity.');
  for (const key of ['version', 'releaseCommit', 'catalogSha256']) if (manifest[key] !== expected[key]) throw new Error(`Source kit has stale ${key}.`);
  if (!manifest.files?.length || manifest.files.length > 256 || !manifest.materials?.length) throw new Error('Incomplete source manifest.');
  const files = new Map();
  for (const file of manifest.files) {
    if (!safeName(file.fileName) || file.fileName === 'manifest.json' || files.has(file.fileName) || !digestPattern.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > SOURCE_PART_BYTES) throw new Error('Invalid source part.');
    const path = inside(directory, file.fileName);
    if (statSync(path).size !== file.sizeBytes || sha256(readFileSync(path)) !== file.sha256) throw new Error(`Source part is missing or changed: ${file.fileName}`);
    files.set(file.fileName, file);
  }
  const used = new Set(), materialNames = new Set(), archiveNames = new Set();
  for (const material of manifest.materials) {
    if (!safeName(material.name) || materialNames.has(material.name) || !safeName(material.archiveName) || material.archiveName === 'manifest.json' || files.has(material.archiveName) || archiveNames.has(material.archiveName) || !digestPattern.test(material.sha256) || !material.files?.length) throw new Error('Invalid source material record.');
    materialNames.add(material.name); archiveNames.add(material.archiveName);
    const hash = createHash('sha256');
    for (const name of material.files) {
      if (!files.has(name) || used.has(name)) throw new Error('Source part is missing or reused.');
      used.add(name); hash.update(readFileSync(inside(directory, name)));
    }
    if (hash.digest('hex') !== material.sha256) throw new Error(`Reassembled source checksum mismatch: ${material.name}`);
  }
  if (used.size !== files.size || requiredMaterials.some((name) => !materialNames.has(name))) throw new Error('Incomplete source/relink materials.');
  return { directory: resolve(directory), manifest, bytes, sha256: sha256(bytes), url: sourceManifestUrl(manifest.version) };
}
export function sourceManifestUrl(version) {
  if (!versionPattern.test(version)) throw new Error('Invalid source release version.');
  return `https://kordi.ai/updates/releases/${version}/sources/manifest.json`;
}
export async function publishSourceKit(kit, store, publicHttp) {
  // Each bounded part is uploaded and checked separately. The manifest is last;
  // no updater/channel is promoted until anonymous public downloads match.
  const prefix = `desktop/releases/${kit.manifest.version}/sources/`;
  const entries = [...kit.manifest.files, { fileName: 'manifest.json', sha256: kit.sha256, sizeBytes: kit.bytes.length }];
  for (const entry of entries) {
    const bytes = entry.fileName === 'manifest.json' ? kit.bytes : readFileSync(inside(kit.directory, entry.fileName));
    if (sha256(bytes) !== entry.sha256) throw new Error('Source kit changed after local verification.');
    const key = prefix + entry.fileName, existing = await store.getObject(key);
    if (existing != null) {
      const previous = Buffer.isBuffer(existing) ? existing : existing.bytes;
      if (!previous || sha256(previous) !== entry.sha256) throw new Error('Immutable source-kit conflict.');
    } else await store.putObject(key, bytes, { contentType: entry.fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable', immutable: true });
  }
  for (const entry of entries) {
    const url = kit.url.replace(/manifest\.json$/, entry.fileName);
    const response = await publicHttp.get(url);
    if (response.status !== 200 || !response.body || sha256(response.body) !== entry.sha256) throw new Error('Public source download verification failed; release promotion is blocked.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, version, releaseCommit] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: source-delivery.mjs <prepared-sources> <output> <version> <release-commit>');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const kit = packageSourceKit(resolve(input), resolve(output), { version, releaseCommit, catalogSha256: sha256(readFileSync(join(root, 'legal/catalog.json'))) });
  console.log(`Prepared ${kit.manifest.files.length} bounded source parts. Public delivery must be verified before release.`);
}
