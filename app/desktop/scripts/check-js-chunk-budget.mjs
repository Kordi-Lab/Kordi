#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_JS_CHUNK_BYTES = Number.parseInt(process.env.KORDI_MAX_JS_CHUNK_BYTES ?? '', 10) || 700_000;

// Per-chunk overrides for chunks that are loaded asynchronously and only when
// the user opens a specific feature. The default budget still applies to every
// chunk that ships in the initial download.
const PER_CHUNK_BUDGET_OVERRIDES = [
  // tldraw is ~1.4 MB by design; the canvas-vendor chunk is loaded lazily on
  // the first canvas-scratch open (see app/desktop/src/features/scratch).
  { prefix: 'canvas-vendor', limit: 1_500_000 },
  // pdfmake (with embedded vfs fonts) + docx is ~2.2 MB; the download-vendor
  // chunk is loaded lazily on the first doc-scratch download.
  { prefix: 'download-vendor', limit: 2_500_000 },
];

function budgetFor(chunkName) {
  for (const override of PER_CHUNK_BUDGET_OVERRIDES) {
    if (chunkName.startsWith(override.prefix)) return override.limit;
  }
  return MAX_JS_CHUNK_BYTES;
}

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

try {
  const chunks = await collectJsChunks(assetsDir);
  if (chunks.length === 0) {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }

  const oversizedChunks = chunks
    .map((chunk) => ({ ...chunk, limit: budgetFor(chunk.name) }))
    .filter((chunk) => chunk.bytes > chunk.limit);
  if (oversizedChunks.length > 0) {
    console.error(`JavaScript chunk budget exceeded. Default budget is ${formatKb(MAX_JS_CHUNK_BYTES)}.`);
    for (const chunk of oversizedChunks) {
      console.error(`- ${chunk.name}: ${formatKb(chunk.bytes)} (limit ${formatKb(chunk.limit)})`);
    }
    process.exit(1);
  }

  const largestChunk = chunks[0];
  console.log(`JavaScript chunk budget ok: ${chunks.length} chunks, largest ${largestChunk.name} at ${formatKb(largestChunk.bytes)}.`);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }
  throw error;
}
