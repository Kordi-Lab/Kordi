#!/usr/bin/env node

import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destinationRoot = path.join(repositoryRoot, 'shared', 'blob-emoji')
const sourceRoot = path.resolve(process.argv[2] ?? '')
const archiveSha256 = (process.argv[3] ?? '').trim()

if (!sourceRoot || !/^[a-f0-9]{64}$/.test(archiveSha256)) {
  throw new Error('Usage: node scripts/import-blob-emoji.mjs <archive-directory> <archive-sha256>')
}

const sources = [
  { directory: 'static', animated: false },
  { directory: 'animated', animated: true },
]

const entries = []
for (const source of sources) {
  const directory = path.join(sourceRoot, source.directory)
  const files = (await readdir(directory)).filter((file) => file.endsWith('.webp')).sort()
  for (const file of files) {
    entries.push({
      id: file.slice(0, -5),
      file,
      animated: source.animated,
    })
  }
}

const ids = new Set(entries.map((entry) => entry.id))
if (ids.size !== entries.length) throw new Error('Blob Emoji identifiers must be unique')

const assetRoot = path.join(destinationRoot, 'assets')
await rm(assetRoot, { force: true, recursive: true })
await mkdir(assetRoot, { recursive: true })
for (const source of sources) {
  const directory = path.join(sourceRoot, source.directory)
  for (const entry of entries.filter((item) => item.animated === source.animated)) {
    await copyFile(path.join(directory, entry.file), path.join(assetRoot, entry.file))
  }
}

await copyFile(path.join(sourceRoot, 'LICENSE.txt'), path.join(destinationRoot, 'LICENSE.txt'))
await writeFile(
  path.join(destinationRoot, 'SOURCE.txt'),
  [
    'Blob Emoji catalog',
    '',
    'Official project: https://blobs.gg/',
    'Official download: https://files.lostluma.net/blobs.zip',
    `Pinned archive SHA-256: ${archiveSha256}`,
    'License: Apache License 2.0 (see LICENSE.txt)',
    '',
  ].join('\n'),
)
await writeFile(
  path.join(destinationRoot, 'catalog.json'),
  `${JSON.stringify({
    schema: 1,
    source: 'https://blobs.gg/',
    sourceArchiveSha256: archiveSha256,
    license: 'Apache-2.0',
    emoji: entries,
  }, null, 2)}\n`,
)
await writeFile(
  path.join(destinationRoot, 'ids.txt'),
  `${entries.map((entry) => entry.id).join('\n')}\n`,
)

console.log(`Imported ${entries.length} Blob Emoji assets`) // eslint-disable-line no-console
