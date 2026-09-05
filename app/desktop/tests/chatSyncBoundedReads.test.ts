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
  assert.ok(
    repair.indexOf('if (!page.hasMore) break')
      < repair.indexOf('pruneMissingCanonicalCloudMessages(account.accountId)'),
  );
  assert.doesNotMatch(repair, /hydrateChatLocalState|loadChatSyncLocalState|storedSequences|local\.messages/);
});

test('self-agent reconciliation reads only scoped references', () => {
  const sync = source('../src/features/cloud/useCloudSelfAgentForwardSync.ts');
  assert.match(sync, /loadChatSyncConversations\(account\.accountId\)/);
  assert.match(sync, /loadChatSyncMessageRefs\(account\.accountId, relevantConversationIds\)/);
  assert.doesNotMatch(sync, /loadChatSyncLocalState|localChat\?\.messages/);
});

test('native group and self-agent recovery consume bounded message pages', () => {
  const group = source('../src/features/cloud/cloudGroupNativeRecovery.ts');
  assert.match(group, /PAGE_SIZE = 100/);
  assert.match(group, /waitForCompleteChatSyncHistory\(/);
  assert.match(group, /loadChatSyncMessagesPage\(/);
  assert.match(group, /if \(!page\.hasMore\) break/);
  assert.match(group, /next <= afterSequence/);
  assert.doesNotMatch(group, /messages\.push\(\.\.\.page\.messages/);
  assert.ok(
    group.indexOf('conversation.latest_message_sequence - PAGE_SIZE')
      < group.indexOf('for (const history of histories)'),
  );

  const selfAgent = source('../src/features/cloud/useCloudSelfAgentCanonicalSync.ts');
  assert.match(selfAgent, /NATIVE_SELF_AGENT_RECOVERY_PAGE_SIZE = 200/);
  assert.match(selfAgent, /waitForCompleteChatSyncHistory\(/);
  assert.match(selfAgent, /loadChatSyncRecoveryMessageIds\(/);
  assert.match(selfAgent, /loadChatSyncMessagesPage\(/);
  assert.ok(
    selfAgent.indexOf('loadChatSyncRecoveryMessageIds(')
      < selfAgent.indexOf('loadChatSyncMessagesPage('),
  );
  assert.match(selfAgent, /if \(!page\.hasMore\) break/);
  assert.match(selfAgent, /for \(const conversation of conversations\)/);
  assert.doesNotMatch(selfAgent, /Promise\.all\(\[\.\.\.conversations/);
  assert.ok(
    selfAgent.indexOf('- NATIVE_SELF_AGENT_RECOVERY_PAGE_SIZE')
      < selfAgent.indexOf('for (const history of histories)'),
  );
});

test('failed self-agent migrations back off before retrying', () => {
  const selfAgent = source('../src/features/cloud/useCloudSelfAgentForwardSync.ts');
  assert.match(selfAgent, /CLOUD_SELF_AGENT_RECONCILE_RETRY_MS = 30_000/);
  assert.match(selfAgent, /previousFailure\?\.accountId === account\.accountId/);
});
