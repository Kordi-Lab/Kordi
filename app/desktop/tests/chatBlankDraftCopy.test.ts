import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('native blank chat draft shows the local-draft hint only in the header subtitle', () => {
  const source = readFileSync(new URL('../src/app/useWorkspaceViewModels.ts', import.meta.url), 'utf8');
  const detailPanel = readFileSync(new URL('../src/pages/ChatDetailPanel.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const nativeChatPlaceholder = useMemo(');
  const end = source.indexOf('const activeConv = useMemo', start);
  assert.ok(start >= 0 && end > start, 'native chat placeholder block should be present');

  const block = source.slice(start, end);
  assert.match(block, /subtitle:\s*placeholderText,/);
  assert.match(block, /messages:\s*\[\],/);
  assert.doesNotMatch(block, /role:\s*'system'[\s\S]*text:\s*placeholderText/);
  assert.doesNotMatch(detailPanel, /Blank drafts stay local until the first real send\./);

  const overviewStart = detailPanel.indexOf("if (activeDetailTab === 'info')");
  const overviewEnd = detailPanel.indexOf("if (activeDetailTab === 'context')", overviewStart);
  assert.ok(overviewStart >= 0 && overviewEnd > overviewStart, 'overview panel block should be present');
  const overviewBlock = detailPanel.slice(overviewStart, overviewEnd);
  assert.doesNotMatch(overviewBlock, /activeSessionSubtitle/);
});
