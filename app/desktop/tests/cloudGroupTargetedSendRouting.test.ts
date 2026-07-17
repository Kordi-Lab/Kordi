import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const cloudBridgeSource = () => readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

test('targeted sends check Cloud group routing before direct Cloud bridge routing', () => {
  const source = chatMessagesSource();
  const sendTargetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  assert.notEqual(sendTargetedStart, -1, 'expected targeted chat send handler');
  const sendTargetedEnd = source.indexOf('const handleSendChatMessage = useCallback(async (', sendTargetedStart);
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

  assert.match(
    targetedHandler,
    /prepareCanonicalUserMessage\([\s\S]*?text,\s*chatComposerAttachments,\s*sentAt,\s*'cloud-group-ui'/,
    'targeted group sends must preserve attachments in the canonical optimistic row',
  );
  assert.match(
    targetedHandler,
    /kind:\s*'group-message',[\s\S]*?attachments:\s*chatComposerAttachments,/,
    'targeted group sends must pass attachments to the durable group transport',
  );
  assert.match(
    targetedHandler,
    /appendOptimisticBridgeMessage\([\s\S]*?optimisticMessageId,\s*chatComposerAttachments,/,
    'targeted direct sends must preserve attachment previews while sending',
  );
  assert.match(
    targetedHandler,
    /sendCloudBridgeMessage\([\s\S]*?chatComposerAttachments,\s*\{ clientMessageId: optimisticMessageId \},/,
    'targeted direct sends must use their optimistic id as the retry-safe client id',
  );
  assert.doesNotMatch(targetedHandler, /attachments:\s*\[\]/);
});

test('direct cloud first sends and retries share the same idempotency key', () => {
  const source = chatMessagesSource();
  assert.match(
    source,
    /sendCloudBridgeMessage\(\s*activeConvId,\s*text,\s*retryAttachments,\s*\{ clientMessageId: retryMessageId \},/,
  );
  assert.match(
    source,
    /sendCloudBridgeMessage\(\s*activeConvId,\s*cloudBody,\s*chatComposerAttachments,\s*\{ clientMessageId: optimisticMessageId \},/,
  );

  const bridgeSource = cloudBridgeSource();
  const start = bridgeSource.indexOf('const sendCloudBridgeMessage = useCallback');
  const end = bridgeSource.indexOf('\n\n  const sendCloudGroupControl', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    bridgeSource.slice(start, end),
    /clientMessageId:\s*options\.clientMessageId/,
    'the stable optimistic id must reach the server transport',
  );
});
