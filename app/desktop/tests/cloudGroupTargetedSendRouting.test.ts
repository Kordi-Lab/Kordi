import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const mentionTargetSource = () => readFileSync(new URL('../src/features/chat/messageActions/cloudAgentMentionTarget.ts', import.meta.url), 'utf8');
const cloudDirectMessagingSource = () => readFileSync(new URL('../src/features/cloud/useCloudDirectMessaging.ts', import.meta.url), 'utf8');

test('targeted sends check Cloud group routing before direct Cloud bridge routing', () => {
  const source = chatMessagesSource();
  const sendTargetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  assert.notEqual(sendTargetedStart, -1, 'expected targeted chat send handler');
  const sendTargetedEnd = source.indexOf('const handleSendChatMessage = useCallback(async (', sendTargetedStart);
  assert.notEqual(sendTargetedEnd, -1, 'expected end of targeted chat send handler');
  const targetedHandler = source.slice(sendTargetedStart, sendTargetedEnd);

  const directCloudBranch = targetedHandler.indexOf('if (isCloudCollaborationConversationId(targetCloudConversationId))');
  const groupTargets = targetedHandler.indexOf('const groupTargets = isCollaborationGroupSession(targetGroupScope)');
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
    /prepareCanonicalUserMessage\([\s\S]*?text,\s*attachments,\s*sentAt,\s*'cloud-group-ui'/,
    'targeted group sends must preserve attachments in the canonical optimistic row',
  );
  assert.match(
    targetedHandler,
    /kind:\s*'group-message',[\s\S]*?attachments,/,
    'targeted group sends must pass attachments to the durable group transport',
  );
  assert.match(
    targetedHandler,
    /appendOptimisticCollaborationMessage\([\s\S]*?optimisticMessageId,\s*attachments,/,
    'targeted direct sends must preserve attachment previews while sending',
  );
  assert.match(
    targetedHandler,
    /sendCloudCollaborationMessage\([\s\S]*?attachments,\s*\{ clientMessageId: optimisticMessageId \},/,
    'targeted direct sends must use their optimistic id as the retry-safe client id',
  );
  assert.doesNotMatch(targetedHandler, /attachments:\s*\[\]/);
});

test('direct cloud first sends and retries share the same idempotency key', () => {
  const source = chatMessagesSource();
  assert.match(source, /if \(!claimConversationSend\(collaborationSendInFlightConversationIdsRef\.current, activeCloudConversationId\)\) return;/);
  assert.match(source, /finally \{\s*releaseConversationSend\(collaborationSendInFlightConversationIdsRef\.current, activeCloudConversationId\);/);
  assert.match(
    source,
    /const retryCloudBody = retryDirectHostedAgentTarget[\s\S]*?encodeCloudDirectMessageEnvelope\([\s\S]*?: text;[\s\S]*?sendCloudCollaborationMessage\(\s*activeCloudConversationId,\s*retryCloudBody,\s*retryAttachments,\s*\{\s*clientMessageId: retryMessageId,[\s\S]*?\},/,
    'direct retries must preserve the idempotency key and re-encode hosted-agent routing metadata',
  );
  assert.match(
    source,
    /sendCloudCollaborationMessage\(\s*activeCloudConversationId,\s*cloudBody,\s*attachmentsToSend,\s*\{\s*clientMessageId: optimisticMessageId,[\s\S]*?\},/,
  );

  const directMessagingSource = cloudDirectMessagingSource();
  const start = directMessagingSource.indexOf('const sendMessage = useCallback');
  const end = directMessagingSource.indexOf(
    '\n\n  return {',
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    directMessagingSource.slice(start, end),
    /clientMessageId:\s*options\.clientMessageId/,
    'the stable optimistic id must reach the server transport',
  );
});

test('direct person chats resolve a mention of the local renamed agent', () => {
  const source = chatMessagesSource();
  const targetSource = mentionTargetSource();
  const resolverSource = targetSource.slice(targetSource.indexOf('export async function resolvePreferredAgentMentionTarget'));
  const activeStart = source.indexOf('const handleSendChatMessage = useCallback(async (');
  assert.notEqual(activeStart, -1);
  assert.match(source.slice(activeStart), /resolvePreferredAgentMentionTarget\([\s\S]*activeGroupSessionIsGroup \|\| activeConvCollaborationTarget\?\.runtime === 'person'/);
  assert.ok(resolverSource.indexOf('resolveMentionedLocalAgentTarget') < resolverSource.indexOf('resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh'));
  assert.match(resolverSource, /return localTarget \?\? \(skip \? null : resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh/);
});
