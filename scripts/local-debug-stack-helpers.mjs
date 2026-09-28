// Shared helpers for the local debug stack script tests.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Reads a repository file by its path relative to the repository root. */
export function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

/** Writes an executable fake command for tests that put a stub directory first on PATH. */
export function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
