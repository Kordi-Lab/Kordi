import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { findReleaseSecretFiles } from '../scripts/assert-no-release-secrets.mjs';

test('release secret guard reports local auth stores and cloud secret files without reading values', () => {
  const root = mkdtempSync(join(tmpdir(), 'kordi-release-secret-guard-'));
  try {
    mkdirSync(join(root, '.multi-instance-data', 'user1', 'kordi', 'cloud-secrets'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.multi-instance-data', 'user1', 'kordi', 'auth.json'), '{"secret":"do-not-print"}');
    writeFileSync(join(root, '.multi-instance-data', 'user1', 'kordi', 'cloud-secrets', 'abc.secret'), 'do-not-print');
    writeFileSync(join(root, 'src', 'normal.ts'), 'export const value = "auth.json mentioned in source is not a file";');

    const findings = findReleaseSecretFiles(root).map((finding) => finding.relativePath).sort();

    assert.deepEqual(findings, [
      '.multi-instance-data/user1/kordi/auth.json',
      '.multi-instance-data/user1/kordi/cloud-secrets/abc.secret',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
