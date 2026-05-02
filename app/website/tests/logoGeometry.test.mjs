import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('three-dot logo uses equal-size circles in symmetric triangular positions', () => {
  assert.match(css, /\.paint-mark::before,\s*\.paint-mark::after,\s*\.paint-mark span \{[\s\S]*?width: 59\.5238%;[\s\S]*?height: 62\.9326%;/);
  assert.match(css, /\.paint-mark::before \{[\s\S]*?left: 20\.2381%;[\s\S]*?top: 0;/);
  assert.match(css, /\.paint-mark span \{[\s\S]*?left: 0;[\s\S]*?top: 37\.0673%;/);
  assert.match(css, /\.paint-mark::after \{[\s\S]*?left: 40\.4762%;[\s\S]*?top: 37\.0673%;/);
});

test('logo has no enclosing square asset or background image', () => {
  const markBlock = css.match(/\.paint-mark \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.doesNotMatch(markBlock, /background:/);
  assert.doesNotMatch(css, /logo\.png|favicon\.svg|<img/i);
});
