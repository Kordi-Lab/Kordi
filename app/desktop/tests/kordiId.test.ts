import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatKordiHandle, normalizeKordiId, sameKordiId } from '../src/features/cloud/kordiId';

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

test('accepts public handles with case preserved', () => {
  assert.equal(normalizeKordiId('@shuyhere'), 'shuyhere');
  assert.equal(normalizeKordiId('ShuYhere'), 'ShuYhere');
  assert.equal(normalizeKordiId('  abc  '), 'abc');
  assert.equal(normalizeKordiId('a2345'), 'a2345');
  assert.equal(normalizeKordiId('a'.repeat(30)), 'a'.repeat(30));
  assert.equal(formatKordiHandle('ShuYhere'), '@ShuYhere');
});

test('rejects invalid handles', () => {
  assert.equal(normalizeKordiId('shu_yhere'), null);
  assert.equal(normalizeKordiId('ab'), null);
  assert.equal(normalizeKordiId('a b'), null);
  assert.equal(normalizeKordiId('a'.repeat(31)), null);
  assert.equal(normalizeKordiId('@'), null);
  assert.equal(normalizeKordiId('@@shuyhere'), null);
  assert.equal(normalizeKordiId('12'), null);
});

test('a nine-digit value is always a number, never a handle', () => {
  assert.equal(normalizeKordiId('123456789012'), null);
  assert.equal(normalizeKordiId('982731906'), '982731906');
});

test('compares ids case-insensitively', () => {
  assert.equal(sameKordiId('@ShuYhere', 'shuyhere'), true);
  assert.equal(sameKordiId('482 731 906', '482731906'), true);
  assert.equal(sameKordiId('shuyhere', null), false);
});
