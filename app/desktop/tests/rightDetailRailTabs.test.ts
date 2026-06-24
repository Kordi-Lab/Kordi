import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('right detail rail tabs use evenly distributed compact segments', () => {
  const rail = readFileSync(new URL('../src/pages/RightDetailRail.tsx', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  const tabListStart = rail.indexOf('app-detail-tab-list');
  const tabListEnd = rail.indexOf('<div className="min-h-0 min-w-0 flex-1', tabListStart);
  assert.ok(tabListStart >= 0 && tabListEnd > tabListStart, 'detail tab list block should be present');
  const tabListBlock = rail.slice(tabListStart, tabListEnd);

  assert.match(tabListBlock, /app-detail-tab-list/);
  assert.match(tabListBlock, /app-detail-tab-button/);
  assert.doesNotMatch(tabListBlock, /grid-cols-\[repeat\(3,minmax\(0,1fr\)\)\]/);
  assert.doesNotMatch(tabListBlock, /flex-1/);
  assert.match(tabListBlock, /w-full/);

  const tabCssStart = shell.indexOf('.app-right-detail-rail .app-inspector-tabs');
  const tabCssEnd = shell.indexOf('.app-right-detail-rail .app-inspector-tab-active', tabCssStart);
  assert.ok(tabCssStart >= 0 && tabCssEnd > tabCssStart, 'right rail tab CSS block should be present');
  const tabCssBlock = shell.slice(tabCssStart, tabCssEnd);
  assert.match(tabCssBlock, /display:\s*grid/);
  assert.match(tabCssBlock, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(tabCssBlock, /max-width:\s*24rem/);
  assert.match(tabCssBlock, /margin-inline:\s*auto/);
  assert.match(tabCssBlock, /justify-content:\s*center/);
});
