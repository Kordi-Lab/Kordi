import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatKordiHandle, normalizeKordiId } from '../src/features/cloud/kordiId';

test('normalizes supported Kordi ID input without exposing canonical account ids', () => {
  assert.equal(normalizeKordiId('@482731906'), '482731906');
  assert.equal(normalizeKordiId('482 731 906'), '482731906');
  assert.equal(normalizeKordiId('482-731-906'), '482731906');
  assert.equal(normalizeKordiId('acct_50a66b83799045'), null);
  assert.equal(normalizeKordiId('48273190'), null);
  assert.equal(normalizeKordiId('082731906'), null);
});

test('formats a Kordi ID as the approved compact handle', () => {
  assert.equal(formatKordiHandle('482 731 906'), '@482731906');
  assert.equal(formatKordiHandle(null), null);
});
