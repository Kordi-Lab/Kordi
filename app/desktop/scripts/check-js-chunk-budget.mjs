#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_JS_CHUNK_BYTES = Number.parseInt(process.env.KORDI_MAX_JS_CHUNK_BYTES ?? '', 10) || 700_000;
const MAX_DESKTOP_DIST_BYTES = Number.parseInt(process.env.KORDI_MAX_DESKTOP_DIST_BYTES ?? '', 10) || 5_000_000;
// Offline picker artwork replaces hundreds of runtime image requests. Give
// these four known atlases a separate cap without relaxing the app/code budget.
const MAX_NOTO_THUMBNAIL_BYTES = 2_600_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'dist', 'assets');

function formatKb(bytes) {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}

async function collectJsChunks(directory) {
  const entries = await readdir(directory);
  const chunks = await Promise.all(entries
    .filter((entry) => entry.endsWith('.js'))
    .map(async (entry) => {
      const filePath = path.join(directory, entry);
      const metadata = await stat(filePath);
      return { name: entry, bytes: metadata.size };
    }));

  return chunks.sort((left, right) => right.bytes - left.bytes);
}

async function directoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? directoryBytes(filePath) : (await stat(filePath)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

try {
  const chunks = await collectJsChunks(assetsDir);
  if (chunks.length === 0) {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }

  const oversizedChunks = chunks.filter((chunk) => chunk.bytes > MAX_JS_CHUNK_BYTES);
  if (oversizedChunks.length > 0) {
    console.error(`JavaScript chunk budget exceeded. Maximum allowed chunk size is ${formatKb(MAX_JS_CHUNK_BYTES)}.`);
    for (const chunk of oversizedChunks) {
      console.error(`- ${chunk.name}: ${formatKb(chunk.bytes)}`);
    }
    process.exit(1);
  }

  const largestChunk = chunks[0];
  const distBytes = await directoryBytes(path.dirname(assetsDir));
  const atlasFiles = (await readdir(assetsDir)).filter(name => /^atlas-[0-3]-[\w-]+\.webp$/.test(name));
  const atlasSizes = await Promise.all(atlasFiles.map(async name => (await stat(path.join(assetsDir, name))).size));
  const atlasBytes = atlasSizes.reduce((total, size) => total + size, 0);
  if (atlasBytes > MAX_NOTO_THUMBNAIL_BYTES || atlasFiles.length > 4) {
    throw new Error('Bundled Noto thumbnails exceed their separate 2.6 MB budget.');
  }
  if (distBytes - atlasBytes > MAX_DESKTOP_DIST_BYTES) {
    console.error(`Desktop web bundle budget exceeded. Maximum allowed size is ${formatKb(MAX_DESKTOP_DIST_BYTES)}.`);
    console.error(`- dist: ${formatKb(distBytes)}`);
    process.exit(1);
  }
  console.log(`JavaScript chunk budget ok: ${chunks.length} chunks, largest ${largestChunk.name} at ${formatKb(largestChunk.bytes)}.`);
  console.log(`Desktop web bundle budget ok: ${formatKb(distBytes)} total.`);
  if (atlasBytes) console.log(`Bundled Noto thumbnails: ${formatKb(atlasBytes)} of ${formatKb(MAX_NOTO_THUMBNAIL_BYTES)}.`);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }
  throw error;
}
