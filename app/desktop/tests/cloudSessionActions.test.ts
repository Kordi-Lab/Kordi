import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldUseCloudSessionAction } from '../src/app/useKordiAppModelHelpers';

test('shouldUseCloudSessionAction routes cloud session ids but leaves local runtime ids alone', () => {
  assert.equal(shouldUseCloudSessionAction('cloud', 'session:direct-person:acct_a:acct_b'), true);
  assert.equal(shouldUseCloudSessionAction('cloud', 'session:group:abc'), true);
  assert.equal(shouldUseCloudSessionAction('cloud', 'bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldUseCloudSessionAction('local', 'session:group:abc'), false);
  assert.equal(shouldUseCloudSessionAction('cloud', '550e8400-e29b-41d4-a716-446655440000'), false);
});

test('cloud remove archives matching local canonical sessions after server removal succeeds', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  const cloudActionBranches = source.match(/if \(shouldUseCloudSessionAction\(kordiEdition, trimmedSessionId\)\) \{[\s\S]*?return;\n      \}/g) ?? [];
  const cloudDeleteBranch = cloudActionBranches.find((branch) => branch.includes('deleteCloudSession')) ?? '';
  assert.match(cloudDeleteBranch, /await deleteCloudSession\(trimmedSessionId\);[\s\S]*archiveDesktopChatSession\(trimmedSessionId, desktopChatState\?\.activeSessionId\)/);
});

test('cloud removed sessions are included in workspace hidden ids for restored canonical self-agent forks', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  assert.match(source, /const combinedHiddenSessionIds = useMemo\([\s\S]*cloudDeletedSessionIds/);
  assert.match(source, /hiddenSessionIds: combinedHiddenSessionIds,/);
});
