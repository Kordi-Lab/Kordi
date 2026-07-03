import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');

test('targeted sends check Cloud group routing before direct Cloud bridge routing', () => {
  const source = chatMessagesSource();
  const sendTargetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  assert.notEqual(sendTargetedStart, -1, 'expected targeted chat send handler');
  const sendTargetedEnd = source.indexOf('return useCallback(async (draftOverride?', sendTargetedStart);
  assert.notEqual(sendTargetedEnd, -1, 'expected end of targeted chat send handler');
  const targetedHandler = source.slice(sendTargetedStart, sendTargetedEnd);

  const directCloudBranch = targetedHandler.indexOf('if (isCloudBridgeConversationId(targetConversation.id))');
  const groupTargets = targetedHandler.indexOf('const groupTargets = isBridgeGroupSession(targetGroupScope)');
  const groupTransportSend = targetedHandler.indexOf("kind: 'group-message'", groupTargets);

  assert.notEqual(directCloudBranch, -1, 'expected direct Cloud bridge branch');
  assert.notEqual(groupTargets, -1, 'expected group target resolution before sending');
  assert.notEqual(groupTransportSend, -1, 'expected Cloud group transport send');
  assert.ok(
    groupTargets < directCloudBranch && groupTransportSend < directCloudBranch,
    'targeted sends must prefer Cloud group transport before direct Cloud bridge sends; otherwise group sessions can be stored as plain direct messages',
  );
});
