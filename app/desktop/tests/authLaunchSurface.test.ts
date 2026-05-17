import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readAuthSource(relativePath: string): string {
  return readFileSync(new URL(`../src/kordi-app/auth/${relativePath}`, import.meta.url), 'utf8');
}

test('provider gate is a focused single-column launch surface', () => {
  const authPage = readAuthSource('AuthPage.tsx');

  assert.match(authPage, /Connect a provider/);
  assert.match(authPage, /Use cloud APIs or local models to start chatting\./);
  assert.doesNotMatch(authPage, /Connect one provider before your first chat\./);
  assert.doesNotMatch(authPage, /grid-cols-\[minmax\(320px,0\.86fr\)_minmax\(460px,1\.08fr\)\]/);
  assert.doesNotMatch(authPage, /Shared sign-in store/);
  assert.match(authPage, /Shared authentication enabled/);
});

test('gate provider picker uses cards without forced uppercase microcopy', () => {
  const providerList = readAuthSource('AuthProviderList.tsx');

  assert.match(providerList, /variant\?: 'settings' \| 'gate'/);
  assert.match(providerList, /grid-cols-\[repeat\(2,minmax\(0,1fr\)\)\]/);
  assert.match(providerList, /ChatGPT & API/);
  assert.match(providerList, /Claude & API/);
  assert.doesNotMatch(providerList, /\buppercase\b/);
  assert.doesNotMatch(providerList, /saved of/);
  assert.doesNotMatch(providerList, /provider\.loginHint/);
});
