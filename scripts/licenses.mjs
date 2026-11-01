#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const read = (path) => readFileSync(path, 'utf8');
const assetFiles = ['legal/native/WebRTC-LICENSE', 'legal/native/WebRTC-THIRD-PARTY-NOTICES.txt',
  'legal/native/UniFFI-THIRD-PARTY-NOTICES.txt', 'legal/native/Bun-THIRD-PARTY-NOTICES.txt',
  'legal/native/webrtc-dependencies.json', 'legal/native/uniffi-dependencies.json', 'legal/native/bun-dependencies.json', 'shared/noto-emoji/NOTICE.txt', 'shared/blob-emoji/LICENSE.txt',
  'app/desktop/public/noto-thumbnails.LICENSE.txt', 'app/desktop/public/noto-static-symbols.APACHE-LICENSE.txt',
  'app/desktop/public/blob-wave.LICENSE.txt', 'app/desktop/public/provider-logos/LICENSES.md',
  'app/desktop/public/provider-logos/LOBE-ICONS-LICENSE', 'shared/digest/ICAL-LICENSE',
  'shared/digest/README.md', 'bridges/cloud-server/src/avatars/boring-avatars-LICENSE'];

export function validateCatalog(catalog, directory = root) {
  if (catalog.schemaVersion !== 1 || !catalog.packages?.length || !Object.keys(catalog.inputs ?? {}).length) throw new Error('Empty or unsupported license catalog.');
  for (const [path, expected] of Object.entries(catalog.inputs)) {
    if (sha256(readFileSync(join(directory, path))) !== expected) throw new Error(`License review is stale: ${path}. Run pnpm licenses:refresh and review the result.`);
  }
  for (const [hash, text] of Object.entries(catalog.documents)) {
    if (sha256(text) !== hash) throw new Error(`Corrupt upstream notice: ${hash}`);
  }
  for (const pkg of catalog.packages) {
    if (!pkg.name || !pkg.version || !pkg.license || !pkg.source?.startsWith('https://')) throw new Error('Incomplete license identity or source URL.');
    for (const notice of pkg.notices) {
      if (!catalog.documents[notice.sha256]?.trim()) throw new Error(`Missing notice for ${pkg.name}@${pkg.version}`);
    }
  }
}

const style = 'body{font:16px/1.6 system-ui,sans-serif;max-width:80ch;margin:32px auto;padding:0 20px;color-scheme:light dark}a{color:LinkText}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}summary{cursor:pointer;padding:10px 0}details{border-bottom:1px solid #8885}h1{font-size:26px}h2{font-size:20px}';
function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${style}</style><body>${body}</body></html>\n`;
}

export function distributionFiles(directory = root) {
  const catalog = JSON.parse(read(join(directory, 'legal/catalog.json')));
  validateCatalog(catalog, directory);
  const files = new Map();
  files.set('LICENSE', read(join(directory, 'LICENSE')));
  files.set('NOTICE', read(join(directory, 'NOTICE')));
  const versionFile = join(directory, 'app/desktop/package.json');
  const version = existsSync(versionFile) ? JSON.parse(read(versionFile)).version : undefined;
  const sourceUrl = version && `https://kordi.ai/updates/releases/${version}/sources/manifest.json`;
  files.set('SOURCES.md', read(join(directory, 'legal/SOURCES.md')) + (sourceUrl ? `\nSource download manifest for this release: ${sourceUrl}\n` : ''));
  const sections = [];
  const originals = new Map(Object.entries(catalog.documents));
  const add = (name, text) => { const hash = sha256(text); originals.set(hash, text); return `<li><a href="#notice-${hash}">${escapeHtml(name)}</a></li>`; };
  const firstParty = ['LICENSE', 'NOTICE', 'SOURCES.md'].map((name) => add(name, files.get(name))).join('');
  const artwork = assetFiles.map((name) => add(name, read(join(directory, name)))).join('');
  const standard = Object.entries(catalog.standardLicenses).map(([id, text]) => add(id, text)).join('');
  for (const pkg of catalog.packages) {
    const links = pkg.notices.map((item) => `<li><a href="#notice-${item.sha256}">${escapeHtml(item.file)}</a></li>`).join('');
    sections.push(`<details><summary>${escapeHtml(pkg.name)} ${escapeHtml(pkg.version)} · ${escapeHtml(pkg.license)}</summary><p>${escapeHtml(pkg.ecosystem)}. ${escapeHtml(pkg.scope ?? '')}</p>${pkg.authors?.length ? `<p>Upstream authors: ${escapeHtml(pkg.authors.join('; '))}</p>` : ''}<a href="${escapeHtml(pkg.source)}" target="_blank" rel="noopener noreferrer">Exact upstream source</a><ul>${links}</ul>${pkg.notices.length ? '' : '<p>The package declares this license in its metadata. See the standard text below and the original source for file-level notices.</p>'}</details>`);
  }
  const noticeSections = [...originals].map(([hash, text]) => `<details id="notice-${hash}"><summary>Original notice ${hash.slice(0, 12)}</summary><a href="#components">Back to components</a><pre>${escapeHtml(text)}</pre></details>`).join('\n');
  files.set('THIRD-PARTY-NOTICES.txt', catalog.packages.map((pkg) => `${pkg.name} ${pkg.version} | ${pkg.license} | ${pkg.source}${pkg.authors?.length ? ` | Authors: ${pkg.authors.join('; ')}` : ''}`).join('\n') + '\n\n' + [...originals].map(([hash, text]) => `Notice ${hash}\n${'='.repeat(72)}\n${text}`).join('\n\n'));
  files.set('index.html', page('Open-source licenses', `<h1 id="components">Open-source licenses</h1><p>Kordi's own code is MIT licensed. Third-party components and artwork retain their original terms.</p><p>This inventory also discloses build tools and optional platforms; their licenses do not relicense Kordi as a whole.</p><h2>Kordi and source access</h2>${sourceUrl ? `<p><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Download this release’s source and rebuild kit</a></p>` : ''}<ul>${firstParty}</ul><h2>Artwork and vendored code</h2><ul>${artwork}</ul><h2>Dependencies</h2>${sections.join('\n')}<h2>Standard license texts</h2><ul>${standard}</ul><h2>Original notice texts</h2>${noticeSections}`));
  files.set('inventory.json', `${JSON.stringify({ schemaVersion: 1, scope: catalog.scope, packages: catalog.packages }, null, 2)}\n`);
  files.set('manifest.json', `${JSON.stringify({ schemaVersion: 1, catalogSha256: sha256(readFileSync(join(directory, 'legal/catalog.json'))), inputs: catalog.inputs, files: Object.fromEntries([...files].map(([name, value]) => [name, sha256(value)])) }, null, 2)}\n`);
  return files;
}

export function verifyDistribution(output, expectedFiles) {
  for (const [name, expected] of expectedFiles) {
    if (!existsSync(join(output, name)) || sha256(readFileSync(join(output, name))) !== sha256(expected)) throw new Error(`Missing or stale distributed license file: ${name}`);
  }
}

export function stageDistribution(output, directory = root) {
  const files = distributionFiles(directory);
  const previousManifest = join(output, 'manifest.json');
  if (existsSync(previousManifest)) {
    const previous = JSON.parse(read(previousManifest));
    for (const [name, hash] of Object.entries(previous.files ?? {})) {
      // Remove only obsolete, unmodified notice files created by this generator.
      if (/^texts\/[a-f0-9]{64}\.(html|txt)$/.test(name) && !files.has(name)
          && existsSync(join(output, name)) && sha256(readFileSync(join(output, name))) === hash) unlinkSync(join(output, name));
    }
  }
  for (const [name, data] of files) {
    mkdirSync(dirname(join(output, name)), { recursive: true });
    writeFileSync(join(output, name), data);
  }
  verifyDistribution(output, files);
  return files.size;
}

function main() {
  const [action = 'check', output] = process.argv.slice(2);
  if (!['check', 'stage', 'verify'].includes(action)) throw new Error('Usage: licenses.mjs check | stage <directory> | verify <directory>');
  if (action !== 'check' && !output) throw new Error('An explicit license output directory is required.');
  const files = distributionFiles();
  if (action === 'stage') stageDistribution(resolve(output));
  else verifyDistribution(action === 'check' ? join(root, 'legal/distribution') : resolve(output), files);
  console.log(`License ${action} passed (${files.size} files).`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
