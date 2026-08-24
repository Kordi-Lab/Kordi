import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('cursor and history repair reads stay bounded as unrelated history grows', () => {
  const sync = source('../src/features/cloud/useCloudMessageSync.ts');
  const repairStart = sync.indexOf('const hydrateMissingChatHistory');
  const repairEnd = sync.indexOf('const runCoordinatedSync', repairStart);
  assert.notEqual(repairStart, -1);
  assert.notEqual(repairEnd, -1);
  const repair = sync.slice(repairStart, repairEnd);

  assert.match(sync, /const local = await loadChatSyncCursor\(account\.accountId\)/);
  assert.match(sync, /local\.changedConversationHeads\.map/);
  assert.match(repair, /loadChatSyncConversations\(account\.accountId\)/);
  assert.match(repair, /loadChatSyncCoverage\(account\.accountId\)/);
  assert.match(repair, /historyChanged \|\|= page\.messages\.length > 0/);
  assert.match(repair, /if \(historyChanged\) await hydrateChatLocalState\(generation\)/);
  assert.doesNotMatch(repair, /loadChatSyncLocalState|storedSequences|local\.messages/);
});

test('self-agent reconciliation reads only scoped references', () => {
  const sync = source('../src/features/cloud/useCloudSelfAgentForwardSync.ts');
  assert.match(sync, /loadChatSyncConversations\(account\.accountId\)/);
  assert.match(sync, /loadChatSyncMessageRefs\(account\.accountId, relevantConversationIds\)/);
  assert.doesNotMatch(sync, /loadChatSyncLocalState|localChat\?\.messages/);
});
