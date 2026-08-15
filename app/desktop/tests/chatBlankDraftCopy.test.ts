import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('native blank chat draft does not surface redundant local-draft copy', () => {
  const source = readFileSync(new URL('../src/app/viewModels/nativeChatSelection.ts', import.meta.url), 'utf8');
  const detailPanel = readFileSync(new URL('../src/pages/ChatDetailPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /subtitle:\s*'',/);
  assert.match(source, /messages:\s*\[\],/);
  assert.doesNotMatch(source, /Blank drafts stay local until the first real send\./);
  assert.doesNotMatch(detailPanel, /Blank drafts stay local until the first real send\./);

  const overviewStart = detailPanel.indexOf("if (activeDetailTab === 'info')");
  const overviewEnd = detailPanel.indexOf("if (activeDetailTab === 'context')", overviewStart);
  assert.ok(overviewStart >= 0 && overviewEnd > overviewStart, 'overview panel block should be present');
  const overviewBlock = detailPanel.slice(overviewStart, overviewEnd);
  assert.doesNotMatch(overviewBlock, /activeSessionSubtitle/);
  assert.doesNotMatch(overviewBlock, /<TypeBadge type=\{activeConv\.type\} compact \/>/);
  assert.doesNotMatch(overviewBlock, /Local DB/);
  assert.doesNotMatch(overviewBlock, /canonicalStoragePath/);
});
