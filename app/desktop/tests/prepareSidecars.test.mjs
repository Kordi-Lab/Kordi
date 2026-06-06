import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../scripts/prepare-sidecars.mjs', import.meta.url), 'utf8');

test('prepare sidecars resolves Cargo binaries from shared CARGO_TARGET_DIR when set', () => {
  assert.match(source, /process\.env\.CARGO_TARGET_DIR/);
  assert.match(source, /resolve\(process\.env\.CARGO_TARGET_DIR, 'release'/);
});
