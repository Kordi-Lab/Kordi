import assert from 'node:assert/strict';
import { test } from 'node:test';

import { documentShareTokenFromUrl } from '../src/features/documents/documentShareToken';

const token = `kordi_ds_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0_-x'}`;

test('share tokens are read from the deep link and kordi.ai links', () => {
  assert.equal(token.length, 'kordi_ds_'.length + 43);
  assert.equal(documentShareTokenFromUrl(`kordi://document/${token}`), token);
  assert.equal(documentShareTokenFromUrl(`https://kordi.ai/d/${token}`), token);
  assert.equal(documentShareTokenFromUrl(`https://www.kordi.ai/d/${token}`), token);
  assert.equal(documentShareTokenFromUrl(`  ${token}  `), token);
});

test('other hosts, paths, schemes, and malformed tokens are rejected', () => {
  assert.equal(documentShareTokenFromUrl(`https://kordi.example/d/${token}`), null);
  assert.equal(documentShareTokenFromUrl(`https://evil.kordi.ai.example/d/${token}`), null);
  assert.equal(documentShareTokenFromUrl(`http://kordi.ai/d/${token}`), null);
  assert.equal(documentShareTokenFromUrl(`https://kordi.ai/g/${token}`), null);
  assert.equal(documentShareTokenFromUrl(`kordi://group-invite/${token}`), null);
  assert.equal(documentShareTokenFromUrl('https://kordi.ai/d/kordi_ds_short'), null);
  assert.equal(documentShareTokenFromUrl(`https://kordi.ai/d/${token}x`), null);
  assert.equal(documentShareTokenFromUrl(`https://kordi.ai/d/${token.replace('kordi_ds_', 'kordi_gi_')}`), null);
  assert.equal(documentShareTokenFromUrl('not a url'), null);
  assert.equal(documentShareTokenFromUrl(null), null);
});
