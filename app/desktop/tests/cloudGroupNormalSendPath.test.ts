import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const cloudBridgeSource = () => readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
const cloudGroupOutboxSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupOutbox.ts', import.meta.url), 'utf8');

test('plain cloud group messages send through cloud group transport instead of falling through to unavailable', () => {
  const source = chatMessagesSource();
  const mentionBranch = source.indexOf('if (activeConversationUsesBridgeRouting && shouldRouteMentionThroughCloudGroup({');
  const unavailableBranch = source.indexOf("if (activeConversationUsesBridgeRouting && !localAgentMentioned)", mentionBranch);
  assert.notEqual(mentionBranch, -1, 'expected cloud group mention branch');
  assert.notEqual(unavailableBranch, -1, 'expected unavailable bridge-routing fallback branch');

  const between = source.slice(mentionBranch, unavailableBranch);
  assert.match(
    between,
    /activeGroupSessionIsGroup[\s\S]*cloudGroupTargetIds\.length > 0[\s\S]*kind:\s*'group-message'/,
    'plain cloud group messages with resolved cloud recipients must be sent as group-message controls before unavailable fallback',
  );
});

test('active composer sends prefer Cloud group routing before direct Cloud bridge routing', () => {
  const source = chatMessagesSource();
  const activeStart = source.indexOf('return useCallback(async (draftOverride?');
  assert.notEqual(activeStart, -1, 'expected active composer send handler');
  const activeEnd = source.indexOf('const isTransientDraftConversation = isLocalDraftChatConversationId(activeConvId);', activeStart);
  assert.notEqual(activeEnd, -1, 'expected local-send section after bridge routing');
  const bridgeRoutingSection = source.slice(activeStart, activeEnd);

  const directCloudBranch = bridgeRoutingSection.indexOf('if (activeConversationUsesBridgeRouting && isCloudBridgeConversationId(activeConvId))');
  const mentionGroupBranch = bridgeRoutingSection.indexOf('if (activeConversationUsesBridgeRouting && shouldRouteMentionThroughCloudGroup({');
  const plainGroupSend = bridgeRoutingSection.indexOf("kind: 'group-message'", mentionGroupBranch + 1);

  assert.notEqual(directCloudBranch, -1, 'expected direct Cloud bridge branch');
  assert.notEqual(mentionGroupBranch, -1, 'expected Cloud group mention branch');
  assert.notEqual(plainGroupSend, -1, 'expected Cloud group send before local fallback');
  assert.ok(
    mentionGroupBranch < directCloudBranch && plainGroupSend < directCloudBranch,
    'active composer must route Cloud group sessions before direct Cloud bridge sends; otherwise group messages are stored as plain direct messages',
  );
});

test('cloud group messages stay sending until the persistent recipient outbox reports delivery', () => {
  const source = chatMessagesSource();
  const cloudGroupPreparations = [...source.matchAll(/'cloud-group-ui',\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(cloudGroupPreparations.length >= 3, 'expected targeted and active group send preparations');
  assert.deepEqual([...new Set(cloudGroupPreparations)], ['sending']);

  const bridgeSource = cloudBridgeSource();
  assert.match(bridgeSource, /new CloudGroupOutbox/);
  assert.match(bridgeSource, /clientMessageId,/);
  assert.match(bridgeSource, /persistCloudGroupOutboxDelivery/);
  assert.match(cloudGroupOutboxSource(), /clientMessageId:\s*`\$\{entry\.canonicalMessageId\}:\$\{recipientId\}`/);
});
