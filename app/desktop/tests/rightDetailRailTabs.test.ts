import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('right detail rail tabs use content-sized segments without wide blank space', () => {
  const rail = readFileSync(new URL('../src/pages/RightDetailRail.tsx', import.meta.url), 'utf8');

  const tabListStart = rail.indexOf('app-detail-tab-list');
  const tabListEnd = rail.indexOf('<div className="min-h-0 min-w-0 flex-1', tabListStart);
  assert.ok(tabListStart >= 0 && tabListEnd > tabListStart, 'detail tab list block should be present');
  const tabListBlock = rail.slice(tabListStart, tabListEnd);

  assert.match(tabListBlock, /app-detail-tab-list/);
  assert.match(tabListBlock, /app-detail-tab-button/);
  assert.doesNotMatch(tabListBlock, /grid-cols-\[repeat\(3,minmax\(0,1fr\)\)\]/);
  assert.doesNotMatch(tabListBlock, /flex-1/);
  assert.match(tabListBlock, /w-fit/);
  assert.match(tabListBlock, /px-4/);
});
