#!/usr/bin/env node
// Fails release builds if local development auth stores or cloud session
// secrets are present under app/desktop. The guard prints paths only, never
// file contents.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(__dirname);

const SKIPPED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'target',
]);

function normalizeRelativePath(path) {
  return path.split(sep).join('/');
}

function isSecretFileName(name) {
  return name === 'auth.json'
    || name.startsWith('auth.json.backup-')
    || name.endsWith('.secret');
}

export function findReleaseSecretFiles(root = appDir) {
  if (!existsSync(root)) {
    return [];
  }

  const findings = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = `${dir}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name)) {
          visit(fullPath);
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (!isSecretFileName(entry.name)) {
        continue;
      }
      findings.push({
        path: fullPath,
        relativePath: normalizeRelativePath(relative(root, fullPath)),
        sizeBytes: statSync(fullPath).size,
      });
    }
  };

  visit(root);
  return findings.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function main() {
  const root = process.argv[2] ?? appDir;
  const findings = findReleaseSecretFiles(root);
  if (findings.length === 0) {
    console.log('[kordi] Release secret guard passed: no local auth stores or cloud secrets found.');
    return;
  }

  console.error('[kordi] Refusing to build release while local auth stores/cloud secrets exist under app/desktop.');
  console.error('[kordi] Move or delete these local-only files before packaging. Paths only; contents were not read:');
  for (const finding of findings) {
    console.error(`  - ${finding.relativePath} (${finding.sizeBytes} bytes)`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
